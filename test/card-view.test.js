import assert from "node:assert/strict";
import { describe, test } from "node:test";

import Game from "../src/game.js";

import {
  cardRenderSignature,
  cardScreen,
  cardVoteInstruction,
  hiddenImpostorCount,
  impostorStatus,
  showRoleTips,
  vibrateIfActivated,
  voteProgress,
} from "../public/card-view.js";

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
    assert.notEqual(cardRenderSignature(base), cardRenderSignature({
      ...base,
      busted: true,
      bustedBy: { id: "p2", login: "quietfox", number: 2 },
    }));
    assert.notEqual(cardRenderSignature(base), cardRenderSignature({ ...base, demoReadOnly: true }));
  });

  test("vibrates only after a user gesture and when the API exists", () => {
    const calls = [];
    const inactive = {
      userActivation: { hasBeenActive: false },
      vibrate: (pattern) => calls.push(pattern),
    };
    assert.equal(vibrateIfActivated(inactive), false);
    assert.equal(vibrateIfActivated({ vibrate: inactive.vibrate }), false);
    assert.equal(vibrateIfActivated({ userActivation: { hasBeenActive: true } }), false);
    assert.deepEqual(calls, []);

    const active = { ...inactive, userActivation: { hasBeenActive: true } };
    assert.equal(vibrateIfActivated(active), true);
    assert.deepEqual(calls, [[80, 60, 80]]);
  });

  test("a busted Imposter card replaces the mission with who caught them", () => {
    assert.deepEqual(impostorStatus({
      delivered: true,
      deliveredAt: "0:47",
      busted: true,
      bustedBy: { login: "quietfox" },
    }), {
      className: "busted",
      status: "BUSTED · caught by @quietfox",
      job: "You were caught. Watch the rest of the round and see how the case closes.",
    });
  });

  test("explicit null server fields never break the card render signature", () => {
    const serverShape = {
      linked: true,
      role: "IMPOSTER",
      bustedBy: null,
      player: null,
      tableMates: [null],
      messages: [null],
      champion: null,
      result: null,
      delivered: false,
    };
    assert.doesNotThrow(() => cardRenderSignature(serverShape));
    assert.equal(cardScreen(null), "join-name");
    assert.equal(impostorStatus(null).status, "Word not sent yet");
    assert.equal(hiddenImpostorCount(null), 0);
    assert.equal(showRoleTips({ busted: true }, "IMPOSTER"), false);
    assert.equal(showRoleTips({ busted: false }, "IMPOSTER"), true);
  });

  test("vote copy only says still hidden after an Imposter was busted", () => {
    assert.equal(cardVoteInstruction({ impostorCount: 1, remainingImpostorCount: 1 }), "Top vote accused");
    assert.equal(cardVoteInstruction({
      impostorCount: 2,
      remainingImpostorCount: 1,
      bustedImpostorIds: ["caught"],
    }), "1 Imposter still hidden · top vote accused");
    assert.equal(cardVoteInstruction({ impostorCount: 2, remainingImpostorCount: 2 }), "2 Imposters · top 2 are accused");
  });

  test("real game cards render every live role and lobby state", () => {
    const codes = ["A2B3", "C4D5", "E6F7", "G8H9", "J2K3", "L4M5", "N6P7", "Q8R9", "S2T3", "U4V5", "W6X7"];
    const game = new Game({
      clock: { now: () => 0, setTimeout: () => Symbol("timer"), clearTimeout() {} },
      random: () => 0,
      codeGenerator: () => codes.shift(),
      words: [{ word: "candle", category: "home" }, { word: "rocket", category: "space" }],
    });
    const sessions = [];
    for (let index = 0; index < 10; index += 1) {
      const login = `card_player_${index}`;
      const sessionId = `card-session-${index}`;
      const claim = game.createClaim({ sessionId, login });
      assert.equal(game.claim({ code: claim.code, login, userId: `card-player-${index}` }).ok, true);
      sessions.push(sessionId);
    }
    game.start();
    const lobby = game.getCard(sessions[0]);
    assert.equal(cardScreen(lobby), "waiting");
    assert.doesNotThrow(() => cardRenderSignature(lobby));

    game.go();
    const table = game.currentRound;
    const [caughtAssignment, hiddenAssignment] = table.impostors;
    const caughtSession = sessions[Number(caughtAssignment.playerId.split("-").at(-1))];
    const hiddenSession = sessions[Number(hiddenAssignment.playerId.split("-").at(-1))];
    const detective = [...table.roster.values()].find(({ id }) => !table.impostors.some(({ playerId }) => playerId === id));
    const detectiveSession = sessions[Number(detective.id.split("-").at(-1))];
    const hiddenCard = game.getCard(hiddenSession);
    const detectiveCard = game.getCard(detectiveSession);
    assert.equal(cardScreen(hiddenCard), "imposter");
    assert.equal(hiddenCard.bustedBy, null);
    assert.equal(cardScreen(detectiveCard), "detective");

    game.recordMessage({ userId: caughtAssignment.playerId, text: `this ${caughtAssignment.word} fits naturally here` });
    game.accuse(detective.id, caughtAssignment.playerId, caughtAssignment.word);
    const bustedCard = game.getCard(caughtSession);
    assert.equal(cardScreen(bustedCard), "imposter");
    assert.equal(bustedCard.busted, true);
    assert.doesNotThrow(() => impostorStatus(bustedCard));

    const spectatorClaim = game.createClaim({ sessionId: "spectator-session", login: "spectator" });
    game.claim({ code: spectatorClaim.code, login: "spectator", userId: "spectator-id" });
    const spectator = game.getCard("spectator-session");
    assert.equal(spectator.role, null);
    assert.equal(cardScreen(spectator), "waiting");

    for (const card of [lobby, hiddenCard, bustedCard, detectiveCard, spectator]) {
      assert.doesNotThrow(() => cardRenderSignature(card));
    }
  });
});
