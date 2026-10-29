import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import Game from "../src/game.js";
import { createSusWordServer } from "../src/server.js";
import {
  createRoundPlan,
  createSeededRandom,
  recordSimMessage,
  seatSimPlayers,
  simProfiles,
} from "../src/sim.js";

function planTable(sims) {
  return {
    id: 1,
    roster: new Map(sims.map((player, index) => [player.id, { ...player, number: index + 1 }])),
    impostors: [{ playerId: sims[1].id, word: "candle", category: "home" }],
  };
}

class FakeTwitch extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.bot = { id: "bot", login: "test_bot" };
    this.broadcaster = { id: "host", login: "test_host" };
    this.connected = true;
  }

  async start() {}
  stop() {}
  async sendChat(text) { this.sent.push(text); }
}

describe("v3 rehearsal simulator", () => {
  test("seeded round and vote plans are deterministic", () => {
    const sims = simProfiles(3);
    const options = {
      table: planTable(sims),
      sims,
      roundDuration: 180_000,
      voteDuration: 30_000,
      voteGrace: 6_000,
    };
    const first = createRoundPlan({ ...options, random: createSeededRandom("take-one") });
    const second = createRoundPlan({ ...options, random: createSeededRandom("take-one") });

    assert.deepEqual(first, second);
    assert.ok(first.messages.some(({ smuggle, atMs }) => smuggle && atMs >= 40_000 && atMs <= 140_000));
    assert.ok(first.votes.some(({ grace, atMs }) => grace && atMs > 30_000 && atMs <= 36_000));
    assert.ok(first.votes.every(({ targetNumber }) => Number.isInteger(targetNumber)));
  });

  test("sim players use the v3 link path, expose SIM state, and never send their lines to Twitch", async (context) => {
    const twitch = new FakeTwitch();
    const game = new Game({
      random: createSeededRandom("public-state"),
      wordPicker: () => ({ word: "candle", category: "home" }),
      durations: { lobby: 30 * 60_000 },
    });
    const service = createSusWordServer({
      game,
      twitch,
      port: 0,
      env: { CHANNEL_LOGIN: "", PUBLIC_URL: "http://localhost" },
      logger: { log() {}, error() {} },
    });
    context.after(async () => {
      game.reset();
      await service.stop();
    });
    await service.start();
    game.start();
    const sims = simProfiles(3);
    await seatSimPlayers(game, service, sims);

    assert.deepEqual([...game.players.values()].map(({ number }) => number), [1, 2, 3]);
    assert.ok(game.getPublicState().players.every(({ simulated }) => simulated));
    assert.equal(game.go().ok, true);

    const sentBeforeLine = twitch.sent.length;
    const result = recordSimMessage(game, sims[0], "the lamp beside my desk keeps flickering", 1);
    assert.equal(result.ok, true);
    assert.equal(twitch.sent.length, sentBeforeLine);
    assert.ok(!twitch.sent.some((text) => text.includes("the lamp beside my desk keeps flickering")));

    const publicMessage = game.getPublicState().round.latestMessages.at(-1);
    assert.equal(publicMessage.player.simulated, true);
    assert.match(publicMessage.player.displayName, /^Sim /);
  });

  test("profile identifiers stay unique past the base name list", () => {
    const sims = simProfiles(25);
    assert.equal(new Set(sims.map(({ id }) => id)).size, 25);
    assert.equal(new Set(sims.map(({ login }) => login)).size, 25);
    assert.equal(new Set(sims.map(({ sessionId }) => sessionId)).size, 25);
    assert.ok(sims.every(({ displayName, simulated }) => displayName.startsWith("Sim") && simulated));
  });
});
