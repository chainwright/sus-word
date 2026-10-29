import assert from "node:assert/strict";
import { test } from "node:test";

import { overlayRenderPlan } from "../public/overlay-state.js";

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
