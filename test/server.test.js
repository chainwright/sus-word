import assert from "node:assert/strict";
import { test } from "node:test";

import WebSocket from "ws";

import Game from "../src/game.js";
import {
  SESSION_COOKIE,
  createSusWordServer,
  isLocalHostOrigin,
  isLoopbackAddress,
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
