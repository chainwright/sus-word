import assert from "node:assert/strict";
import { test } from "node:test";

import { revealMarkerPlan } from "../public/watch-state.js";

test("the watch switcher never identifies an Imposter before REVEAL", () => {
  const reveal = { imposters: [{ impostor: { number: 2 } }] };
  assert.equal(revealMarkerPlan({ phase: "ROUND", remainingMs: 20_000, round: { reveal } }), null);
  assert.equal(revealMarkerPlan({ phase: "VOTE", remainingMs: 5_000, round: { reveal } }), null);
});

test("the watch switcher waits for the reveal payoff window", () => {
  const round = { reveal: { imposters: [{ impostor: { number: 2 } }, { impostor: { number: 4 } }] } };
  assert.deepEqual(revealMarkerPlan({ phase: "REVEAL", remainingMs: 12_000, round }), {
    numbers: [2, 4],
    delayMs: 9_000,
  });
  assert.deepEqual(revealMarkerPlan({ phase: "REVEAL", remainingMs: 2_000, round }), {
    numbers: [2, 4],
    delayMs: 0,
  });
});
