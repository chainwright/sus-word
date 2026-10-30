import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import Game from "../src/game.js";
import { createSusWordServer } from "../src/server.js";
import {
  createRoundPlan,
  createSeededRandom,
  createSimLinePlan,
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

  test("three seeded rounds have unique lines and a sane per-player pace", () => {
    function session(seed) {
      const random = createSeededRandom(seed);
      const linePlan = createSimLinePlan(random);
      const sims = simProfiles(3);
      const table = planTable(sims);
      const rounds = ["home", "clothing", "travel"].map((category, index) => {
        table.impostors = [{
          playerId: sims[(index + 1) % sims.length].id,
          word: ["candle", "jacket", "train"][index],
          category,
        }];
        return createRoundPlan({
          table,
          sims,
          roundDuration: 180_000,
          voteDuration: 30_000,
          voteGrace: 6_000,
          random,
          linePlan,
        });
      });
      return { rounds, sims };
    }

    const first = session("three-round-session");
    const second = session("three-round-session");
    assert.deepEqual(first.rounds, second.rounds);

    const normalLines = first.rounds.flatMap(({ messages }) => (
      messages.filter(({ smuggle }) => !smuggle).map(({ text }) => text)
    ));
    assert.equal(new Set(normalLines).size, normalLines.length);

    for (const round of first.rounds) {
      for (const sim of first.sims) {
        const times = round.messages
          .filter(({ playerId, smuggle }) => playerId === sim.id && !smuggle)
          .map(({ atMs }) => atMs);
        const count = times.length;
        assert.ok(count >= 4 && count <= 9, `${sim.login} posted ${count} normal lines`);
        for (let index = 1; index < times.length; index += 1) {
          assert.ok(times[index] - times[index - 1] >= 20_000);
          assert.ok(times[index] - times[index - 1] <= 40_000);
        }
      }
    }

    const smuggleTimes = first.rounds.flatMap(({ messages }) => (
      messages.filter(({ smuggle }) => smuggle).map(({ atMs }) => atMs)
    ));
    assert.ok(new Set(smuggleTimes).size > 1);
  });

  test("generic reactions never repeat or contain a table's secret word", () => {
    const plan = createSimLinePlan(createSeededRandom("safe-replies"));
    const replies = Array.from({ length: 10 }, () => plan.nextReaction(["same", "point"])?.text).filter(Boolean);
    assert.equal(new Set(replies).size, replies.length);
    assert.ok(replies.every((reply) => !/\b(?:same|point)\b/i.test(reply)));
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
