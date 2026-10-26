import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { loadTokens, refresh } from "./auth.js";

const API_BASE = "https://api.twitch.tv/helix/";
const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const CHAT_INTERVAL = 1_500;

const SYSTEM_CLOCK = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function isGameAnnouncement(text) {
  const message = String(text ?? "").trim();
  return message.startsWith("🕵️") || [
    /^Sus Word! Type !join/i,
    /^Round \d+ has begun\./i,
    /^Category:/i,
    /^Starts with:/i,
    /^Vote! !vote name/i,
    /^It was @/i,
  ].some((pattern) => pattern.test(message));
}

export function normalizeChatEvent(event, botUserId) {
  const text = String(event?.message?.text ?? "");
  if (String(event?.chatter_user_id) === String(botUserId) && isGameAnnouncement(text)) {
    return null;
  }
  const badges = event?.badges ?? [];
  const badgeIds = new Set(badges.map((badge) => badge.set_id));
  return {
    id: String(event?.message_id ?? ""),
    userId: String(event?.chatter_user_id ?? ""),
    login: String(event?.chatter_user_login ?? "").toLowerCase(),
    displayName: String(event?.chatter_user_name ?? event?.chatter_user_login ?? ""),
    text,
    isBroadcaster: String(event?.chatter_user_id) === String(event?.broadcaster_user_id)
      || badgeIds.has("broadcaster"),
    isModerator: badgeIds.has("moderator") || badgeIds.has("broadcaster"),
  };
}

async function parseResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    const error = new Error(body.message ?? `Twitch API returned ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export class TwitchClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clientId = options.clientId ?? process.env.TWITCH_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? process.env.TWITCH_CLIENT_SECRET;
    this.botLogin = String(options.botLogin ?? process.env.BOT_LOGIN ?? "").toLowerCase();
    this.channelLogin = String(
      options.channelLogin ?? process.env.CHANNEL_LOGIN ?? "",
    ).toLowerCase();
    this.fetch = options.fetchImpl ?? fetch;
    this.WebSocket = options.WebSocketImpl ?? WebSocket;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = options.logger ?? console;
    this.tokenPath = options.tokenPath;
    this.loadTokenFile = options.loadTokens ?? loadTokens;
    this.refreshToken = options.refreshTokens ?? refresh;
    this.apiBase = options.apiBase ?? API_BASE;
    this.eventSubUrl = options.eventSubUrl ?? EVENTSUB_URL;

    this.tokens = options.tokens ?? null;
    this.bot = null;
    this.broadcaster = null;
    this.userCache = new Map();
    this.socket = null;
    this.handoffSocket = null;
    this.expectedCloses = new WeakSet();
    this.watchdogTimer = null;
    this.reconnectTimer = null;
    this.keepaliveMs = 15_000;
    this.backoffAttempt = 0;
    this.seenMessageIds = new Set();
    this.refreshPromise = null;
    this.chatTail = Promise.resolve();
    this.lastChatAt = -Infinity;
    this.stopped = true;
    this.connected = false;
  }

  async start() {
    if (!this.clientId || !this.clientSecret || !this.botLogin || !this.channelLogin) {
      throw new Error("Twitch credentials, BOT_LOGIN, and CHANNEL_LOGIN are required");
    }
    this.tokens ??= await this.loadTokenFile({ tokenPath: this.tokenPath });
    const [bot, broadcaster] = await this.getUsersByLogin([
      this.botLogin,
      this.channelLogin,
    ]);
    if (!bot) throw new Error(`Twitch bot login not found: ${this.botLogin}`);
    if (!broadcaster) throw new Error(`Twitch channel login not found: ${this.channelLogin}`);
    this.bot = bot;
    this.broadcaster = broadcaster;
    this.stopped = false;
    this.connectEventSub();
    return { bot, broadcaster };
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    if (this.watchdogTimer) this.clock.clearTimeout(this.watchdogTimer);
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.watchdogTimer = null;
    this.reconnectTimer = null;
    for (const socket of [this.socket, this.handoffSocket]) {
      if (!socket) continue;
      this.expectedCloses.add(socket);
      socket.close();
    }
    this.socket = null;
    this.handoffSocket = null;
  }

  async getUsersByLogin(logins) {
    const requested = logins.map((login) => String(login).toLowerCase());
    const missing = [...new Set(requested.filter((login) => !this.userCache.has(login)))];
    if (missing.length) {
      const query = new URLSearchParams();
      for (const login of missing) query.append("login", login);
      const response = await this.request(`users?${query}`);
      for (const user of response.data ?? []) {
        this.userCache.set(user.login.toLowerCase(), user);
      }
      for (const login of missing) {
        if (!this.userCache.has(login)) this.userCache.set(login, null);
      }
    }
    return requested.map((login) => this.userCache.get(login));
  }

  async getChannelInfo(broadcasterId = this.broadcaster?.id) {
    if (!broadcasterId) throw new Error("Broadcaster ID is not available");
    const response = await this.request(
      `channels?${new URLSearchParams({ broadcaster_id: broadcasterId })}`,
    );
    return response.data?.[0] ?? null;
  }

  sendChat(message) {
    const text = String(message ?? "").trim().slice(0, 500);
    if (!text) return Promise.reject(new Error("Cannot send an empty chat message"));
    const task = this.chatTail.catch(() => {}).then(async () => {
      if (!this.bot?.id || !this.broadcaster?.id) {
        throw new Error("Twitch client has not started");
      }
      const wait = Math.max(0, this.lastChatAt + CHAT_INTERVAL - this.clock.now());
      if (wait) {
        await new Promise((resolveWait) => this.clock.setTimeout(resolveWait, wait));
      }
      this.lastChatAt = this.clock.now();
      return this.request("chat/messages", {
        method: "POST",
        body: {
          broadcaster_id: this.broadcaster.id,
          sender_id: this.bot.id,
          message: text,
        },
      });
    });
    this.chatTail = task;
    return task;
  }

  async request(path, options = {}, retry = true) {
    if (!this.tokens?.access_token) {
      this.tokens = await this.loadTokenFile({ tokenPath: this.tokenPath });
    }
    const response = await this.fetch(new URL(path, this.apiBase), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.tokens.access_token}`,
        "Client-Id": this.clientId,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (response.status === 401 && retry) {
      await this.#refresh();
      return this.request(path, options, false);
    }
    return parseResponse(response);
  }

  connectEventSub(url = this.eventSubUrl) {
    if (this.stopped) return null;
    return this.#openSocket(url, { handoff: false, oldSocket: null });
  }

  async #refresh() {
    this.refreshPromise ??= this.refreshToken({
      tokens: this.tokens,
      tokenPath: this.tokenPath,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      fetchImpl: this.fetch,
    }).finally(() => {
      this.refreshPromise = null;
    });
    this.tokens = await this.refreshPromise;
  }

  #openSocket(url, context) {
    const socket = new this.WebSocket(url);
    if (context.handoff) this.handoffSocket = socket;
    else this.socket = socket;

    socket.on("message", (data) => this.#handleFrame(socket, data, context));
    socket.on("close", () => this.#handleClose(socket, context));
    socket.on("error", (error) => this.#report(error));
    return socket;
  }

  #handleFrame(socket, data, context) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      this.#report(new Error("Received invalid EventSub JSON"));
      return;
    }

    const type = frame.metadata?.message_type;
    if (type === "session_welcome") {
      const session = frame.payload.session;
      this.backoffAttempt = 0;
      this.keepaliveMs = Math.max(1, session.keepalive_timeout_seconds ?? 10) * 1_000;
      if (context.handoff) {
        this.socket = socket;
        this.handoffSocket = null;
        if (context.oldSocket) {
          this.expectedCloses.add(context.oldSocket);
          context.oldSocket.close();
        }
      } else {
        this.#subscribe(session.id).catch((error) => {
          this.#report(error);
          socket.close();
        });
      }
      this.#touchWatchdog();
      this.connected = true;
      this.emit("connected", { sessionId: session.id, reconnected: context.handoff });
      return;
    }

    if (type === "session_keepalive") {
      this.#touchWatchdog();
      return;
    }

    if (type === "session_reconnect") {
      const reconnectUrl = frame.payload.session.reconnect_url;
      if (reconnectUrl && !this.handoffSocket) {
        this.#touchWatchdog();
        this.#openSocket(reconnectUrl, { handoff: true, oldSocket: socket });
      }
      return;
    }

    if (type === "notification") {
      this.#touchWatchdog();
      const messageId = frame.metadata?.message_id;
      if (messageId && this.seenMessageIds.has(messageId)) return;
      if (messageId) {
        this.seenMessageIds.add(messageId);
        if (this.seenMessageIds.size > 1_000) {
          this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
        }
      }
      if (frame.payload.subscription?.type === "channel.chat.message") {
        const message = normalizeChatEvent(frame.payload.event, this.bot?.id);
        if (message) this.emit("message", message);
      }
      return;
    }

    if (type === "revocation") {
      this.#report(new Error(
        `EventSub subscription revoked: ${frame.payload.subscription?.status ?? "unknown"}`,
      ));
    }
  }

  #handleClose(socket, context) {
    if (this.expectedCloses.has(socket) || this.stopped) return;
    if (socket === this.socket) {
      this.connected = false;
      this.emit("disconnected");
    }
    if (context.handoff) {
      this.handoffSocket = null;
      if (context.oldSocket) {
        this.expectedCloses.add(context.oldSocket);
        context.oldSocket.close();
        if (this.socket === context.oldSocket) this.socket = null;
      }
    }
    if (socket === this.socket) this.socket = null;
    this.#scheduleReconnect();
  }

  async #subscribe(sessionId) {
    await this.request("eventsub/subscriptions", {
      method: "POST",
      body: {
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: this.broadcaster.id,
          user_id: this.bot.id,
        },
        transport: { method: "websocket", session_id: sessionId },
      },
    });
    this.emit("subscribed", { sessionId });
  }

  #touchWatchdog() {
    if (this.watchdogTimer) this.clock.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = this.clock.setTimeout(() => {
      this.watchdogTimer = null;
      const socket = this.socket;
      if (!socket || this.stopped) return;
      if (typeof socket.terminate === "function") socket.terminate();
      else socket.close();
    }, this.keepaliveMs + 1_000);
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    if (this.watchdogTimer) this.clock.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
    const delay = Math.min(30_000, 1_000 * (2 ** this.backoffAttempt));
    this.backoffAttempt += 1;
    this.emit("reconnecting", { delay });
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectEventSub();
    }, delay);
  }

  #report(error) {
    this.logger.error?.(`[twitch] ${error.message}`);
    this.emit("twitchError", error);
  }
}

export default TwitchClient;
