import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import Game, { PHASES } from "../src/game.js";
import {
  demoRoundOutcomes,
  demoIntermissionPlan,
  demoLobbyDuration,
  demoProfiles,
  demoPublicUrl,
  demoTableCapacity,
  demoWordLines,
  demoWordPicker,
  driveDemoRound,
  resetDemoSession,
  requestedPlayerCount,
  requestedSeed,
  seededRandom,
  selectDemoVoteTarget,
  shouldStartDemoFinal,
} from "../src/demo.js";
import { WORDS, findWord } from "../src/words.js";

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

test("every demo word is grammatical in both category-aware chat templates", () => {
  for (const entry of WORDS) {
    const lines = demoWordLines(entry);
    for (const line of Object.values(lines)) {
      assert.equal(findWord(line, entry.word).hit, true, `${entry.word}: ${line}`);
    }
    const plurals = ["pants", "socks", "shoes", "boots", "shorts", "glasses", "scissors", "notes"];
    if (plurals.includes(entry.word)) {
      assert.doesNotMatch(lines.decoy, new RegExp(`\\b(?:a|an)\\s+${entry.word}\\b`, "i"));
    } else if (["animals", "travel", "people"].includes(entry.category)
      || (entry.category === "fantasy" && !["space", "treasure"].includes(entry.word))) {
      const article = entry.word === "uniform" ? "a" : /^[aeiou]/.test(entry.word) ? "an" : "a";
      assert.match(lines.decoy, new RegExp(`\\b${article} ${entry.word}\\b`, "i"), lines.decoy);
    }
    assert.doesNotMatch(lines.decoy, /I keep (?:a |an )?(?:river|ocean|forest|mountain|valley|desert|island) near my desk/i);
  }
});

test("full demo intermissions show card results and clearly restart after a final", () => {
  assert.equal(demoLobbyDuration(false), 10_000);
  assert.equal(demoLobbyDuration(true), 2_000);
  assert.deepEqual(demoIntermissionPlan(false, false), {
    sessionOverMs: 0,
    nextSessionMs: 0,
    lobbyMs: 10_000,
  });
  assert.deepEqual(demoIntermissionPlan(false, true), {
    sessionOverMs: 2_000,
    nextSessionMs: 8_000,
    lobbyMs: 0,
  });
  assert.equal(demoIntermissionPlan(true, false).lobbyMs, 2_000);
  assert.ok(demoIntermissionPlan(true, true).nextSessionMs < 1_000, "--fast must stay fast");
  assert.equal(shouldStartDemoFinal(2, [{ id: 1 }]), false);
  assert.equal(shouldStartDemoFinal(3, [{ id: 1 }]), false, "a one-table session does not replay the same group as a FINAL");
  assert.equal(shouldStartDemoFinal(3, [{ id: 1 }, { id: 2 }]), true);
  assert.equal(shouldStartDemoFinal(30, []), false);
});

test("demo voters never target an already-busted Imposter", () => {
  const roster = new Map([
    ["busted", { id: "busted", login: "busted" }],
    ["hidden", { id: "hidden", login: "hidden" }],
    ["detective", { id: "detective", login: "detective" }],
  ]);
  const table = {
    roster,
    impostors: [{ playerId: "busted", busted: true }, { playerId: "hidden", busted: false }],
  };
  const target = selectDemoVoteTarget(table, roster.get("detective"), new Map([["hidden", { catchByVote: true }]]));
  assert.equal(target.id, "hidden");

  const missedTarget = selectDemoVoteTarget(table, roster.get("hidden"), new Map());
  assert.equal(missedTarget.id, "detective", "even a miss path must exclude the busted Imposter");
});

test("hosted demo options use DEMO env values while CLI flags win", () => {
  assert.equal(requestedPlayerCount(["node", "demo.js"], "10"), 10);
  assert.equal(requestedPlayerCount(["node", "demo.js", "--players", "30"], "10"), 30);
  assert.equal(requestedSeed(["node", "demo.js"], "hosted-seed"), "hosted-seed");
  assert.equal(requestedSeed(["node", "demo.js", "--seed=cli-seed"], "hosted-seed"), "cli-seed");
  assert.equal(requestedSeed(["node", "demo.js"], ""), "sus-word-demo");
  assert.equal(demoTableCapacity(10, "https://demo.example"), 6, "the hosted ten-player showcase has two tables");
  assert.equal(demoTableCapacity(10), 12, "a local rehearsal keeps the normal table cap");
});

test("offline demo links stay local even when a stale tunnel is in the environment", () => {
  assert.equal(demoPublicUrl(3000), "http://localhost:3000");
  assert.equal(demoPublicUrl(4123), "http://localhost:4123");
  assert.equal(demoPublicUrl(3000, "https://sus-demo.example/"), "https://sus-demo.example");
});

test("the demo runtime never falls back to the streamer's PUBLIC_URL", async () => {
  const source = await readFile(new URL("../src/demo.js", import.meta.url), "utf8");
  assert.match(source, /process\.env\.DEMO_PUBLIC_URL/);
  assert.doesNotMatch(source, /options\.publicUrl\s*\?\?\s*process\.env\.PUBLIC_URL/);
});

test("many demo sessions reset all growing game collections", () => {
  let codeIndex = 0;
  const codes = ["A2B3", "C4D5", "E6F7", "G8H9"];
  const liveTimers = new Set();
  const game = new Game({
    clock: {
      now: () => 1_000,
      setTimeout(callback, delay) {
        const timer = { callback, delay };
        liveTimers.add(timer);
        return timer;
      },
      clearTimeout(timer) { liveTimers.delete(timer); },
    },
    random: () => 0,
    codeGenerator: () => codes[codeIndex++ % codes.length],
    words: [{ word: "candle", category: "home" }],
  });
  const profiles = demoProfiles(4);
  for (let session = 0; session < 40; session += 1) {
    const seeded = resetDemoSession(game, profiles);
    assert.deepEqual(seeded, { players: 4, profiles: 4, sessions: 4, claims: 4, timers: 1 });
    assert.equal(game.go({ word: "candle", category: "home" }).ok, true);
    game.isFinalRound = true;
    game.beginVote();
    game.finishVote();
    game.nextRound();
    assert.equal(game.sessionOver, true);
    assert.ok(game.cardResults.size <= profiles.length);
    assert.ok(game.lastRoundSeating.length <= 1);
    assert.ok(game.timers.size <= 2);
  }
  assert.equal(game.players.size, profiles.length);
  assert.equal(game.profiles.size, profiles.length);
  assert.equal(game.sessions.size, profiles.length);
  assert.equal(game.claims.size, profiles.length);
  assert.ok(liveTimers.size <= 2);
});
