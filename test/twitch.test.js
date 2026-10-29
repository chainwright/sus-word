import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import TwitchClient, {
  isGameAnnouncement,
  normalizeChatEvent,
} from "../src/twitch.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class FakeSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  terminate() {
    this.close();
  }
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, due: this.time + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  tick(milliseconds) {
    this.time += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.time) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

describe("Twitch chat normalization", () => {
  test("ignores only the bot's announcements, not broadcaster gameplay", () => {
    const base = {
      chatter_user_id: "42",
      chatter_user_login: "romabuilds",
      chatter_user_name: "RomaBuilds",
      broadcaster_user_id: "42",
      badges: [{ set_id: "broadcaster" }],
    };
    assert.equal(isGameAnnouncement("Vote! !vote name"), true);
    assert.equal(normalizeChatEvent({ ...base, message: { text: "🕵️ Vote now" } }, "42"), null);
    assert.equal(normalizeChatEvent({ ...base, message: { text: "🔔 ROUND 4 · NEW ROLES! Check your card 👉 /card" } }, "42"), null);
    assert.equal(normalizeChatEvent({ ...base, message: { text: "@a @b @c your role is on your card" } }, "42"), null);
    assert.equal(normalizeChatEvent({ ...base, message: { text: "🗳️🗳️ VOTE NOW: 30 SECONDS 🗳️🗳️ Type a number: 1 a" } }, "42"), null);
    assert.equal(normalizeChatEvent({ ...base, message: { text: "⏳ 10 seconds left to vote" } }, "42"), null);
    assert.equal(normalizeChatEvent({ ...base, message: { text: "Category: home" } }, "42"), null);

    const command = normalizeChatEvent({ ...base, message: { text: "!sus start" } }, "42");
    assert.equal(command.text, "!sus start");
    assert.equal(command.isBroadcaster, true);
  });
});

describe("Twitch Helix client", () => {
  test("refreshes once on 401 and caches user/avatar lookups", async () => {
    const requests = [];
    let refreshes = 0;
    const client = new TwitchClient({
      clientId: "client",
      clientSecret: "secret",
      botLogin: "bot",
      channelLogin: "channel",
      tokens: { access_token: "old", refresh_token: "refresh" },
      fetchImpl: async (url, options) => {
        requests.push({ url: url.toString(), authorization: options.headers.Authorization });
        if (requests.length === 1) return jsonResponse({ message: "expired" }, 401);
        return jsonResponse({
          data: [{ id: "1", login: "alice", profile_image_url: "avatar.png" }],
        });
      },
      refreshTokens: async () => {
        refreshes += 1;
        return { access_token: "new", refresh_token: "next" };
      },
    });

    const [first] = await client.getUsersByLogin(["Alice"]);
    const [cached] = await client.getUsersByLogin(["alice"]);
    assert.equal(first.profile_image_url, "avatar.png");
    assert.equal(cached, first);
    assert.equal(refreshes, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, "Bearer old");
    assert.equal(requests[1].authorization, "Bearer new");
  });

  test("subscribes after welcome and uses reconnect URLs without resubscribing", async () => {
    FakeSocket.instances = [];
    const requests = [];
    const client = new TwitchClient({
      clientId: "client",
      clientSecret: "secret",
      botLogin: "bot",
      channelLogin: "channel",
      tokens: { access_token: "token", refresh_token: "refresh" },
      WebSocketImpl: FakeSocket,
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse({ data: [] }, 202);
      },
      logger: { error() {} },
    });
    client.bot = { id: "bot-id", login: "bot" };
    client.broadcaster = { id: "channel-id", login: "channel" };
    client.stopped = false;
    const first = client.connectEventSub();
    first.emit("message", JSON.stringify({
      metadata: { message_type: "session_welcome" },
      payload: { session: { id: "session-1", keepalive_timeout_seconds: 10 } },
    }));
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.deepEqual(requests[0].condition, {
      broadcaster_user_id: "channel-id",
      user_id: "bot-id",
    });
    assert.deepEqual(requests[0].transport, {
      method: "websocket",
      session_id: "session-1",
    });

    first.emit("message", JSON.stringify({
      metadata: { message_type: "session_reconnect" },
      payload: { session: { reconnect_url: "wss://reconnect.example/session" } },
    }));
    const replacement = FakeSocket.instances[1];
    assert.equal(replacement.url, "wss://reconnect.example/session");
    replacement.emit("message", JSON.stringify({
      metadata: { message_type: "session_welcome" },
      payload: { session: { id: "session-2", keepalive_timeout_seconds: 10 } },
    }));
    assert.equal(first.closed, true);
    assert.equal(requests.length, 1);
    client.stop();
  });

  test("queues sent chat messages at least 1.5 seconds apart", async () => {
    const clock = new FakeClock();
    const sentAt = [];
    const client = new TwitchClient({
      clientId: "client",
      clientSecret: "secret",
      botLogin: "bot",
      channelLogin: "channel",
      clock,
      tokens: { access_token: "token", refresh_token: "refresh" },
      fetchImpl: async () => {
        sentAt.push(clock.now());
        return jsonResponse({ data: [{ is_sent: true }] });
      },
    });
    client.bot = { id: "bot-id", login: "bot" };
    client.broadcaster = { id: "channel-id", login: "channel" };

    await client.sendChat("first");
    const second = client.sendChat("second");
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.deepEqual(sentAt, [0]);
    clock.tick(1_499);
    await Promise.resolve();
    assert.deepEqual(sentAt, [0]);
    clock.tick(1);
    await second;
    assert.deepEqual(sentAt, [0, 1_500]);
  });
});
