import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  shouldAnimateVoteBanner,
  updateCompactLobbyClock,
  overlayRenderPlan,
  voteInstruction,
  votePlayerLayout,
  voteRowOptions,
} from "../public/overlay-state.js";

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
    namePadding: 0,
    voteCountPlacement: "secondary-line",
  });
});

test("the 854 by 480 vote layout preserves all twelve player names", async () => {
  const names = [
    "drovosek7777", "cydshop", "romabuilds", "pixel_mara", "quietfox", "tomtom_irl",
    "nightbyte", "akira_k", "lumi", "bigsalad", "jo_plays", "marrow",
  ];
  for (const login of names) {
    const layout = votePlayerLayout({ login }, { votes: 1, chatVotes: 2 }, 5, 7, true);
    assert.equal(layout.playerName, login);
    assert.equal(layout.namePadding, 0);
    assert.equal(layout.voteCountPlacement, "secondary-line");
  }
  const css = await readFile(new URL("../public/overlay.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.vote-row \.player-name\{padding-right:22px/);
  assert.match(css, /\.vote-banner>span\{[^}]*white-space:nowrap/);
});

test("vote instructions follow the table's Imposter count", () => {
  assert.deepEqual(voteInstruction(1), {
    boardMeta: "TOP VOTE ACCUSED",
    outcome: "top vote is accused",
    howTo: "Type a player's number in chat, or tap them on your card · top vote is accused",
    bannerLines: ["Type a player's number in chat", "or tap your card · top vote accused"],
  });
  assert.equal(voteInstruction(2).outcome, "top 2 are accused");
  assert.equal(voteInstruction(2).bannerLines.length, 2);
});

test("the VOTE banner animates only when entering VOTE", async () => {
  const firstVote = overlayRenderPlan({ state: "ROUND" }, { state: "VOTE" });
  const voteUpdate = overlayRenderPlan({ state: "VOTE" }, { state: "VOTE", crowdVote: 2 });
  assert.equal(shouldAnimateVoteBanner(firstVote), true);
  assert.equal(shouldAnimateVoteBanner(voteUpdate), false);
  const renderer = await readFile(new URL("../public/overlay.js", import.meta.url), "utf8");
  assert.match(renderer, /renderVote\(next, shouldAnimateVoteBanner\(plan\)\)/);
});

test("the compact lobby clock refreshes as remaining time changes", async () => {
  const target = { textContent: "" };
  assert.equal(updateCompactLobbyClock(target, 61_000), true);
  assert.equal(target.textContent, "1:01");
  assert.equal(updateCompactLobbyClock(target, 59_000), true);
  assert.equal(target.textContent, "0:59");
  assert.equal(updateCompactLobbyClock(null, 58_000), false);
  const renderer = await readFile(new URL("../public/overlay.js", import.meta.url), "utf8");
  assert.match(renderer, /updateCompactLobbyClock\(\$\("#compact-lobby-clock"\), ms\)/);
});
