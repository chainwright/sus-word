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
const HELP_MESSAGE = "🕵️ Type !join to play. When voting opens, vote with a player number: 2, #2, !2, or !vote 2.";
const CHAT_SEEN_WINDOW = 15 * 60 * 1_000;

export function containsUrl(value) {
  return /(?:https?:\/\/|www\.)\S+/i.test(String(value ?? ""));
}

export function splitChatMessage(value, limit = 500) {
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const messages = [];
  let current = "";
  for (const word of words) {
    if (word.length > limit) {
      if (current) messages.push(current);
      for (let index = 0; index < word.length; index += limit) messages.push(word.slice(index, index + limit));
      current = "";
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= limit) current = next;
    else {
      if (current) messages.push(current);
      current = word;
    }
  }
  if (current) messages.push(current);
  return messages;
}

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
  const chatSeenAt = new Map();
  const aliasReplies = new Set();
  const joinReplies = new Set();
  const joinReplyPending = new Set();
  const pendingCaseFiles = new Set();
  let lobbyAnnouncementHasLink = false;
  let lobbyAnnouncementSequence = 0;
  const serverNow = options.now ?? (() => Date.now());
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;

  function clearCaseFiles() {
    for (const pending of pendingCaseFiles) cancelTimeout(pending.timer);
    pendingCaseFiles.clear();
  }

  function flushCaseFiles() {
    for (const pending of [...pendingCaseFiles]) {
      cancelTimeout(pending.timer);
      pending.send();
    }
  }

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

  app.post("/api/card/check", (request, response) => {
    const login = String(request.body?.login ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) {
      response.status(400).json({ ok: false, reason: "invalid_login" });
      return;
    }
    response.json({ ok: true, ...checkChatName(login) });
  });

  app.post("/api/card/start", (request, response) => {
    const sid = sessionId(request, response);
    const login = String(request.body?.login ?? "").trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,25}$/.test(login)) {
      response.status(400).json({ ok: false, reason: "invalid_login" });
      return;
    }
    const nameCheck = checkChatName(login);
    const result = game.createClaim({ sessionId: sid, login });
    response.status(result.ok ? 200 : 400).json({ ...result, seenInChat: nameCheck.seen, nameCheck });
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
    if (to === PHASES.IDLE) {
      aliasReplies.clear();
      joinReplies.clear();
      joinReplyPending.clear();
      lobbyAnnouncementHasLink = false;
      lobbyAnnouncementSequence += 1;
      clearCaseFiles();
    }
    if (to === PHASES.LOBBY) {
      flushCaseFiles();
      lobbyAnnouncementHasLink = false;
      lobbyAnnouncementSequence += 1;
      const sequence = lobbyAnnouncementSequence;
      announce(`🕵️ Sus Word! Type !join to play. Get your secret card: ${publicUrl}/card`)
        .then((sent) => {
          if (sequence === lobbyAnnouncementSequence && game.phase === PHASES.LOBBY) {
            lobbyAnnouncementHasLink = sent;
          }
        });
    }
  });
  game.on("round", ({ roundNumber }) => {
    waitlistAnnouncementRound = null;
    announce(`🔔 ROUND ${roundNumber} · NEW ROLES! Check your card 👉 ${publicUrl}/card`);
    announceRoleMentions();
  });
  game.on("hint", ({ kind, value }) => {
    announce(kind === "category"
      ? `🕵️ HINT: the word is about ${String(value).toUpperCase()}`
      : `🕵️ HINT: it starts with ${String(value).toUpperCase()}`);
  });
  game.on("voteStart", ({ duration }) => {
    const table = game.tables.get(game.featuredTableId);
    const choices = [...(table?.roster.values() ?? [])]
      .sort((left, right) => left.number - right.number)
      .map((player) => `${player.number} ${player.login}`)
      .join(" · ");
    const seconds = Math.round(duration / 1_000);
    announce(`🗳️🗳️ VOTE NOW: ${seconds} SECONDS 🗳️🗳️ Type a number: ${choices}`);
  });
  game.on("voteWarning", () => announce("⏳ 10 seconds left to vote"));
  game.on("busted", (event) => queueBusted(event));
  game.on("player", ({ waitingForNextRound }) => {
    if (!waitingForNextRound || waitlistAnnouncementRound === game.roundNumber) return;
    waitlistAnnouncementRound = game.roundNumber;
    announce("🕵️ New players are waiting for the next round.");
  });
  game.on("reveal", ({ caseFileMessage, otherTablesMessage, caseFileDelayMs }) => {
    flushBusted();
    const pending = {
      timer: null,
      sent: false,
      send() {
        if (pending.sent) return;
        pending.sent = true;
        pendingCaseFiles.delete(pending);
        announce(caseFileMessage);
        announce(otherTablesMessage);
      },
    };
    pending.timer = scheduleTimeout(pending.send, Math.max(0, Number(caseFileDelayMs) || 0));
    if (!pending.sent) {
      pending.timer?.unref?.();
      pendingCaseFiles.add(pending);
    }
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

  function now() {
    return Number(typeof serverNow === "function" ? serverNow() : serverNow);
  }

  function checkChatName(value) {
    const login = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
    const seenAt = chatSeenAt.get(login);
    const seen = Number.isFinite(seenAt) && now() - seenAt <= CHAT_SEEN_WINDOW;
    return {
      login,
      seen,
      lastSeenAt: seen ? seenAt : null,
      message: seen
        ? `✓ @${login} is in chat`
        : `We haven't seen @${login} in chat yet. Type anything in chat first, or check the spelling`,
    };
  }

  function announceRoleMentions() {
    const players = [...game.tables.values()]
      .flatMap((table) => [...table.roster.values()])
      .sort((left, right) => left.number - right.number);
    const suffix = "your role is on your card";
    let mentions = "";
    for (const player of players) {
      const mention = `@${player.login}`;
      const next = mentions ? `${mentions} ${mention}` : mention;
      if (`${next} ${suffix}`.length > 500) {
        announce(`${mentions} ${suffix}`);
        mentions = mention;
      } else {
        mentions = next;
      }
    }
    if (mentions) announce(`${mentions} ${suffix}`);
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
      const command = parseCommand(raw);
      if (command?.type === "vote") {
        const target = command.number ? { number: command.number } : command.target;
        const result = game.vote(actor, target);
        if (result.ok) cardMessageTimes.set(card.player.id, now);
        return { ...result, voteMessage: true, visible: false };
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
      const target = Number.isInteger(payload.number) ? { number: payload.number } : payload.target;
      return { ...game.vote(actor, target), voteMessage: true, visible: false };
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

  async function announce(message, options = {}) {
    if (!message) return false;
    const sends = [];
    for (const part of splitChatMessage(message)) {
      if (!twitch) {
        logger.log?.(`[offline] ${part}`);
        sends.push(Promise.resolve(true));
        continue;
      }
      sends.push(twitch.sendChat(part, options)
        .then((result) => result?.dropped !== true)
        .catch((error) => {
          logger.error?.(`[chat] ${error.message}`);
          return false;
        }));
    }
    const results = await Promise.all(sends);
    return results.length > 0 && results.every(Boolean);
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
    const login = String(message.login ?? "").trim().replace(/^@/, "").toLowerCase();
    const text = String(message.text ?? "");
    const joinedPlayer = game.players.get(String(message.userId ?? ""))
      ?? [...game.players.values()].find((player) => player.login === login);
    if (!joinedPlayer && containsUrl(text)) {
      return { ok: true, ignored: true, reason: "link_spam" };
    }
    if (login) chatSeenAt.set(login, now());

    const command = parseCommand(text);
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

    if (command.type === "joinAlias") {
      const key = String(message.userId ?? login);
      const shouldReply = !aliasReplies.has(key);
      if (shouldReply) {
        aliasReplies.add(key);
        announce(`@${login} almost! Type !join (with the !)`, { priority: "low" });
      }
      return { ok: true, ignored: true, action: "join_alias", replied: shouldReply };
    }
    if (command.type === "join") {
      const player = await playerDetails(message);
      const result = game.join({
        id: player.userId,
        login: player.login,
        displayName: player.displayName,
        avatar: player.avatar,
      });
      const key = String(message.userId ?? login);
      const shouldReply = !joinReplies.has(key) && !joinReplyPending.has(key);
      let replied = false;
      if (shouldReply) {
        joinReplyPending.add(key);
        const sent = await announce(`@${login} get your secret card: ${publicUrl}/card`, { priority: "low" });
        joinReplyPending.delete(key);
        if (sent) {
          joinReplies.add(key);
          replied = true;
        }
      }
      return { ...result, replied };
    }
    if (command.type === "claim") {
      const player = await playerDetails(message);
      const result = game.claim({
        code: command.code,
        userId: player.userId,
        login: player.login,
        displayName: player.displayName,
        avatar: player.avatar,
      });
      if (!result.ok && result.message) announce(result.message);
      if (result.ok) announce(
        `@${login} you're in! Keep your card open; your role appears when the round starts.`,
        lobbyAnnouncementHasLink ? { priority: "low" } : {},
      );
      return result;
    }
    if (command.type === "leave") return game.leave(message.userId);
    if (command.type === "vote") {
      const target = command.number ? { number: command.number } : command.target;
      const result = game.vote({
        userId: message.userId,
        login: message.login,
        displayName: message.displayName,
        transport: "twitch",
      }, target);
      if (result.ok && result.early && result.shouldReply) {
        announce(`@${login} voting opens when the timer ends. Your number guess is saved: ${result.targetNumber}`, { priority: "low" });
      } else if (!result.ok && joinedPlayer && game.playerTables.has(joinedPlayer.id)) {
        announceVoteRejection(login, result, command.number);
      }
      return { ...result, voteMessage: true, visible: false };
    }
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

  function announceVoteRejection(login, result, number) {
    switch (result.reason) {
      case "unknown_target":
        announce(number
          ? `@${login} there is no player ${number} at your table.`
          : `@${login} that player isn't at your table.`, { priority: "low" });
        break;
      case "self_vote": announce(`@${login} you can't vote for yourself.`, { priority: "low" }); break;
      case "not_seated":
      case "not_a_player": announce(`@${login} you're not seated this round.`, { priority: "low" }); break;
      case "invalid_state":
      case "vote_closed": announce(`@${login} voting is closed.`, { priority: "low" }); break;
      default: announce(`@${login} that vote couldn't be counted.`, { priority: "low" });
    }
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
    clearCaseFiles();
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
    checkChatName,
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
