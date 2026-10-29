import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";

import Game, { PHASES, seatPlayers, selectVoteAccused } from "../src/game.js";

const TEST_WORDS = [
  { word: "candle", category: "home" },
  { word: "rocket", category: "space" },
  { word: "tiger", category: "animals" },
  { word: "piano", category: "music" },
];

const TEST_CLOCK = {
  now: () => 0,
  setTimeout: () => Symbol("timer"),
  clearTimeout() {},
};

function addClaimedPlayers(game, count) {
  const players = [];
  for (let index = 0; index < count; index += 1) {
    const player = { id: `p${index}`, login: `player_${String(index).padStart(3, "0")}` };
    game.join(player);
    game.players.get(player.id).claimed = true;
    players.push(player);
  }
  return players;
}

function startGame(count, options = {}) {
  const game = new Game({ clock: TEST_CLOCK, random: () => 0, words: TEST_WORDS, ...options });
  const players = addClaimedPlayers(game, count);
  game.start();
  assert.equal(game.go().ok, true);
  return { game, players };
}

function tablePlayers(game, tableId = 1) {
  return [...game.tables.get(tableId).roster.values()];
}

describe("table seating and roles", () => {
  test("uses a shorter reveal for one Imposter and the full reveal for two", () => {
    const one = startGame(3).game;
    one.beginVote();
    assert.equal(one.finishVote().revealDuration, 12_000);
    assert.equal(one.getPublicState().phaseDurationMs, 12_000);

    const two = startGame(10).game;
    two.beginVote();
    assert.equal(two.finishVote().revealDuration, 20_000);
    assert.equal(two.getPublicState().phaseDurationMs, 20_000);
  });

  test("balances every supported seating size without tiny tables", () => {
    const cases = new Map([
      [3, [3]],
      [4, [4]],
      [12, [12]],
      [13, [7, 6]],
      [30, [10, 10, 10]],
      [200, [12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 11, 11, 11, 11]],
    ]);
    for (const [count, expected] of cases) {
      const players = Array.from({ length: count }, (_, id) => ({ id }));
      const sizes = seatPlayers(players, () => 0).map((table) => table.length);
      assert.deepEqual(sizes, expected);
      assert.ok(sizes.every((size) => size >= 3 && size <= 12));
    }
  });

  test("deals one or two Imposters with distinct categories per table", () => {
    for (const count of [3, 9, 10, 12, 30]) {
      const { game } = startGame(count);
      for (const table of game.tables.values()) {
        assert.equal(table.impostors.length, table.roster.size >= 10 ? 2 : 1);
        assert.equal(new Set(table.impostors.map(({ category }) => category)).size, table.impostors.length);
        const owner = [...table.roster.values()][0];
        game.sessions.set(`copy-${count}-${table.id}`, { userId: owner.id, linkedAt: 0 });
        assert.equal(game.getCard(`copy-${count}-${table.id}`).impostorCount, table.impostors.length);
      }
      game.reset();
    }
  });

  test("avoids consecutive Imposters and rotates prior featured players away", () => {
    const { game } = startGame(30);
    const oldImpostors = new Set([...game.tables.values()].flatMap((table) => (
      table.impostors.map(({ playerId }) => playerId)
    )));
    const oldFeatured = new Set(game.currentRound.roster.keys());
    game.beginVote();
    game.finishVote();
    game.nextRound();
    game.go();
    const newImpostors = [...game.tables.values()].flatMap((table) => (
      table.impostors.map(({ playerId }) => playerId)
    ));
    assert.ok(newImpostors.every((id) => !oldImpostors.has(id)));
    assert.equal(game.featuredTableId, 2);
    assert.ok([...game.currentRound.roster.keys()].every((id) => !oldFeatured.has(id)));
    assert.deepEqual([...game.tables.values()].map(({ roster }) => roster.size), [10, 10, 10]);
  });
});

describe("table evidence and privacy", () => {
  test("isolates evidence and exposes only compact details for other tables", () => {
    const { game } = startGame(13, {
      wordPicker: ({ tableId }) => tableId === 1
        ? { word: "candle", category: "home" }
        : { word: "rocket", category: "space" },
    });
    const tableOne = game.tables.get(1);
    const tableTwo = game.tables.get(2);
    const tableTwoImpostor = tableTwo.roster.get(tableTwo.impostorId);
    game.recordMessage({
      userId: tableTwoImpostor.id,
      text: "I placed a candle beside the window",
    });
    assert.equal(tableOne.impostors[0].smuggle, null);
    assert.equal(tableTwo.impostors[0].smuggle, null);
    game.recordMessage({
      userId: tableTwoImpostor.id,
      text: "that rocket launch looked incredible tonight",
    });
    assert.ok(tableTwo.impostors[0].smuggle);
    assert.equal(tableOne.messages.length, 0);

    const serialized = JSON.stringify(game.getPublicState());
    assert.equal(serialized.includes("candle"), false);
    assert.equal(serialized.includes("rocket"), false);
    assert.deepEqual(game.getPublicState().tables, [
      { id: 1, playerCount: 7 },
      { id: 2, playerCount: 6 },
    ]);
  });

  test("counts unseated chatters as crowd without recording evidence", () => {
    const { game } = startGame(3);
    const result = game.recordMessage({
      userId: "crowd-1",
      login: "crowd_one",
      text: "I lit a candle beside the window",
    });
    assert.deepEqual(result, { ok: true, crowd: true, counted: true });
    assert.equal(game.currentRound.messages.length, 0);
    assert.equal(game.getPublicState().crowdCount, 1);
  });

  test("a private card contains only its own table view", () => {
    const { game } = startGame(13, {
      wordPicker: ({ tableId }) => tableId === 1
        ? { word: "candle", category: "home" }
        : { word: "rocket", category: "space" },
    });
    const owner = [...game.tables.get(1).roster.values()][2];
    const other = [...game.tables.get(2).roster.values()][2];
    game.sessions.set("private-session", { userId: owner.id, linkedAt: 0 });
    game.recordMessage({ userId: owner.id, text: "only table one should read this" });
    game.recordMessage({ userId: other.id, text: "only table two should read this" });
    const card = game.getCard("private-session");
    assert.equal(card.tableId, 1);
    assert.equal(card.tableMates.length, 7);
    assert.deepEqual(card.messages.map(({ text }) => text), ["only table one should read this"]);
    assert.equal(JSON.stringify(card).includes("rocket"), false);
  });

  test("side-table Twitch chat is crowd chatter while card chat is evidence", () => {
    const { game } = startGame(13);
    const side = game.tables.get(2);
    const impostor = side.roster.get(side.impostorId);
    const spoken = `this ${side.word} fits naturally here`;

    assert.deepEqual(game.recordMessage({
      userId: impostor.id,
      text: spoken,
      transport: "twitch",
    }), { ok: true, crowd: true, counted: true });
    assert.equal(side.messages.length, 0);
    assert.equal(side.impostors[0].smuggle, null);

    const delivered = game.recordMessage({
      userId: impostor.id,
      text: spoken,
      transport: "card",
    });
    assert.equal(delivered.delivered, true);
    assert.equal(side.messages.length, 1);
    assert.equal(side.impostors[0].smuggle.transport, "card");
  });
});

describe("streamer seating", () => {
  function streamerGame(hostPlays = true) {
    const game = new Game({
      clock: TEST_CLOCK,
      random: () => 0,
      words: TEST_WORDS,
      streamerLogin: "streamer",
      hostPlays,
    });
    const streamer = { id: "streamer-id", login: "streamer" };
    game.join(streamer);
    game.players.get(streamer.id).claimed = true;
    addClaimedPlayers(game, 24);
    game.start();
    assert.equal(game.go().ok, true);
    return { game, streamer };
  }

  test("always seats a participating streamer at the featured table and moves them with it", () => {
    const { game, streamer } = streamerGame();
    assert.equal(game.tables.get(1).roster.size, 13);
    assert.equal(game.playerTables.get(streamer.id), 1);
    const assignment = game.tables.get(1).impostors.find(({ playerId }) => playerId === streamer.id);
    assert.ok(assignment);

    assert.equal(game.featureTable(2).ok, true);
    assert.equal(game.playerTables.get(streamer.id), 2);
    assert.equal(game.tables.get(1).roster.has(streamer.id), false);
    assert.equal(game.tables.get(2).roster.has(streamer.id), true);
    assert.equal(game.recordMessage({
      userId: streamer.id,
      source: "voice",
      text: `I worked ${assignment.word} into this sentence`,
    }).delivered, true);
  });

  test("host-plays off keeps the streamer out and persists across reset", () => {
    const { game, streamer } = streamerGame(false);
    assert.equal(game.playerTables.has(streamer.id), false);
    assert.equal([...game.tables.values()].some(({ roster }) => roster.has(streamer.id)), false);
    game.reset();
    assert.equal(game.getPublicState().hostPlays, false);
  });
});

describe("live accusations", () => {
  function accusationGame(count = 3) {
    const setup = startGame(count);
    const table = setup.game.tables.get(1);
    const impostor = table.roster.get(table.impostorId);
    const detectives = [...table.roster.values()].filter(({ id }) => id !== impostor.id);
    return { ...setup, table, impostor, detectives };
  }

  test("busts only after a matching smuggle and spends the accuser's shot", () => {
    const { game, impostor, detectives } = accusationGame();
    let eventPayload = null;
    game.on("busted", (payload) => { eventPayload = payload; });
    game.recordMessage({ userId: impostor.id, text: "this candle smells wonderful tonight" });
    const busted = game.accuse(detectives[0].id, impostor.login, "candles");
    assert.equal(busted.correct, true);
    assert.equal(busted.toast, `@${detectives[0].login} BUSTED @${impostor.login}: CANDLE`);
    assert.equal(eventPayload.toast, busted.toast);
    assert.equal(eventPayload.toastKind, "busted");
    assert.equal(game.getPublicState().round.accusations[0].toast, busted.toast);
    assert.equal(game.scores.get(detectives[0].id), 2);
    assert.deepEqual(game.accuse(detectives[0].id, impostor.login, "candle"), {
      ok: false,
      reason: "already_accused",
    });
    game.beginVote();
    game.finishVote();
    assert.equal(game.lastReveal.verdict, "BUSTED");
    assert.equal(game.scores.get(impostor.id), 1);
  });

  test("wrong word, wrong person, and an accusation before smuggle all miss", () => {
    for (const kind of ["word", "person", "early"]) {
      const { game, impostor, detectives } = accusationGame();
      if (kind !== "early") {
        game.recordMessage({ userId: impostor.id, text: "this candle smells wonderful tonight" });
      }
      const target = kind === "person" ? detectives[1].login : impostor.login;
      const word = kind === "word" ? "rocket" : "candle";
      const miss = game.accuse(detectives[0].id, target, word);
      assert.equal(miss.correct, false);
      assert.equal(miss.toast, `❌ @${detectives[0].login} guessed wrong`);
      assert.equal(game.scores.get(detectives[0].id), 0);
    }
  });

  test("crowd can accuse only at the featured table and only once", () => {
    const { game } = accusationGame(13);
    const featured = game.tables.get(game.featuredTableId);
    const other = game.tables.get(2);
    const otherImpostor = other.roster.get(other.impostorId);
    game.recordMessage({ userId: otherImpostor.id, text: "this candle smells wonderful tonight" });
    const crowd = { userId: "crowd", login: "crowd" };
    assert.equal(game.accuse(crowd, otherImpostor.login, "candle").correct, false);
    game.featureTable(2);
    assert.deepEqual(game.accuse(crowd, otherImpostor.login, "candle"), {
      ok: false,
      reason: "already_accused",
    });

    const secondCrowd = { userId: "crowd-2", login: "crowd_two" };
    assert.equal(game.accuse(secondCrowd, otherImpostor.login, "candle").correct, true);
    assert.equal(game.scores.get(secondCrowd.userId), 2);
    assert.equal(featured.accusations.has(secondCrowd.userId), false);
  });
});

describe("multi-Imposter vote and scoring", () => {
  test("excludes a boundary tie from top-k", () => {
    const tallies = [
      ["a", 5], ["b", 3], ["c", 3], ["d", 1],
    ].map(([id, votes]) => ({ player: { id, login: id }, votes }));
    assert.deepEqual(selectVoteAccused(tallies, 2), ["a"]);
    assert.deepEqual(selectVoteAccused(tallies, 3), ["a", "b", "c"]);
  });

  test("uses chat votes only to break a seated-vote boundary tie", () => {
    const tallies = [
      { player: { id: "a", login: "a" }, votes: 5, chatVotes: 0 },
      { player: { id: "b", login: "b" }, votes: 3, chatVotes: 4 },
      { player: { id: "c", login: "c" }, votes: 3, chatVotes: 2 },
      { player: { id: "d", login: "d" }, votes: 0, chatVotes: 20 },
    ];
    assert.deepEqual(selectVoteAccused(tallies, 2), ["a", "b"]);
    assert.deepEqual(selectVoteAccused(tallies.map((entry) => ({ ...entry, votes: 0 })), 2), []);
  });

  test("chat resolves the part of a multi-slot tie that it actually breaks", () => {
    const tallies = [
      { player: { id: "a", login: "a" }, votes: 3, chatVotes: 5 },
      { player: { id: "b", login: "b" }, votes: 3, chatVotes: 0 },
      { player: { id: "c", login: "c" }, votes: 3, chatVotes: 0 },
    ];
    assert.deepEqual(selectVoteAccused(tallies, 2), ["a"]);
  });

  test("scores escapes, catches, correct votes, busts, and missed words", () => {
    const { game } = startGame(12);
    const table = game.tables.get(1);
    const [first, second] = table.impostors;
    const firstPlayer = table.roster.get(first.playerId);
    const secondPlayer = table.roster.get(second.playerId);
    const detectives = tablePlayers(game).filter(({ id }) => ![first.playerId, second.playerId].includes(id));
    game.recordMessage({ userId: first.playerId, text: `this ${first.word} fits naturally here` });
    game.recordMessage({ userId: second.playerId, text: `this ${second.word} fits naturally here` });
    game.beginVote();
    for (const voter of detectives.slice(0, 3)) game.vote(voter.id, firstPlayer.id);
    for (const voter of detectives.slice(3, 5)) game.vote(voter.id, secondPlayer.id);
    for (const voter of detectives.slice(5, 7)) game.vote(voter.id, detectives[9].id);
    game.finishVote();
    assert.equal(table.reveal.imposters[0].verdict, "CAUGHT");
    assert.equal(table.reveal.imposters[1].verdict, "GOT AWAY");
    assert.equal(game.scores.get(first.playerId), 1);
    assert.equal(game.scores.get(second.playerId), 3);
    assert.ok(detectives.slice(0, 3).every(({ id }) => game.scores.get(id) === 1));

    // The single-table compatibility payload remains the featured Imposter's result.
    assert.equal(game.lastReveal.impostor.id, first.playerId);
    assert.equal(game.lastReveal.imposters.length, 2);
  });
});

describe("final table and performance", () => {
  test("selects one table winner for a single final and then returns to normal", () => {
    const { game } = startGame(30);
    const winners = [...game.tables.values()].map((table, index) => {
      const player = [...table.roster.values()][2];
      game.scores.set(player.id, 20 - index);
      return player.id;
    });
    game.beginVote();
    game.finishVote();
    game.nextRound();
    const result = game.final();
    assert.equal(result.ok, true);
    assert.equal(result.final, true);
    assert.equal(game.tables.size, 1);
    assert.deepEqual(new Set(game.currentRound.roster.keys()), new Set(winners));
    assert.equal(game.getPublicState().crowdCount, 27);
    game.beginVote();
    game.finishVote();
    assert.equal(game.lastReveal.champion.id, winners[0]);
    game.nextRound();
    assert.equal(game.isFinalRound, false);
    assert.equal(game.go().tableCount, 3);
  });

  test("uses the top 12 overall when the previous round had more than 12 tables", () => {
    const { game, players } = startGame(200);
    for (const [index, player] of players.entries()) game.scores.set(player.id, index);
    game.beginVote();
    game.finishVote();
    game.nextRound();
    assert.equal(game.final().ok, true);
    const expected = players.slice(-12).map(({ id }) => id);
    assert.deepEqual(new Set(game.currentRound.roster.keys()), new Set(expected));
  });

  test("finishes a simulated 200-player round in under one second of CPU", () => {
    const game = new Game({ clock: TEST_CLOCK, random: () => 0, words: TEST_WORDS });
    addClaimedPlayers(game, 200);
    game.start();
    const startedAt = performance.now();
    assert.equal(game.go().ok, true);
    for (const table of game.tables.values()) {
      for (const player of table.roster.values()) {
        game.recordMessage({ userId: player.id, text: "an ordinary message for this table" });
      }
    }
    game.beginVote();
    game.finishVote();
    const elapsed = performance.now() - startedAt;
    assert.equal(game.phase, PHASES.REVEAL);
    assert.ok(elapsed < 1_000, `round took ${elapsed.toFixed(1)} ms`);
  });
});
