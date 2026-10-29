import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { cardRenderSignature, cardScreen, voteProgress } from "../public/card-view.js";

describe("card screen selection", () => {
  test("selects every joining state, including wrong-account recovery", () => {
    assert.equal(cardScreen({ linked: false }), "join-name");
    assert.equal(cardScreen({ linked: false, pendingClaim: { code: "A2B3" } }), "join-code");
    assert.equal(cardScreen({
      linked: false,
      pendingClaim: { code: "A2B3", error: "this code belongs to another account" },
    }), "join-wrong");
  });

  test("keeps reveal hold ahead of results and roles", () => {
    assert.equal(cardScreen({ linked: true, role: "IMPOSTER", revealHold: true }), "reveal-hold");
    assert.equal(cardScreen({ linked: true, role: "DETECTIVE", showResult: true }), "result");
    assert.equal(cardScreen({ linked: true, role: "IMPOSTER", state: "VOTE" }), "vote");
  });

  test("computes a draining vote progress without overflowing", () => {
    assert.equal(voteProgress({ phaseDurationMs: 30_000, remainingMs: 19_000 }), 19 / 30);
    assert.equal(voteProgress({ phaseDurationMs: 30_000, remainingMs: 2_000 }, 3_000), 0);
    assert.equal(voteProgress({ phaseDurationMs: 30_000, remainingMs: 40_000 }), 1);
  });

  test("ignores unrelated featured-table chat when deciding whether to redraw the card", () => {
    const base = {
      linked: true,
      state: "ROUND",
      roundNumber: 3,
      role: "DETECTIVE",
      onStream: true,
      messages: [{ id: "one", text: "hello", player: { id: "p1" } }],
    };
    assert.equal(cardRenderSignature(base), cardRenderSignature({
      ...base,
      remainingMs: 12_000,
      messages: [...base.messages, { id: "two", text: "unrelated chat", player: { id: "p2" } }],
    }));
    assert.notEqual(cardRenderSignature(base), cardRenderSignature({ ...base, delivered: true }));
  });
});
