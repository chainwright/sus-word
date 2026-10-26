import "dotenv/config";

import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { canControl, parseCommand } from "./commands.js";
import Game, { PHASES } from "./game.js";
import TwitchClient from "./twitch.js";

export const SESSION_COOKIE = "sus_sid";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const HELP_MESSAGE = "🕵️ Join with !join, watch chat for a hidden word, then vote with !vote name.";

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    return name ? [[name, value]] : [];
  }));
}

function existingSessionId(request) {
  const sid = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  return /^[A-Za-z0-9_-]{24,64}$/.test(sid ?? "") ? sid : null;
}

function sessionId(request, response) {
  const existing = existingSessionId(request);
  if (existing) return existing;
  const sid = randomBytes(24).toString("base64url");
  response.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1_000,
    path: "/",
  });
  return sid;
}

function cleanPublicUrl(value) {
  return String(value || "http://localhost:3000").replace(/\/+$/, "");
}

export function isLoopbackAddress(value) {
  const address = String(value ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return address === "::1"
    || address === "localhost"
    || address.startsWith("::ffff:127.")
    || /^127(?:\.\d{1,3}){3}$/.test(address);
}

export function isLocalHostOrigin(value) {
  try {
    const { hostname } = new URL(String(value));
    return hostname === "localhost" || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

function formatRoundLength(duration) {
  const seconds = Math.round(duration / 1_000);
  if (seconds % 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function createSusWordServer(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const game = options.game ?? new Game();
  const app = express();
  const server = createHttpServer(app);
  const browserSockets = new WebSocketServer({ noServer: true });
  const clients = new Set();
  const publicUrl = cleanPublicUrl(env.PUBLIC_URL);
  const configuredPort = Number(options.port ?? env.PORT ?? 3000);
  let twitch = options.twitch ?? null;
  let started = false;
  let voiceSequence = 0;

  app.use(express.json({ limit: "16kb" }));

  app.get("/", (_request, response) => response.redirect("/overlay"));
  app.get("/overlay", (_request, response) => {
    response.sendFile(resolve(PUBLIC_DIR, "overlay.html"));
  });
  app.get("/host", (_request, response) => {
    response.sendFile(resolve(PUBLIC_DIR, "host.html"));
  });
  app.get("/card", (request, response) => {
    sessionId(request, response);
    response.sendFile(resolve(PUBLIC_DIR, "card.html"));
  });
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/card", (request, response) => {
    const sid = sessionId(request, response);
    response.json(cardState(sid));
  });

  app.post("/api/card/start", (request, response) => {
    const sid = sessionId(request, response);
    const login = String(request.body?.login ?? "").trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,25}$/.test(login)) {
      response.status(400).json({ ok: false, reason: "invalid_login" });
      return;
    }
    const result = game.createClaim({ sessionId: sid, login });
    response.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/host/:action", async (request, response, next) => {
    try {
      const result = await runHostAction(request.params.action);
      response.status(result.ok ? 200 : 409).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    logger.error?.(error);
    response.status(500).json({ ok: false, reason: "server_error" });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    const view = url.searchParams.get("view");
    if (url.pathname !== "/ws" || !["overlay", "card", "host"].includes(view)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const sid = view === "card" ? existingSessionId(request) : null;
    if (view === "card" && !sid) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    browserSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const client = {
        socket: webSocket,
        view,
        sessionId: sid,
        isLocal: isLoopbackAddress(request.socket.remoteAddress)
          && isLocalHostOrigin(request.headers.origin),
      };
      clients.add(client);
      webSocket.on("close", () => clients.delete(client));
      webSocket.on("error", (error) => logger.error?.(`[browser-ws] ${error.message}`));
      webSocket.on("message", (data) => receiveBrowserMessage(client, data));
      sendClientState(client);
    });
  });

  game.on("event", () => {
    broadcastPublicState();
    broadcastCardStates();
  });
  game.on("card", ({ sessionId: sid }) => broadcastCardStates(sid));
  game.on("state", ({ to }) => {
    if (to === PHASES.LOBBY) {
      announce(`🕵️ Sus Word! Type !join to play. Get your secret card: ${publicUrl}/card`);
    }
  });
  game.on("round", ({ roundNumber, duration }) => {
    announce(`🕵️ Round ${roundNumber} has begun. Someone here has a secret word… ${formatRoundLength(duration)}.`);
  });
  game.on("hint", ({ message }) => announce(`🕵️ ${message}`));
  game.on("voteStart", () => announce("🕵️ Vote! !vote name"));
  game.on("reveal", ({ botMessage }) => announce(botMessage));

  function sendJson(socket, payload) {
    if (socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  function sendClientState(client) {
    if (client.view === "card") {
      sendJson(client.socket, { type: "card", data: cardState(client.sessionId) });
    } else {
      sendJson(client.socket, { type: "state", data: publicState() });
    }
  }

  function publicState() {
    return {
      ...game.getPublicState(),
      cardUrl: `${publicUrl}/card`,
      channelLogin: String(env.CHANNEL_LOGIN ?? "").trim().replace(/^@/, "").toLowerCase(),
    };
  }

  function handleVoiceChunk(text, isLocal = false) {
    if (!isLocal) return { ok: false, reason: "voice_not_local" };
    const channelLogin = String(env.CHANNEL_LOGIN ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!channelLogin) return { ok: false, reason: "channel_login_missing" };
    const transcript = String(text ?? "").trim();
    if (!transcript || transcript.length > 1_000) {
      return { ok: false, reason: "invalid_voice" };
    }
    voiceSequence += 1;
    return game.recordMessage({
      userId: channelLogin,
      messageId: `voice:${Date.now()}:${voiceSequence}`,
      text: transcript,
      source: "voice",
    });
  }

  function receiveBrowserMessage(client, data) {
    if (client.view !== "host") return;
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (payload?.type !== "voice") return;
    sendJson(client.socket, {
      type: "voiceResult",
      data: handleVoiceChunk(payload.text, client.isLocal),
    });
  }

  function cardState(sid) {
    const card = game.getCard(sid);
    const pendingClaim = card.linked ? null : game.getPendingClaim(sid);
    return pendingClaim ? { ...card, pendingClaim } : card;
  }

  function broadcastPublicState() {
    const payload = { type: "state", data: publicState() };
    for (const client of clients) {
      if (client.view !== "card") sendJson(client.socket, payload);
    }
  }

  function broadcastCardStates(onlySessionId = null) {
    for (const client of clients) {
      if (
        client.view === "card"
        && (!onlySessionId || client.sessionId === onlySessionId)
      ) {
        sendJson(client.socket, {
          type: "card",
          data: cardState(client.sessionId),
        });
      }
    }
  }

  function announce(message) {
    if (!message) return;
    if (!twitch) {
      logger.log?.(`[offline] ${message}`);
      return;
    }
    twitch.sendChat(message).catch((error) => logger.error?.(`[chat] ${error.message}`));
  }

  async function roundCategory() {
    if (!twitch) return null;
    try {
      const channel = await twitch.getChannelInfo();
      return channel?.game_name || null;
    } catch (error) {
      logger.error?.(`[channel] ${error.message}`);
      return null;
    }
  }

  async function runHostAction(action) {
    switch (String(action).toLowerCase()) {
      case "start": return game.start();
      case "go": {
        const category = await roundCategory();
        return game.go(category ? { category } : undefined);
      }
      case "vote": return game.beginVote();
      case "next": return game.nextRound();
      case "end": return game.end();
      case "reset": return game.reset();
      default: return { ok: false, reason: "unknown_action" };
    }
  }

  async function playerDetails(message) {
    if (!twitch) return { ...message, avatar: "" };
    try {
      const [user] = await twitch.getUsersByLogin([message.login]);
      return { ...message, avatar: user?.profile_image_url ?? "" };
    } catch (error) {
      logger.error?.(`[users] ${error.message}`);
      return { ...message, avatar: "" };
    }
  }

  async function handleChatMessage(message) {
    const command = parseCommand(message.text);
    if (!command) {
      return game.recordMessage({
        userId: message.userId,
        messageId: message.id,
        text: message.text,
      });
    }

    if (command.type === "join") {
      const player = await playerDetails(message);
      return game.join({
        id: player.userId,
        login: player.login,
        displayName: player.displayName,
        avatar: player.avatar,
      });
    }
    if (command.type === "claim") {
      const player = await playerDetails(message);
      return game.claim({
        code: command.code,
        userId: player.userId,
        login: player.login,
        displayName: player.displayName,
        avatar: player.avatar,
      });
    }
    if (command.type === "leave") return game.leave(message.userId);
    if (command.type === "vote") return game.vote(message.userId, command.target);
    if (command.type === "sus") {
      if (command.action === "help") {
        announce(HELP_MESSAGE);
        return { ok: true, action: "help" };
      }
      if (command.requiresControl && !canControl(message)) {
        return { ok: false, reason: "not_authorized" };
      }
      return runHostAction(command.action);
    }
    return { ok: false, reason: "unknown_command" };
  }

  function attachTwitch(nextTwitch) {
    twitch = nextTwitch;
    twitch.on("message", (message) => {
      handleChatMessage(message).catch((error) => logger.error?.(`[command] ${error.message}`));
    });
    twitch.on("twitchError", (error) => logger.error?.(`[eventsub] ${error.message}`));
  }

  async function start() {
    if (started) return server.address();
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(configuredPort, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    started = true;

    const hasTwitchConfig = Boolean(
      env.TWITCH_CLIENT_ID
      && env.TWITCH_CLIENT_SECRET
      && env.BOT_LOGIN
      && env.CHANNEL_LOGIN,
    );
    if (!twitch && hasTwitchConfig) {
      attachTwitch(new TwitchClient({
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET,
        botLogin: env.BOT_LOGIN,
        channelLogin: env.CHANNEL_LOGIN,
        logger,
      }));
    } else if (twitch) {
      attachTwitch(twitch);
    }

    if (twitch) {
      try {
        await twitch.start();
        logger.log?.(`Twitch connected as ${twitch.bot.login} in ${twitch.broadcaster.login}`);
      } catch (error) {
        logger.error?.(`Twitch unavailable; continuing offline: ${error.message}`);
        twitch.stop?.();
        twitch = null;
      }
    } else {
      logger.log?.("Twitch credentials missing; running in offline mode");
    }

    const address = server.address();
    logger.log?.(`Sus Word listening on http://localhost:${address.port}`);
    return address;
  }

  async function stop() {
    twitch?.stop?.();
    for (const client of clients) client.socket.close();
    await new Promise((resolveClose) => {
      if (!started) return resolveClose();
      server.close(() => resolveClose());
    });
    started = false;
  }

  return {
    app,
    server,
    browserSockets,
    game,
    get twitch() { return twitch; },
    handleChatMessage,
    handleVoiceChunk,
    runHostAction,
    start,
    stop,
  };
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const service = createSusWordServer();
  service.start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
