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
const HELP_MESSAGE = "🕵️ Join with !join, accuse with !accuse name word, then vote with !vote name.";

export function stripUrls(value) {
  return String(value ?? "")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
  let bustedTimer = null;
  let bustedBatch = [];
  let waitlistAnnouncementRound = null;
  const cardMessageTimes = new Map();
  const serverNow = options.now ?? (() => Date.now());

  if (env.CHANNEL_LOGIN) game.configureStreamer?.(env.CHANNEL_LOGIN);

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

  app.post("/api/host/feature/:tableId", (request, response) => {
    const result = game.featureTable(request.params.tableId);
    response.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/api/host/host-plays", (request, response) => {
    const result = game.setHostPlays(request.body?.enabled !== false);
    response.json(result);
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
  game.on("round", ({ roundNumber, duration, tableCount, final }) => {
    waitlistAnnouncementRound = null;
    const label = final ? "Final round" : `Round ${roundNumber}`;
    announce(`🕵️ ${label} has begun. ${tableCount} ${tableCount === 1 ? "table" : "tables"} · check your card for your table. ${formatRoundLength(duration)}.`);
  });
  game.on("hint", ({ message }) => announce(`🕵️ ${message}`));
  game.on("voteStart", () => announce("🕵️ Vote! !vote name"));
  game.on("busted", (event) => queueBusted(event));
  game.on("player", ({ waitingForNextRound }) => {
    if (!waitingForNextRound || waitlistAnnouncementRound === game.roundNumber) return;
    waitlistAnnouncementRound = game.roundNumber;
    announce("🕵️ New players are waiting for the next round.");
  });
  game.on("reveal", ({ botMessage, otherTablesMessage }) => {
    flushBusted();
    announce(botMessage);
    announce(otherTablesMessage);
  });

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
      twitchConnected: Boolean(twitch?.connected),
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
      transport: "voice",
    });
  }

  function receiveBrowserMessage(client, data) {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (client.view === "host" && payload?.type === "voice") {
      sendJson(client.socket, {
        type: "voiceResult",
        data: handleVoiceChunk(payload.text, client.isLocal),
      });
      return;
    }
    if (client.view === "card") {
      const result = handleCardAction(client.sessionId, payload);
      sendJson(client.socket, {
        type: "actionResult",
        action: payload?.type,
        data: result,
      });
    }
  }

  function handleCardAction(sid, payload) {
    const card = game.getCard(sid);
    if (!card.linked || !card.player) return { ok: false, reason: "card_not_linked" };
    const actor = { userId: card.player.id, transport: "card" };
    if (payload?.type === "tableChat") {
      const raw = String(payload.text ?? "").trim();
      if (!raw || raw.length > 200) return { ok: false, reason: "invalid_message" };
      if (card.onStream) return { ok: false, reason: "featured_table_locked" };
      const now = Number(typeof serverNow === "function" ? serverNow() : serverNow);
      const lastAt = cardMessageTimes.get(card.player.id) ?? -Infinity;
      if (now - lastAt < 2_000) {
        return { ok: false, reason: "rate_limited", retryAfterMs: 2_000 - (now - lastAt) };
      }
      const accusation = /^\/accuse\s+@?([a-z0-9_]{1,25})\s+([a-z][a-z’']{1,19})$/i.exec(raw);
      if (accusation) {
        const result = game.accuse(actor, accusation[1], accusation[2]);
        if (result.ok) cardMessageTimes.set(card.player.id, now);
        return result;
      }
      const text = stripUrls(raw);
      if (!text) return { ok: false, reason: "invalid_message" };
      const result = game.recordMessage({
        ...actor,
        messageId: `card:${card.player.id}:${now}`,
        text,
        source: "chat",
      });
      if (result.ok) cardMessageTimes.set(card.player.id, now);
      return result;
    }
    if (payload?.type === "accuse") {
      return game.accuse(actor, payload.target, payload.word);
    }
    if (payload?.type === "vote") {
      return game.vote(actor, payload.target);
    }
    return { ok: false, reason: "unknown_action" };
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

  function queueBusted({ accuser, impostor, word }) {
    bustedBatch.push(`@${accuser.login} caught @${impostor.login} (${word.toUpperCase()})`);
    if (bustedTimer) return;
    bustedTimer = setTimeout(flushBusted, 10_000);
    bustedTimer.unref?.();
  }

  function flushBusted() {
    if (bustedTimer) clearTimeout(bustedTimer);
    bustedTimer = null;
    if (!bustedBatch.length) return;
    const entries = bustedBatch;
    bustedBatch = [];
    let body = "";
    let included = 0;
    for (const entry of entries) {
      const next = body ? `${body}, ${entry}` : entry;
      if (next.length > 420) break;
      body = next;
      included += 1;
    }
    const remainder = entries.length - included;
    announce(`🚨 Busted: ${body}${remainder ? `, +${remainder} more` : ""}`);
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
    const normalized = String(action).toLowerCase();
    if (normalized.startsWith("feature/")) {
      return game.featureTable(normalized.slice("feature/".length));
    }
    switch (normalized) {
      case "start": return game.start();
      case "go": {
        const category = await roundCategory();
        return game.go(category ? { category } : undefined);
      }
      case "final": {
        const category = await roundCategory();
        return game.final(category ? { category } : undefined);
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
        login: message.login,
        displayName: message.displayName,
        messageId: message.id,
        text: message.text,
        transport: "twitch",
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
    if (command.type === "vote") return game.vote({
      userId: message.userId,
      login: message.login,
      displayName: message.displayName,
      transport: "twitch",
    }, command.target);
    if (command.type === "accuse") return game.accuse({
      userId: message.userId,
      login: message.login,
      displayName: message.displayName,
      transport: "twitch",
    }, command.target, command.word);
    if (command.type === "sus") {
      if (command.action === "help") {
        announce(HELP_MESSAGE);
        return { ok: true, action: "help" };
      }
      if (command.requiresControl && !canControl(message)) {
        return { ok: false, reason: "not_authorized" };
      }
      if (command.action === "mute") return game.mute(command.target);
      return runHostAction(command.action);
    }
    return { ok: false, reason: "unknown_command" };
  }

  function attachTwitch(nextTwitch) {
    twitch = nextTwitch;
    twitch.on("message", (message) => {
      handleChatMessage(message).catch((error) => logger.error?.(`[command] ${error.message}`));
    });
    twitch.on("connected", broadcastPublicState);
    twitch.on("disconnected", broadcastPublicState);
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
    if (bustedTimer) clearTimeout(bustedTimer);
    bustedTimer = null;
    bustedBatch = [];
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
    handleCardAction,
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
