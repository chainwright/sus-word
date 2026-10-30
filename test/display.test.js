import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  phaseRemainingMs,
  readerCountLabel,
  revealPayoffLabel,
  selectLobbyPlayers,
  selectRoundPlayers,
  selectVoteSuspects,
} from "../public/display.js";

test("overlay and card countdowns share the absolute phase deadline", () => {
  assert.equal(phaseRemainingMs({ phaseEndsAt: 15_000, remainingMs: 99_000 }, 1_000, 10_000), 5_000);
  assert.equal(phaseRemainingMs({ remainingMs: 8_000 }, 5_000, 7_000), 6_000);
  assert.equal(phaseRemainingMs({ round: { remainingMs: 4_000 } }, 8_000, 9_500), 2_500);
});

test("reveal reader counts use the singular only for one person", () => {
  assert.equal(readerCountLabel(0), "0 people read\u00a0it");
  assert.equal(readerCountLabel(1), "1 person read\u00a0it");
  assert.equal(readerCountLabel(2), "2 people read\u00a0it");
  assert.equal(revealPayoffLabel({ evidence: { source: "voice" }, readerCount: 0 }), "Said out loud on stream");
  assert.equal(revealPayoffLabel({ evidence: { source: "chat" }, readerCount: 8 }), "8 people read\u00a0it");
});

const players = Array.from({ length: 12 }, (_, index) => ({
  id: `p${index + 1}`,
  login: `player_${String(index + 1).padStart(2, "0")}`,
  joinedAt: index * 100,
}));

describe("large-roster display selection", () => {
  test("round view keeps the eight busiest players and breaks count ties by recency", () => {
    const counts = Object.fromEntries(players.map((player, index) => [player.id, index % 4]));
    const recency = Object.fromEntries(players.map((player, index) => [player.id, index]));

    const selected = selectRoundPlayers(players, counts, recency);

    assert.equal(selected.length, 8);
    assert.deepEqual(
      selected.map(({ id }) => id),
      ["p12", "p8", "p4", "p11", "p7", "p3", "p10", "p6"],
    );
    assert.deepEqual(
      selectLobbyPlayers(players).map(({ id }) => id),
      ["p12", "p11", "p10", "p9", "p8", "p7", "p6", "p5"],
    );
  });

  test("vote view keeps five highest tallies and breaks vote ties alphabetically", () => {
    const tallies = [
      { player: { id: "z", login: "zulu" }, votes: 4 },
      { player: { id: "b", login: "bravo" }, votes: 9 },
      { player: { id: "a", login: "alpha" }, votes: 9 },
      { player: { id: "e", login: "echo" }, votes: 2 },
      { player: { id: "c", login: "charlie" }, votes: 4 },
      { player: { id: "d", login: "delta" }, votes: 3 },
      { player: { id: "f", login: "foxtrot" }, votes: 1 },
    ];

    assert.deepEqual(
      selectVoteSuspects(tallies).map(({ player }) => player.login),
      ["alpha", "bravo", "charlie", "zulu", "delta"],
    );
  });
});
