import assert from "node:assert/strict";
import { test } from "node:test";

import WebSocket from "ws";

import Game from "../src/game.js";
import {
  SESSION_COOKIE,
  containsUrl,
  createSusWordServer,
  isLocalHostOrigin,
  isLoopbackAddress,
  splitChatMessage,
  stripUrls,
} from "../src/server.js";

function firstSocketMessage(url, options) {
  const socket = new WebSocket(url, options);
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve({
      payload: JSON.parse(data.toString()),
      socket,
    }));
    socket.once("error", reject);
  });
}

function socketMessageOfType(socket, type) {
  return new Promise((resolve, reject) => {
    function onMessage(data) {
      const payload = JSON.parse(data.toString());
      if (payload.type !== type) return;
      socket.off("message", onMessage);
      socket.off("error", onError);
      resolve(payload);
    }
    function onError(error) {
      socket.off("message", onMessage);
      reject(error);
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

test("voice input trusts loopback addresses only", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.12"), false);
  assert.equal(isLoopbackAddress("203.0.113.8"), false);
  assert.equal(isLocalHostOrigin("http://localhost:3000"), true);
  assert.equal(isLocalHostOrigin("http://127.0.0.1:3000"), true);
  assert.equal(isLocalHostOrigin("https://sus-word.example"), false);
});

test("a local host WebSocket records voice as the configured broadcaster", async (context) => {
  const codes = ["A2B3", "C4D5", "E6F7"];
  const game = new Game({
    random: () => 0,
    codeGenerator: () => codes.shift(),
    words: [{ word: "candle", category: "home" }],
  });
  const service = createSusWordServer({
    game,
    port: 0,
    env: { CHANNEL_LOGIN: "streamer" },
    logger: { log() {}, error() {} },
  });
  context.after(async () => {
    game.reset();
    await service.stop();
  });

  for (const [index, login] of ["streamer", "alice", "bruno"].entries()) {
    const claim = game.createClaim({ sessionId: `voice-${login}`, login });
    game.claim(claim.code, login, `voice-user-${index}`);
  }
  game.start();
  assert.equal(game.go({ word: "candle", category: "home" }).ok, true);
  assert.equal(game.phase, "ROUND");

  const address = await service.start();
  const host = await firstSocketMessage(
    `ws://127.0.0.1:${address.port}/ws?view=host`,
    { origin: `http://localhost:${address.port}` },
  );
  assert.equal(host.payload.data.state, "ROUND");
  const resultMessage = socketMessageOfType(host.socket, "voiceResult");
  host.socket.send(JSON.stringify({
    type: "voice",
    text: "I lit a candle beside the monitor",
  }));
  const result = await resultMessage;

  assert.equal(result.data.ok, true, result.data.reason);
  assert.equal(result.data.delivered, true);
  assert.equal(game.currentRound.smuggle.source, "voice");
  assert.equal(game.currentRound.smuggle.login, "streamer");
  host.socket.close();
});

test("the claim route binds a code and private card state to its session cookie", async (context) => {
  const game = new Game();
  const service = createSusWordServer({
    game,
    port: 0,
    env: {},
    logger: { log() {}, error() {} },
  });
  context.after(() => service.stop());
  const address = await service.start();
  const origin = `http://127.0.0.1:${address.port}`;

  const invalid = await fetch(`${origin}/api/card/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "bad-name" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).reason, "invalid_login");

  const started = await fetch(`${origin}/api/card/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "Alice" }),
  });
  assert.equal(started.status, 200);
  const claim = await started.json();
  assert.equal(claim.seenInChat, false);
  assert.match(claim.nameCheck.message, /haven't seen @alice in chat yet/);
  assert.match(claim.code, /^[A-HJ-NP-Z2-9]{4}$/);
  const cookie = started.headers.get("set-cookie").split(";", 1)[0];
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));

  const before = await fetch(`${origin}/api/card`, { headers: { Cookie: cookie } });
  const pending = await before.json();
  assert.equal(pending.linked, false);
  assert.equal(pending.pendingClaim.code, claim.code);
  assert.equal(pending.pendingClaim.login, "alice");

  assert.equal(game.claim(claim.code, "alice", "user-1").ok, true);
  const after = await fetch(`${origin}/api/card`, { headers: { Cookie: cookie } });
  const card = await after.json();
  assert.equal(card.linked, true);
  assert.equal(card.player.id, "user-1");

  const webSocketOrigin = origin.replace("http:", "ws:");
  const privateView = await firstSocketMessage(
    `${webSocketOrigin}/ws?view=card`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(privateView.payload.type, "card");
  assert.equal(privateView.payload.data.player.id, "user-1");
  assert.equal("scores" in privateView.payload.data, false);

  const publicView = await firstSocketMessage(`${webSocketOrigin}/ws?view=overlay`);
  assert.equal(publicView.payload.type, "state");
  assert.equal(publicView.payload.data.state, "IDLE");
  assert.equal(publicView.payload.data.cardUrl, "http://localhost:3000/card");
  assert.equal("role" in publicView.payload.data, false);
  privateView.socket.close();
  publicView.socket.close();
});

test("name checks use chat seen in the last 15 minutes", async (context) => {
  let now = 1_000_000;
  const game = new Game();
  const service = createSusWordServer({
    game,
    port: 0,
    env: {},
    now: () => now,
    logger: { log() {}, error() {} },
  });
  context.after(() => service.stop());
  const address = await service.start();
  const origin = `http://127.0.0.1:${address.port}`;

  const unseen = await fetch(`${origin}/api/card/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "Alice" }),
  }).then((response) => response.json());
  assert.equal(unseen.seen, false);

  await service.handleChatMessage({ id: "seen-1", userId: "alice-id", login: "Alice", text: "hello chat" });
  const seen = await fetch(`${origin}/api/card/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "alice" }),
  }).then((response) => response.json());
  assert.equal(seen.seen, true);
  assert.equal(seen.message, "✓ @alice is in chat");

  now += 15 * 60 * 1_000 + 1;
  assert.equal(service.checkChatName("alice").seen, false);
});

test("join aliases reply once and !join CODE links the matching account", async () => {
  const messages = [];
  const game = new Game({ codeGenerator: () => "A2B3" });
  const service = createSusWordServer({
    game,
    env: {},
    logger: {
      log(message) { messages.push(message.replace(/^\[offline\] /, "")); },
      error() {},
    },
  });
  const chatter = { id: "chat-1", userId: "alice-id", login: "alice", displayName: "Alice" };
  assert.equal((await service.handleChatMessage({ ...chatter, text: "ijoin" })).replied, true);
  assert.equal((await service.handleChatMessage({ ...chatter, text: "join " })).replied, false);
  assert.equal(messages.filter((message) => message.includes("almost!")).length, 1);

  assert.equal((await service.handleChatMessage({ ...chatter, text: "!join" })).replied, true);
  assert.equal((await service.handleChatMessage({ ...chatter, text: "!join" })).replied, false);
  assert.equal(messages.filter((message) => message.includes("get your secret card")).length, 1);

  const claim = game.createClaim({ sessionId: "alice-session", login: "alice" });
  const linked = await service.handleChatMessage({ ...chatter, text: `!join ${claim.code}` });
  assert.equal(linked.ok, true);
  assert.equal(game.getCard("alice-session").player.id, "alice-id");
  assert.match(messages.at(-1), /you're in! Keep your card open/);
});

test("a dropped join link can be retried and claim replies yield only after the lobby link", async (context) => {
  const sends = [];
  let dropNext = true;
  const codes = ["A2B3", "C4D5"];
  const twitch = {
    async getUsersByLogin([login]) {
      return [{ id: `${login}-id`, login, display_name: login, profile_image_url: "" }];
    },
    async sendChat(message, options) {
      sends.push({ message, options });
      if (dropNext) {
        dropNext = false;
        return { dropped: true, reason: "chat_queue_busy" };
      }
      return { data: [{ message_id: `sent-${sends.length}` }] };
    },
  };
  const game = new Game({ codeGenerator: () => codes.shift() });
  context.after(() => game.reset());
  const service = createSusWordServer({ game, twitch, env: {}, logger: { log() {}, error() {} } });
  const chatter = { id: "retry-1", userId: "retry-id", login: "retry", displayName: "Retry" };
  assert.equal((await service.handleChatMessage({ ...chatter, text: "!join" })).replied, false);
  assert.equal((await service.handleChatMessage({ ...chatter, text: "!join" })).replied, true);
  assert.equal(sends.filter(({ message }) => message.includes("get your secret card")).length, 2);

  const beforeLobby = game.createClaim({ sessionId: "before-lobby", login: "early" });
  await service.handleChatMessage({
    id: "early-chat",
    userId: "early-id",
    login: "early",
    displayName: "Early",
    text: `!join ${beforeLobby.code}`,
  });
  assert.equal(sends.findLast(({ message }) => message.includes("you're in!")).options.priority, undefined);

  game.players.get("retry-id").claimed = true;
  game.join({ id: "second-id", login: "second" });
  game.players.get("second-id").claimed = true;
  game.join({ id: "third-id", login: "third" });
  game.players.get("third-id").claimed = true;
  game.start();
  await new Promise((resolve) => setImmediate(resolve));
  const claim = game.createClaim({ sessionId: "fourth-session", login: "fourth" });
  await service.handleChatMessage({
    id: "fourth-chat",
    userId: "fourth-id",
    login: "fourth",
    displayName: "Fourth",
    text: `!join ${claim.code}`,
  });
  const accepted = sends.findLast(({ message }) => message.includes("you're in!"));
  assert.equal(accepted.options.priority, "low");
});

test("a wrong-account code gets the specified bot and card message", async () => {
  const messages = [];
  const game = new Game({ codeGenerator: () => "A2B3" });
  const service = createSusWordServer({
    game,
    env: {},
    logger: { log(message) { messages.push(message.replace(/^\[offline\] /, "")); }, error() {} },
  });
  const claim = game.createClaim({ sessionId: "alice-session", login: "alice" });
  const result = await service.handleChatMessage({
    id: "wrong-1",
    userId: "mallory-id",
    login: "mallory",
    displayName: "Mallory",
    text: `!claim ${claim.code}`,
  });
  const expected = "@mallory this code was made for @alice. Open the card and type your own Twitch name";
  assert.equal(result.message, expected);
  assert.equal(messages.at(-1), expected);
  assert.equal(game.getPendingClaim("alice-session").error, expected);
});

test("non-player link spam is ignored and never echoed", async () => {
  const messages = [];
  const game = new Game();
  const service = createSusWordServer({
    game,
    env: {},
    logger: { log(message) { messages.push(message); }, error() {} },
  });
  assert.equal(containsUrl("cheap viewers https://spam.invalid now"), true);
  const result = await service.handleChatMessage({
    id: "spam-1",
    userId: "spam-id",
    login: "spam_bot",
    text: "cheap viewers https://spam.invalid now",
  });
  assert.deepEqual(result, { ok: true, ignored: true, reason: "link_spam" });
  assert.equal(messages.length, 0);
  assert.equal(game.players.has("spam-id"), false);
});

test("early number votes are saved with one reply and rejected votes get feedback", async () => {
  const messages = [];
  const game = new Game({ random: () => 0, words: [{ word: "candle", category: "home" }] });
  for (const [id, login] of [["vote-a", "alice"], ["vote-b", "bruno"], ["vote-c", "chloe"]]) {
    game.join({ id, login });
    game.players.get(id).claimed = true;
  }
  const service = createSusWordServer({
    game,
    env: {},
    logger: { log(message) { messages.push(message.replace(/^\[offline\] /, "")); }, error() {} },
  });
  game.start();
  game.go();
  const base = { id: "vote-msg", userId: "vote-b", login: "bruno", displayName: "Bruno" };
  const first = await service.handleChatMessage({ ...base, text: "1" });
  assert.equal(first.early, true);
  assert.equal(first.voteMessage, true);
  assert.equal(first.visible, false);
  assert.ok(messages.includes("@bruno voting opens when the timer ends. Your number guess is saved: 1"));
  await service.handleChatMessage({ ...base, text: "#3" });
  assert.equal(messages.filter((message) => message.startsWith("@bruno voting opens")).length, 1);

  await service.handleChatMessage({ ...base, text: "99" });
  assert.equal(messages.at(-1), "@bruno there is no player 99 at your table.");
  await service.handleChatMessage({ ...base, text: "2" });
  assert.equal(messages.at(-1), "@bruno you can't vote for yourself.");
  const beforeCrowd = messages.length;
  const crowdVote = await service.handleChatMessage({
    id: "outsider-vote",
    userId: "outsider",
    login: "outsider",
    displayName: "Outsider",
    text: "1",
  });
  assert.equal(crowdVote.ok, true);
  assert.equal(crowdVote.crowd, true);
  assert.equal(messages.length, beforeCrowd);
  await service.handleChatMessage({
    id: "outsider-bad-vote",
    userId: "another-outsider",
    login: "another_outsider",
    displayName: "Another outsider",
    text: "99",
  });
  assert.equal(messages.length, beforeCrowd);
  assert.equal(game.currentRound.messages.length, 0);
  game.reset();
});

test("bot announcements stay within 500 characters and delay the case file until reveal hold ends", () => {
  const messages = [];
  const scheduled = [];
  let nextTimerId = 1;
  const game = new Game({ random: () => 0 });
  const service = createSusWordServer({
    game,
    env: { PUBLIC_URL: "https://sus.example" },
    setTimeout(callback, delay) {
      const timer = { id: nextTimerId, callback, delay };
      nextTimerId += 1;
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = scheduled.indexOf(timer);
      if (index >= 0) scheduled.splice(index, 1);
    },
    logger: { log(message) { messages.push(message.replace(/^\[offline\] /, "")); }, error() {} },
  });
  for (let index = 0; index < 30; index += 1) {
    const id = `bot-copy-${index}`;
    game.join({ id, login: `viewer_${String(index).padStart(2, "0")}` });
    game.players.get(id).claimed = true;
  }
  game.start();
  game.go();
  assert.ok(messages.includes("🔔 ROUND 1 · NEW ROLES! Check your card 👉 https://sus.example/card"));
  const roleLines = messages.filter((message) => message.endsWith("your role is on your card"));
  assert.equal((roleLines.join(" ").match(/@viewer_/g) ?? []).length, 30);
  game.emit("hint", { kind: "category", value: "food" });
  game.emit("hint", { kind: "letter", value: "l" });
  game.beginVote();
  game.emit("voteWarning", { seconds: 10 });
  assert.ok(messages.includes("🕵️ HINT: the word is about FOOD"));
  assert.ok(messages.includes("🕵️ HINT: it starts with L"));
  assert.ok(messages.some((message) => message.startsWith("🗳️🗳️ VOTE NOW: 30 SECONDS 🗳️🗳️ Type a number:")));
  assert.ok(messages.includes("⏳ 10 seconds left to vote"));
  assert.ok(messages.every((message) => message.length <= 500));
  assert.ok(splitChatMessage("word ".repeat(200)).every((message) => message.length <= 500));
  game.finishVote();
  let caseFiles = messages.filter((message) => /^Round 1: [A-Z]+ (?:slipped in at|never landed)/.test(message));
  assert.equal(caseFiles.length, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 26_000);
  scheduled[0].callback();
  caseFiles = messages.filter((message) => /^Round 1: [A-Z]+ (?:slipped in at|never landed)/.test(message));
  assert.equal(caseFiles.length, 1);
  assert.equal(messages.some((message) => message.includes("was the Imposter!")), false);
  game.reset();
  void service;
});

test("chat routes accusations and the host can feature another table", async (context) => {
  const game = new Game({
    random: () => 0,
    words: [
      { word: "candle", category: "home" },
      { word: "rocket", category: "space" },
    ],
  });
  for (let index = 0; index < 13; index += 1) {
    game.join({ id: `route-${index}`, login: `route_${index}` });
    game.players.get(`route-${index}`).claimed = true;
  }
  game.start();
  game.go({ word: "candle", category: "home" });
  const impostor = game.currentRound.roster.get(game.currentRound.impostorId);
  const detective = [...game.currentRound.roster.values()].find(({ id }) => id !== impostor.id);
  game.recordMessage({ userId: impostor.id, text: "this candle smells wonderful tonight" });
  const service = createSusWordServer({
    game,
    port: 0,
    env: {},
    logger: { log() {}, error() {} },
  });
  context.after(async () => {
    game.reset();
    await service.stop();
  });
  const accusation = await service.handleChatMessage({
    id: "accuse-1",
    userId: detective.id,
    login: detective.login,
    displayName: detective.displayName,
    text: `!accuse @${impostor.login} candles`,
  });
  assert.equal(accusation.correct, true);

  const address = await service.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/host/feature/2`, {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tableId, 2);
  assert.equal(game.featuredTableId, 2);
});

test("side-table card messages are sanitized, scoped, and rate limited", () => {
  let now = 10_000;
  const game = new Game({
    random: () => 0,
    words: [
      { word: "candle", category: "home" },
      { word: "rocket", category: "space" },
    ],
  });
  for (let index = 0; index < 13; index += 1) {
    const id = `card-${index}`;
    game.join({ id, login: `card_${index}` });
    game.players.get(id).claimed = true;
    game.sessions.set(`session-${index}`, { userId: id, linkedAt: 0 });
  }
  game.start();
  game.go();
  const sidePlayer = [...game.tables.get(2).roster.values()][0];
  const sid = [...game.sessions.entries()].find(([, session]) => session.userId === sidePlayer.id)[0];
  const service = createSusWordServer({
    game,
    port: 0,
    env: {},
    now: () => now,
    logger: { log() {}, error() {} },
  });

  assert.equal(stripUrls("look https://example.com here www.test.invalid now"), "look here now");
  const first = service.handleCardAction(sid, {
    type: "tableChat",
    text: "look https://example.com this is evidence",
  });
  assert.equal(first.ok, true);
  assert.equal(game.tables.get(2).messages[0].text, "look this is evidence");
  assert.equal(service.handleCardAction(sid, {
    type: "tableChat",
    text: "another message arrives too soon",
  }).reason, "rate_limited");
  now += 2_000;
  assert.equal(service.handleCardAction(sid, {
    type: "tableChat",
    text: "x".repeat(201),
  }).reason, "invalid_message");
  game.reset();
});

test("a broadcaster can mute a player out of the session", async () => {
  const game = new Game({ random: () => 0 });
  for (const [id, login] of [["mute-a", "alice"], ["mute-b", "bruno"], ["mute-c", "cora"]]) {
    game.join({ id, login });
    game.players.get(id).claimed = true;
  }
  game.start();
  game.go({ word: "candle", category: "home" });
  const service = createSusWordServer({
    game,
    port: 0,
    env: {},
    logger: { log() {}, error() {} },
  });
  assert.equal((await service.handleChatMessage({
    userId: "stranger",
    login: "stranger",
    text: "!sus mute alice",
  })).reason, "not_authorized");
  assert.equal((await service.handleChatMessage({
    userId: "channel",
    login: "channel",
    isBroadcaster: true,
    text: "!sus mute alice",
  })).ok, true);
  assert.equal(game.currentRound.roster.has("mute-a"), false);
  assert.equal(game.recordMessage({ userId: "mute-a", text: "I should not appear" }).reason, "muted");
  game.reset();
  game.start();
  assert.equal(game.go().reason, "not_enough_claimed");
  game.reset();
});
