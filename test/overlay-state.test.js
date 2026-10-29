import assert from "node:assert/strict";
import { test } from "node:test";

import { overlayRenderPlan, voteRowOptions } from "../public/overlay-state.js";

test("first render accepts null and undefined previous state", () => {
  const state = { state: "VOTE", roundNumber: 3 };
  for (const previous of [null, undefined]) {
    const plan = overlayRenderPlan(previous, state);
    assert.equal(plan.phase, "VOTE");
    assert.equal(plan.resetBase, true);
  }
});

test("a same-key reveal push keeps the active reveal layer", () => {
  const reveal = { state: "REVEAL", roundNumber: 3, round: { reveal: { imposters: [{}, {}] } } };
  const afterJoin = { ...reveal, claimedCount: 9, players: [{ id: "late-player" }] };
  assert.deepEqual(overlayRenderPlan(reveal, afterJoin), {
    phase: "REVEAL",
    phaseChanged: false,
    revealKey: "3:2",
    resetBase: false,
    sameReveal: true,
  });
});

test("crowd vote rows hide zero CHAT counts without taking name-line space", () => {
  assert.equal(voteRowOptions({ votes: 2, chatVotes: 0 }, 5, 7, true).showChat, false);
  assert.deepEqual(voteRowOptions({ votes: 2, chatVotes: 3 }, 5, 6, true), {
    vote: true,
    votes: 2,
    bar: 40,
    chatVotes: 3,
    chatBar: 50,
    showChat: true,
  });
});
