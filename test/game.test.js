import assert from "node:assert/strict";
import { describe, test } from "node:test";

import Game, { DEFAULT_DURATIONS, PHASES } from "../src/game.js";

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
    this.timers.set(id, { callback, due: this.time + delay, id });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  tick(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const timer = [...this.timers.values()]
        .filter(({ due }) => due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (!timer) break;
      this.time = timer.due;
      this.timers.delete(timer.id);
      timer.callback();
    }
    this.time = target;
  }
}

const CODES = [
  "A2B3", "C4D5", "E6F7", "G8H9", "J2K3", "L4M5", "N6P7", "Q8R9",
];

function createGame(overrides = {}) {
  const clock = overrides.clock ?? new FakeClock();
  const codes = [...CODES];
  const game = new Game({
    clock,
    random: () => 0,
    codeGenerator: () => codes.shift(),
    words: [{ word: "candle", category: "home" }],
    ...overrides,
  });
  return { clock, game };
}

function claimPlayers(game, names = ["alice", "bruno", "chloe"]) {
  return names.map((login, index) => {
    const sessionId = `session-${login}`;
    const created = game.createClaim({ sessionId, login });
    assert.equal(created.ok, true);
    const claimed = game.claim({
      code: created.code,
      login: login.toUpperCase(),
      userId: `user-${index + 1}`,
      displayName: login[0].toUpperCase() + login.slice(1),
      avatar: `https://example.test/${login}.png`,
    });
    assert.equal(claimed.ok, true);
    return { code: created.code, id: `user-${index + 1}`, login, sessionId };
  });
}

function startRound(game, options = { word: "candle", category: "home" }) {
  const players = claimPlayers(game);
  assert.equal(game.start().ok, true);
  assert.equal(game.go(options).ok, true);
  assert.equal(game.state, PHASES.ROUND);
  return players;
}

describe("claims and lobby players", () => {
  test("a claim is session-bound, case-insensitive, single-use, and auto-joins", () => {
    const { game } = createGame();
    const created = game.createClaim("browser-1", "Alice");
    assert.match(created.code, /^[A-HJ-NP-Z2-9]{4}$/);

    const claimed = game.claim(created.code, {
      chatterLogin: "aLiCe",
      userId: "user-1",
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.sessionId, "browser-1");
    assert.equal(game.players.get("user-1").claimed, true);
    assert.equal(game.getCard("browser-1").linked, true);
    assert.deepEqual(game.claim(created.code, "alice", "user-1"), {
      ok: false,
      reason: "code_used",
    });
  });

  test("rejects a wrong-name claim without consuming its code", () => {
    const { game } = createGame();
    const { code } = game.createClaim("browser-1", "alice");

    assert.deepEqual(game.claim(code, "mallory", "user-9"), {
      ok: false,
      reason: "name_mismatch",
    });
    assert.equal(game.players.size, 0);
    assert.equal(game.claim(code, "ALICE", "user-1").ok, true);
  });

  test("rejects a code once it is ten minutes old", () => {
    const { clock, game } = createGame();
    const { code } = game.createClaim("browser-1", "alice");
    clock.tick(DEFAULT_DURATIONS.claim);
    assert.deepEqual(game.claim(code, "alice", "user-1"), {
      ok: false,
      reason: "code_expired",
    });
  });

  test("supports join and leave without granting an unclaimed card", () => {
    const { game } = createGame();
    assert.equal(game.join({ id: "guest-1", login: "guest" }).joined, true);
    assert.equal(game.players.get("guest-1").claimed, false);
    assert.deepEqual(game.getCard("missing"), { linked: false, role: null });
    assert.equal(game.leave("@guest").ok, true);
    assert.equal(game.players.size, 0);
  });
});

describe("state machine and role selection", () => {
  test("auto-starts after 60 seconds only with at least three claimed players", () => {
    const { clock, game } = createGame();
    claimPlayers(game, ["alice", "bruno"]);
    game.join({ id: "guest", login: "guest" });
    game.start();
    clock.tick(DEFAULT_DURATIONS.lobby);
    assert.equal(game.state, PHASES.LOBBY);
    assert.equal(clock.timers.size, 1);
    assert.equal([...clock.timers.values()][0].due, 2 * DEFAULT_DURATIONS.lobby);

    const created = game.createClaim("session-chloe", "chloe");
    game.claim(created.code, "chloe", "user-3");
    assert.equal(game.state, PHASES.ROUND);
    assert.notEqual(game.currentRound.impostorId, "guest");
  });

  test("never selects an unclaimed player or the same Imposter twice in a row", () => {
    const { game } = createGame();
    game.join({ id: "guest", login: "guest" });
    claimPlayers(game);
    game.start();
    game.go({ word: "candle", category: "home" });
    const first = game.currentRound.impostorId;
    assert.notEqual(first, "guest");

    game.beginVote();
    game.finishVote();
    game.nextRound();
    game.go({ word: "candle", category: "home" });
    assert.notEqual(game.currentRound.impostorId, first);
    assert.notEqual(game.currentRound.impostorId, "guest");
  });

  test("emits both timed hints, then advances through vote, reveal, and lobby", () => {
    const { clock, game } = createGame();
    claimPlayers(game);
    const events = [];
    game.on("event", (event) => events.push(event));
    game.start();
    game.go({ word: "candle", category: "home" });

    clock.tick(DEFAULT_DURATIONS.categoryHint - 1);
    assert.equal(events.filter(({ type }) => type === "hint").length, 0);
    clock.tick(1);
    assert.deepEqual(
      events.filter(({ type }) => type === "hint").map(({ kind, value }) => [kind, value]),
      [["category", "home"]],
    );
    assert.equal(game.getPublicState().round.hints.category, "home");
    assert.equal(game.getPublicState().round.hints.letter, null);

    clock.tick(DEFAULT_DURATIONS.letterHint - DEFAULT_DURATIONS.categoryHint);
    assert.equal(game.getPublicState().round.hints.letter, "c");
    clock.tick(DEFAULT_DURATIONS.round - DEFAULT_DURATIONS.letterHint);
    assert.equal(game.state, PHASES.VOTE);
    clock.tick(DEFAULT_DURATIONS.vote);
    assert.equal(game.state, PHASES.REVEAL);
    clock.tick(DEFAULT_DURATIONS.reveal);
    assert.equal(game.state, PHASES.LOBBY);
  });

  test("end returns to idle and reset clears the session", () => {
    const { game } = createGame();
    claimPlayers(game);
    game.start();
    assert.equal(game.end().state, PHASES.IDLE);
    assert.equal(game.players.size, 3);
    game.reset();
    assert.equal(game.players.size, 0);
    assert.equal(game.scores.size, 0);
    assert.equal(game.roundNumber, 0);
  });
});

describe("round messages and reveal payload", () => {
  test("tracks the first smuggle, accidental decoys, private delivery, and readers", () => {
    const { clock, game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    const publicEvents = [];
    const cardEvents = [];
    game.on("event", (event) => publicEvents.push(event));
    game.on("card", (event) => cardEvents.push(event));
    assert.equal(game.currentRound.impostorId, alice.id);
    assert.equal(game.getCard(alice.sessionId).word, "candle");
    assert.equal(game.getCard(bruno.sessionId).role, "DETECTIVE");
    assert.equal("word" in game.getCard(bruno.sessionId), false);
    assert.equal(JSON.stringify(game.getPublicState()).includes("candle"), false);

    clock.tick(5_000);
    assert.equal(
      game.recordMessage({ userId: bruno.id, text: "I bought a candle yesterday" }).decoy,
      true,
    );
    assert.equal(
      game.recordMessage({ userId: alice.id, text: "candle" }).delivered,
      false,
    );
    assert.equal(
      game.recordMessage({ userId: alice.id, text: "!say this candle please" }).delivered,
      false,
    );

    clock.tick(7_000);
    const delivered = game.recordMessage({
      userId: alice.id,
      text: "I lit a candle because it was dark",
    });
    assert.equal(delivered.delivered, true);
    assert.equal(game.getCard(alice.sessionId).delivered, true);
    assert.equal(cardEvents.length, 1);
    assert.equal(cardEvents[0].sessionId, alice.sessionId);
    assert.equal(cardEvents[0].card.delivered, true);
    assert.equal(publicEvents.some(({ type }) => type === "smuggle"), false);
    assert.equal(publicEvents.some(({ type }) => type === "decoy"), false);
    const smuggleId = game.currentRound.smuggle.id;
    game.recordMessage({ userId: alice.id, text: "That candle is still going" });
    assert.equal(game.currentRound.smuggle.id, smuggleId);

    game.recordMessage({ userId: bruno.id, text: "That room sounds cozy" });
    game.recordMessage({ userId: bruno.id, text: "Very cozy indeed" });
    game.recordMessage({ userId: alice.id, text: "It really was nice" });
    game.recordMessage({ userId: chloe.id, text: "I missed that message" });
    game.beginVote();
    const { reveal } = game.finishVote();

    assert.equal(reveal.smuggled, true);
    assert.equal(reveal.evidence.text, "I lit a candle because it was dark");
    assert.equal(reveal.evidence.elapsed, "0:12");
    assert.equal(
      reveal.evidence.text.slice(reveal.evidence.index, reveal.evidence.index + reveal.evidence.length),
      "candle",
    );
    assert.equal(reveal.readerCount, 2);
    assert.match(reveal.caption, /^0:12 into the round\. 2 people read this\./);
    assert.equal(reveal.messages.length, 9);
    assert.equal(reveal.accidentalDecoys.length, 1);
    assert.match(reveal.accidentalDecoys[0].caption, /said it too, by accident/);
    assert.equal(reveal.verdict, "GOT AWAY");
    assert.equal(reveal.scoreChanges.find(({ player }) => player.id === alice.id).delta, 3);
    assert.equal(reveal.leaderboard[0].player.id, alice.id);
    assert.match(reveal.botMessage, /smuggled at 0:12/);
  });

  test("does not award escape points when the word was never smuggled", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.beginVote();
    game.vote(alice.id, bruno.id);
    game.vote(bruno.id, chloe.id);
    const result = game.vote(chloe.id, bruno.id);

    assert.equal(result.state, PHASES.REVEAL);
    assert.equal(game.lastReveal.smuggled, false);
    assert.equal(game.lastReveal.caption, "The word never made it out.");
    assert.equal(game.lastReveal.verdict, "WORD NEVER LANDED");
    assert.equal(game.scores.get(alice.id), 0);
  });
});

describe("voting and scoring", () => {
  test("ignores self-votes, replaces prior votes, and scores a caught Imposter", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.recordMessage({ userId: alice.id, text: "I lit a candle last night" });
    game.beginVote();

    assert.equal(game.vote(bruno.id, chloe.id).replaced, false);
    assert.equal(game.vote(bruno.id, alice.id).replaced, true);
    assert.deepEqual(game.vote(bruno.id, bruno.id), {
      ok: false,
      reason: "self_vote",
    });
    assert.equal(game.votes.get(bruno.id), alice.id);
    assert.deepEqual(game.vote("not-playing", alice.id), {
      ok: false,
      reason: "not_a_player",
    });

    game.vote(chloe.id, alice.id);
    const lastVote = game.vote(alice.id, bruno.id);
    assert.equal(lastVote.state, PHASES.REVEAL);
    assert.equal(game.lastReveal.caught, true);
    assert.equal(game.lastReveal.verdict, "CAUGHT");
    assert.equal(game.scores.get(alice.id), 0);
    assert.equal(game.scores.get(bruno.id), 1);
    assert.equal(game.scores.get(chloe.id), 1);
  });

  test("uses a caught caption only when someone noticed the landed word", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.recordMessage({ userId: alice.id, text: "I lit a candle last night" });
    game.recordMessage({ userId: bruno.id, text: "That sounds pretty cozy" });
    game.beginVote();
    game.vote(alice.id, bruno.id);
    game.vote(bruno.id, alice.id);
    game.vote(chloe.id, alice.id);

    assert.equal(game.lastReveal.verdict, "CAUGHT");
    assert.match(game.lastReveal.caption, /1 person read this\. Someone noticed\.$/);
  });

  test("uses WORD NEVER LANDED while rewarding detectives who voted right", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.beginVote();
    game.vote(alice.id, bruno.id);
    game.vote(bruno.id, alice.id);
    game.vote(chloe.id, alice.id);

    assert.equal(game.lastReveal.smuggled, false);
    assert.equal(game.lastReveal.verdict, "WORD NEVER LANDED");
    assert.equal(game.lastReveal.outcome, "word_never_landed");
    assert.equal(game.scores.get(alice.id), 0);
    assert.equal(game.scores.get(bruno.id), 1);
    assert.equal(game.scores.get(chloe.id), 1);
    assert.match(game.lastReveal.botMessage, /WORD NEVER LANDED\. \+0$/);
  });

  test("a tied highest tally still catches the Imposter", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.recordMessage({ userId: alice.id, text: "This candle smells lovely" });
    game.beginVote();
    game.vote(alice.id, bruno.id);
    game.vote(bruno.id, chloe.id);
    game.vote(chloe.id, alice.id);

    assert.equal(game.lastReveal.tallies.find(({ player }) => player.id === alice.id).votes, 1);
    assert.equal(game.lastReveal.caught, true);
    assert.equal(game.scores.get(chloe.id), 1);
  });
});
