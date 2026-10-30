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

    const rejected = game.claim(code, "mallory", "user-9");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "name_mismatch");
    assert.equal(rejected.message, "@mallory this code was made for @alice. Open the card and type your own Twitch name");
    assert.equal(game.getPendingClaim("browser-1").error, rejected.message);
    assert.equal(game.players.size, 0);
    assert.equal(game.claim(code, "ALICE", "user-1").ok, true);
  });

  test("a replacement claim code invalidates the prior pending code", () => {
    const { game } = createGame();
    const first = game.createClaim("browser-1", "wrong_name");
    const second = game.createClaim("browser-1", "alice");
    assert.notEqual(second.code, first.code);
    assert.equal(game.claim(first.code, "wrong_name", "user-9").reason, "invalid_code");
    assert.equal(game.getPendingClaim("browser-1").login, "alice");
    assert.equal(game.claim(second.code, "alice", "user-1").ok, true);
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
  test("lobby state exposes its live countdown", () => {
    const { clock, game } = createGame();
    game.start();
    assert.equal(game.getPublicState().remainingMs, DEFAULT_DURATIONS.lobby);
    clock.tick(1_000);
    assert.equal(game.getPublicState().remainingMs, DEFAULT_DURATIONS.lobby - 1_000);
    clock.tick(DEFAULT_DURATIONS.lobby - 1_000);
    assert.equal(game.state, PHASES.LOBBY);
    assert.equal(game.getPublicState().remainingMs, DEFAULT_DURATIONS.lobby);
  });

  test("a host-controlled lobby exposes no fake deadline", () => {
    const { clock } = createGame();
    const game = new Game({ clock, autoStartLobby: false });
    game.start();
    const state = game.getPublicState();
    assert.equal(state.lobbyAutoStart, false);
    assert.equal(state.phaseEndsAt, null);
    assert.equal(state.remainingMs, 0);
    clock.tick(DEFAULT_DURATIONS.lobby * 2);
    assert.equal(game.state, PHASES.LOBBY);
  });

  test("a real round exposes the new-round signal for four seconds", () => {
    const { clock, game } = createGame();
    claimPlayers(game);
    game.start();
    game.go();
    assert.equal(game.getPublicState().newRound, true);
    clock.tick(3_999);
    assert.equal(game.getPublicState().newRound, true);
    clock.tick(1);
    assert.equal(game.getPublicState().newRound, false);
  });

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
    assert.equal(game.state, PHASES.LOBBY);
    clock.tick(DEFAULT_DURATIONS.lobby);
    assert.equal(game.state, PHASES.ROUND);
    assert.notEqual(game.currentRound.impostorId, "guest");
  });

  test("never selects an unclaimed player or the same Imposter twice in a row", () => {
    const { game } = createGame();
    game.join({ id: "guest", login: "guest" });
    claimPlayers(game);
    game.start();
    game.go({ word: "candle", category: "home" });
    assert.equal(game.getPublicState().phaseEndsAt, DEFAULT_DURATIONS.round);
    assert.equal(game.getPublicState().remainingMs, DEFAULT_DURATIONS.round);
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
    assert.equal(game.getPublicState().remainingMs, DEFAULT_DURATIONS.vote);
    clock.tick(DEFAULT_DURATIONS.vote);
    assert.equal(game.state, PHASES.VOTE);
    assert.equal(game.getPublicState().remainingMs, 0);
    clock.tick(DEFAULT_DURATIONS.voteGrace);
    assert.equal(game.state, PHASES.REVEAL);
    clock.tick(DEFAULT_DURATIONS.revealOne);
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

  test("player numbers follow join order and stay stable across rounds", () => {
    const { game } = createGame();
    const players = claimPlayers(game, ["alice", "bruno", "chloe", "daria"]);
    assert.deepEqual(players.map(({ id }) => game.players.get(id).number), [1, 2, 3, 4]);
    game.start();
    game.go();
    const firstRound = new Map(game.getPublicState().players.map((player) => [player.id, player.number]));
    game.beginVote();
    game.finishVote();
    game.nextRound();
    game.go();
    for (const player of game.getPublicState().players) assert.equal(player.number, firstRound.get(player.id));
  });

  test("a final champion holds for ten seconds before the card shows session over", () => {
    const { clock, game } = createGame();
    const players = startRound(game);
    game.isFinalRound = true;
    game.beginVote();
    const finished = game.finishVote();
    assert.equal(finished.revealDuration, DEFAULT_DURATIONS.revealOne + DEFAULT_DURATIONS.championHold);
    clock.tick(finished.revealDuration);
    assert.equal(game.getPublicState().sessionOver, true);
    clock.tick(DEFAULT_DURATIONS.cardResultDelay);
    assert.equal(game.getCard(players[0].sessionId).showResult, true);
    assert.ok(game.getCard(players[0].sessionId).result.champion);
    clock.tick(DEFAULT_DURATIONS.championHold);
    assert.equal(game.getCard(players[0].sessionId).sessionOver, true);
    clock.tick(DEFAULT_DURATIONS.lobby);
    assert.equal(game.state, PHASES.LOBBY, "a finished final must not auto-deal another round");
  });

  test("a demo can advertise an eight-second next-session pause after the final", () => {
    const { clock, game } = createGame();
    startRound(game);
    game.isFinalRound = true;
    game.beginVote();
    const finished = game.finishVote();
    clock.tick(finished.revealDuration);
    assert.equal(game.getPublicState().sessionOver, true);
    const queued = game.prepareNextSession(8_000);
    assert.equal(queued.ok, true);
    assert.equal(game.getPublicState().nextSessionStartsAt, clock.now() + 8_000);
    game.go();
    assert.equal(game.getPublicState().nextSessionStartsAt, null);
  });

  test("a one-table showcase can end after its normal rounds without replaying a final", () => {
    const { game } = createGame();
    startRound(game);
    game.beginVote();
    game.finishVote();
    game.nextRound();
    assert.equal(game.completeSession().ok, true);
    assert.equal(game.state, PHASES.LOBBY);
    assert.equal(game.sessionOver, true);
    assert.equal(game.prepareNextSession(8_000).ok, true);
  });

  test("equal leaderboard scores share equal competition ranks", () => {
    const { game } = createGame();
    const players = claimPlayers(game, ["alpha", "bravo", "charlie", "delta"]);
    game.scores.set(players[0].id, 5);
    game.scores.set(players[1].id, 3);
    game.scores.set(players[2].id, 3);
    game.scores.set(players[3].id, 1);
    const entries = game.getPublicState().leaderboard;
    assert.deepEqual(entries.map(({ rank }) => rank), [1, 2, 2, 4]);
  });
});

describe("round messages and reveal payload", () => {
  test("private cards hold the result until the reveal ends plus six seconds", () => {
    const { clock, game } = createGame();
    let revealEvent;
    game.once("reveal", (event) => { revealEvent = event; });
    const [alice, bruno] = startRound(game);
    game.recordMessage({ userId: alice.id, text: "I lit a candle last night" });
    game.beginVote();
    game.vote(bruno.id, alice.id);
    game.finishVote();
    assert.equal(revealEvent.revealHoldMs, DEFAULT_DURATIONS.revealOne + DEFAULT_DURATIONS.cardResultDelay);
    assert.equal(revealEvent.caseFileDelayMs, DEFAULT_DURATIONS.revealOne);

    const duringReveal = game.getCard(bruno.sessionId);
    assert.equal(duringReveal.revealHold, true);
    assert.equal("result" in duringReveal, false);
    clock.tick(DEFAULT_DURATIONS.revealOne);
    assert.equal(game.state, PHASES.LOBBY);
    assert.equal(game.getCard(bruno.sessionId).revealHold, true);
    clock.tick(DEFAULT_DURATIONS.cardResultDelay - 1);
    assert.equal(game.getCard(bruno.sessionId).revealHold, true);
    clock.tick(1);
    const released = game.getCard(bruno.sessionId);
    assert.equal(released.showResult, true);
    assert.equal(released.role, "DETECTIVE");
    assert.equal(released.voteTarget.id, alice.id);
    assert.equal(released.voteWasRight, true);
    assert.equal(released.roundPoints, 1);
    assert.equal(released.rank, 1, "equal scores share the same competition rank");
    assert.ok(released.result.imposters.length > 0);
  });

  test("a broadcaster voice chunk can smuggle the word and gets a voice reveal", () => {
    const { game } = createGame();
    const [alice, bruno] = startRound(game);

    assert.deepEqual(
      game.recordMessage({
        userId: "not-in-the-roster",
        text: "I lit a candle beside the monitor",
        source: "voice",
      }),
      { ok: false, reason: "invalid_message" },
    );

    const spoken = game.recordMessage({
      userId: alice.login,
      text: "I lit a candle beside the monitor",
      source: "voice",
    });
    assert.equal(spoken.delivered, true);
    assert.equal(spoken.message.source, "voice");

    game.beginVote();
    game.vote(bruno.id, alice.id);
    const { reveal } = game.finishVote();
    assert.equal(reveal.evidence.source, "voice");
    assert.equal(
      reveal.caption,
      "Said out loud on stream. Someone noticed.",
    );
    assert.match(reveal.botMessage, /said out loud 0:00 into the round/);
    assert.doesNotMatch(reveal.botMessage, /I lit a candle/);
  });

  test("an unnoticed voice smuggle says it was spoken aloud", () => {
    const { game } = createGame();
    const [alice] = startRound(game);
    game.recordMessage({
      userId: alice.id,
      text: "I lit a candle beside the monitor",
      source: "voice",
    });
    game.beginVote();
    const { reveal } = game.finishVote();
    assert.equal(
      reveal.caption,
      "Said out loud on stream. Nobody noticed.",
    );
  });

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
    assert.deepEqual(
      game.getPublicState().round.latestMessages.map(({ text }) => text),
      ["Very cozy indeed", "It really was nice", "I missed that message"],
    );
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
    assert.equal(reveal.accidentalDecoys[0].ribbon, "Most suspicious civilian");
    assert.match(reveal.accidentalDecoys[0].caption, /said it too, by accident/);
    assert.equal(reveal.verdict, "GOT AWAY");
    assert.equal(reveal.scoreChanges.find(({ player }) => player.id === alice.id).delta, 3);
    assert.equal(reveal.leaderboard[0].player.id, alice.id);
    assert.match(reveal.botMessage, /hidden 0:12 into the round in their message/);
  });

  test("does not award escape points when the word was never smuggled", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.beginVote();
    game.vote(alice.id, bruno.id);
    game.vote(bruno.id, chloe.id);
    const result = game.vote(chloe.id, bruno.id);
    assert.equal(result.state, PHASES.REVEAL);
    assert.equal(result.allVotesIn, true);
    assert.equal(game.lastReveal.smuggled, false);
    assert.equal(game.lastReveal.caption, "The word never made it out.");
    assert.equal(game.lastReveal.verdict, "WORD NEVER LANDED");
    assert.equal(game.scores.get(alice.id), 0);
  });
});

describe("voting and scoring", () => {
  test("saves a number vote during ROUND, replies once, and carries it into VOTE", () => {
    const { game } = createGame();
    const [alice, bruno] = startRound(game);
    const aliceNumber = game.players.get(alice.id).number;

    const first = game.vote(bruno.id, { number: aliceNumber });
    assert.equal(first.early, true);
    assert.equal(first.shouldReply, true);
    assert.equal(first.targetNumber, aliceNumber);
    assert.equal(game.vote(bruno.id, { number: aliceNumber }).shouldReply, false);
    assert.equal(game.getCard(bruno.sessionId).voteSavedEarly, true);
    assert.equal(game.getCard(bruno.sessionId).earlyVoteTargetNumber, aliceNumber);
    assert.equal(game.getPublicState().round.voteSavedEarly[bruno.id], true);

    game.beginVote();
    assert.equal(game.currentRound.votes.get(bruno.id), alice.id);
  });

  test("accepts a changed vote during the six-second silent grace", () => {
    const { clock, game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.beginVote();
    clock.tick(DEFAULT_DURATIONS.vote);
    assert.equal(game.state, PHASES.VOTE);
    assert.equal(game.getPublicState().remainingMs, 0);
    assert.equal(game.vote(bruno.id, { number: game.players.get(alice.id).number }).ok, true);
    clock.tick(5_999);
    assert.equal(game.vote(bruno.id, { number: game.players.get(chloe.id).number }).replaced, true);
    clock.tick(1);
    assert.equal(game.state, PHASES.REVEAL);
  });

  test("vote messages never become evidence, slips, smuggles, or decoys", () => {
    const { game } = createGame();
    const [alice] = startRound(game, { word: "candle", category: "home" });
    for (const text of ["1", "#1", "!1", "!vote 1", "!vote alice"]) {
      const result = game.recordMessage({ userId: alice.id, text });
      assert.equal(result.voteMessage, true);
      assert.equal(result.visible, false);
    }
    assert.equal(game.currentRound.messages.length, 0);
    assert.equal(game.currentRound.smuggle, null);
    assert.equal(game.currentRound.decoys.length, 0);
  });

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
    assert.equal(game.vote("not-playing", alice.id).reason, "not_seated");

    game.vote(chloe.id, alice.id);
    const lastVote = game.vote(alice.id, bruno.id);
    assert.equal(lastVote.state, PHASES.REVEAL);
    assert.equal(lastVote.allVotesIn, true);
    assert.equal(game.lastReveal.caught, true);
    assert.equal(game.lastReveal.verdict, "CAUGHT");
    assert.equal(game.scores.get(alice.id), 1);
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
    game.finishVote();

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
    game.finishVote();

    assert.equal(game.lastReveal.smuggled, false);
    assert.equal(game.lastReveal.verdict, "WORD NEVER LANDED");
    assert.equal(game.lastReveal.outcome, "word_never_landed");
    assert.equal(game.scores.get(alice.id), 0);
    assert.equal(game.scores.get(bruno.id), 1);
    assert.equal(game.scores.get(chloe.id), 1);
    assert.match(game.lastReveal.botMessage, /WORD NEVER LANDED\. \+0$/);
  });

  test("a tied highest tally lets the Imposter get away", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.recordMessage({ userId: alice.id, text: "This candle smells lovely" });
    game.beginVote();
    game.vote(alice.id, bruno.id);
    game.vote(bruno.id, chloe.id);
    game.vote(chloe.id, alice.id);
    game.finishVote();

    assert.equal(game.lastReveal.tallies.find(({ player }) => player.id === alice.id).votes, 1);
    assert.equal(game.lastReveal.caught, false);
    assert.equal(game.lastReveal.verdict, "GOT AWAY");
    assert.equal(game.scores.get(chloe.id), 0);
    assert.equal(game.scores.get(alice.id), 3);
  });

  test("crowd votes break seated ties but cannot decide without seated votes", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    game.recordMessage({ userId: alice.id, text: "This candle smells lovely" });
    game.beginVote();
    game.vote(alice.id, chloe.id);
    game.vote(bruno.id, alice.id);
    const crowd = game.vote({ userId: "crowd-1", login: "viewer", transport: "twitch" }, { number: 1 });
    assert.equal(crowd.ok, true);
    assert.equal(crowd.crowd, true);
    assert.equal(game.getTallies().find(({ player }) => player.id === alice.id).chatVotes, 1);
    game.vote(chloe.id, bruno.id);
    assert.equal(game.lastReveal.verdict, "CAUGHT");
    assert.match(game.lastReveal.caseFileMessage, / · caught$/);

    const second = createGame().game;
    const [nextAlice] = startRound(second);
    second.recordMessage({ userId: nextAlice.id, text: "This candle smells lovely" });
    second.beginVote();
    second.vote({ userId: "crowd-2", login: "viewer_two", transport: "twitch" }, { number: 1 });
    second.finishVote();
    assert.equal(second.lastReveal.verdict, "GOT AWAY");
  });

  test("reveal includes one concise case-file line for chat", () => {
    const { clock, game } = createGame();
    const [alice, bruno] = startRound(game);
    clock.tick(72_000);
    game.recordMessage({ userId: alice.id, text: "This candle smells lovely" });
    game.recordMessage({ userId: bruno.id, text: "That sounds cozy" });
    game.beginVote();
    game.finishVote();
    assert.equal(game.lastReveal.caseFileMessage, "Round 1: CANDLE slipped in at 1:12 · 1 read it · nobody noticed");
  });

  test("closes voting as soon as every seated player has voted", () => {
    const { game } = createGame();
    const [alice, bruno, chloe] = startRound(game);
    let event;
    game.once("allVotesIn", (payload) => { event = payload; });
    game.beginVote();
    assert.equal(game.vote(alice.id, bruno.id).state, PHASES.VOTE);
    assert.equal(game.vote(bruno.id, alice.id).state, PHASES.VOTE);
    const finalVote = game.vote(chloe.id, alice.id);
    assert.equal(finalVote.allVotesIn, true);
    assert.equal(finalVote.state, PHASES.REVEAL);
    assert.equal(event.message, "ALL VOTES IN");
    assert.equal(game.getPublicState().round.allVotesIn, true);
  });
});
