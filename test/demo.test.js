import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import Game, { PHASES } from "../src/game.js";
import { demoRoundOutcomes, demoWordPicker, driveDemoRound, seededRandom } from "../src/demo.js";

test("an early-busted demo round is followed by a normal round with chat", async () => {
  const game = new Game({
    clock: { now: () => 0, setTimeout: () => Symbol("timer"), clearTimeout() {} },
    random: () => 0,
    words: [{ word: "candle", category: "home" }, { word: "rocket", category: "space" }],
  });
  for (const [index, login] of ["simone", "simtwo", "simthree"].entries()) {
    game.join({ id: `sim-${index}`, login, simulated: true });
    game.players.get(`sim-${index}`).claimed = true;
  }
  game.start();
  game.go({ word: "candle", category: "home" });
  let votes = 0;

  await driveDemoRound(game, {
    playChat: async () => {
      const table = game.currentRound;
      const assignment = table.impostors[0];
      const detective = [...table.roster.values()].find(({ id }) => id !== assignment.playerId);
      game.recordMessage({ userId: assignment.playerId, text: "this candle feels cozy tonight" });
      game.accuse(detective.id, assignment.playerId, assignment.word);
    },
    castVotes: async () => { votes += 1; },
  });
  assert.equal(game.lastReveal.verdict, "BUSTED");
  assert.equal(votes, 0, "the driver must not wait for a skipped vote phase");

  game.nextRound();
  game.go({ word: "rocket", category: "space" });
  await driveDemoRound(game, {
    playChat: async () => {
      const chatter = [...game.currentRound.roster.values()][1];
      game.recordMessage({ userId: chatter.id, text: "normal chat carries into round two" });
      game.beginVote();
    },
    castVotes: async () => {
      votes += 1;
      game.finishVote();
    },
  });
  assert.equal(votes, 1);
  assert.equal(game.lastReveal.messages.length, 1);
  assert.equal(game.lastReveal.messages[0].text, "normal chat carries into round two");
});

test("seeded demo outcomes repeat and include both hits and misses", () => {
  const game = {
    roundNumber: 1,
    tables: new Map([[1, { id: 1, impostors: [{ playerId: "imp" }] }]]),
  };
  const run = (seed) => {
    const random = seededRandom(seed);
    return Array.from({ length: 9 }, (_, index) => {
      game.roundNumber = index + 1;
      return demoRoundOutcomes(game, random).get("imp");
    });
  };
  const first = run("rehearsal-23");
  const second = run("rehearsal-23");
  assert.deepEqual(second, first);
  assert.ok(first.some(({ bust }) => bust));
  assert.ok(first.some(({ bust }) => !bust));
  assert.ok(first.some(({ catchByVote }) => catchByVote));
  assert.ok(first.some(({ catchByVote }) => !catchByVote));
});

test("the demo lets the game choose a fresh catalog word each round", async () => {
  const pool = [
    { word: "candle", category: "home" },
    { word: "rocket", category: "space" },
    { word: "tiger", category: "animals" },
  ];
  const pick = demoWordPicker(seededRandom("words-23"));
  const picked = Array.from({ length: pool.length }, () => pick({ words: pool }).word);
  assert.equal(new Set(picked).size, pool.length, "the picker must exhaust fresh words before repeating one");

  const source = await readFile(new URL("../src/demo.js", import.meta.url), "utf8");
  assert.match(source, /game\.go\(\);/);
  assert.doesNotMatch(source, /game\.go\(\{\s*word:/);
  assert.match(source, /wordPicker: demoWordPicker\(gameRandom\)/);
});
