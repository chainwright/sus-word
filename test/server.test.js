import assert from "node:assert/strict";
import { test } from "node:test";

import WebSocket from "ws";

import Game from "../src/game.js";
import { SESSION_COOKIE, createSusWordServer } from "../src/server.js";

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
