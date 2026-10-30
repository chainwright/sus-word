import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  accusationToastDuration,
  bustedRowLabel,
  caseFileHeadline,
  championBoardModel,
  hasLeaderboardScore,
  missedWordCopy,
  roundRule,
  readyPlayersCopy,
  shouldAnimateVoteBanner,
  streamTableLabel,
  syncBoardNoteVisibility,
  updateCompactLobbyClock,
  overlayRenderPlan,
  orderAccusationToasts,
  voteInstruction,
  voteLockLabel,
  voteNameColumnBudget,
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

test("BUSTED toasts keep priority and their full display time", () => {
  const miss = { at: 2, correct: false, toast: "wrong" };
  const busted = { at: 3, correct: true, toast: "BUSTED" };
  assert.deepEqual(orderAccusationToasts([miss, busted]), [busted, miss]);
  assert.equal(accusationToastDuration(busted), 3_000);
  assert.equal(accusationToastDuration(miss), 1_800);
  assert.equal(bustedRowLabel({ accuser: { number: 12, login: "an_extremely_long_name" } }), "BUSTED");
  assert.equal(bustedRowLabel({ accuser: { login: "missing_number" } }), "BUSTED");
  assert.equal(bustedRowLabel(null), "");
});

test("multi-table rounds identify the table currently on stream", () => {
  assert.equal(streamTableLabel({ tableId: 2, tableCount: 3 }), "TABLE 2 OF 3 · ON STREAM");
  assert.equal(streamTableLabel({ tableId: 1, tableCount: 1 }), "");
});

test("a busted player keeps a full-height readable status band", async () => {
  const css = await readFile(new URL("../public/overlay.css", import.meta.url), "utf8");
  assert.match(css, /\.player-row:has\(\.busted-mini\)\{height:50px/);
  assert.match(css, /\.player-row \.busted-mini\{[^}]*height:23px[^}]*font:700 21px\/23px "Courier Prime"/);
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

test("the 854 by 480 vote rows preserve fixture logins and a 73px physical name-column budget", async () => {
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
  assert.deepEqual(voteNameColumnBudget(854, 480), {
    scale: 2 / 3,
    logicalNameWidth: 110.5,
    physicalNameWidth: 73.66666666666666,
  });
});

test("an empty or whitespace-only board note is always hidden", () => {
  const note = { textContent: " \n", hidden: false };
  assert.equal(syncBoardNoteVisibility(note), false);
  assert.equal(note.hidden, true);
  note.textContent = "VOTES ARE LIVE";
  assert.equal(syncBoardNoteVisibility(note), true);
  assert.equal(note.hidden, false);
});

test("board headings stay on one unclipped line with the compact vote title", async () => {
  assert.equal(voteInstruction(1).boardTitle, "WHO HID IT?");
  const css = await readFile(new URL("../public/overlay.css", import.meta.url), "utf8");
  assert.match(css, /\.board-head strong,\.board-head span\{[^}]*white-space:nowrap/);
  assert.match(css, /\.board-head\{[^}]*height:42px[^}]*overflow:hidden/);
});

test("the reveal payoff is at least as large as board player names", async () => {
  const css = await readFile(new URL("../public/overlay.css", import.meta.url), "utf8");
  const playerSize = Number(css.match(/\.player-name\{font-size:(\d+)px\}/)?.[1]);
  const payoffSize = Number(css.match(/\.case-card \.reveal-caption\{[^}]*font:700 (\d+)px/)?.[1]);
  const twoImpostorSize = Number(css.match(/\.reveal-cases\.two \.reveal-caption\{[^}]*font:700 (\d+)px/)?.[1]);
  assert.equal(playerSize, 20);
  assert.ok(payoffSize >= playerSize);
  assert.ok(twoImpostorSize >= playerSize);
});

test("the reveal board promotes the case-file summary to its headline", () => {
  assert.equal(caseFileHeadline({
    caseFileMessage: "Round 3: LEMON slipped in at 1:48 · 9 read it · nobody noticed",
  }), "LEMON slipped in at 1:48 · 9 read\u00a0it · nobody noticed");
  assert.equal(caseFileHeadline({
    word: "lemon",
    impostor: { login: "pixel_mara" },
    evidence: null,
  }), "LEMON never landed · @pixel_mara never found an opening");
  assert.equal(caseFileHeadline({
    word: "lemon",
    elapsed: "0:33",
    verdict: "GOT AWAY",
    evidence: { source: "voice" },
    readerCount: 0,
  }), "LEMON was said out loud at 0:33 · nobody noticed");
});

test("a missed word has one-line stamp copy plus the real case details", async () => {
  assert.deepEqual(missedWordCopy({ impostor: { login: "pixel_mara" } }), {
    stamp: "NEVER DELIVERED",
    headline: "THE WORD NEVER LANDED",
    detail: "@pixel_mara never found an opening · 0 people saw it",
  });
  const css = await readFile(new URL("../public/overlay.css", import.meta.url), "utf8");
  assert.match(css, /\.verdict\.miss\{[^}]*white-space:nowrap/);
});

test("round rules use singular copy at one-Imposter tables", () => {
  assert.equal(roundRule(1), "The Imposter hides a word. Detectives hunt.");
  assert.equal(roundRule(2), "Imposters hide words. Detectives hunt.");
});

test("vote and CHAT digits match the player-number font size", async () => {
  const css = await readFile(new URL("../public/overlay.css", import.meta.url), "utf8");
  assert.match(css, /\.vote-row \.vote-count\{font-size:20px\}/);
  assert.match(css, /\.chat-vote-label\{font-size:20px\}/);
  assert.match(css, /\.chat-legend\{font-size:18px\}/);
  assert.match(css, /\.vote-row\.has-votes \.player-name,\.vote-row\.has-chat-votes \.player-name\{transform:none\}/);
  assert.match(css, /\.vote-row \.player-name\{[^}]*align-self:start[^}]*line-height:1/);
});

test("the Champion board replaces vote tallies with five final standings", () => {
  const players = Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, login: `player${index}` }));
  const leaderboard = players.map((player, index) => ({ player, score: 12 - index }));
  const model = championBoardModel({ champion: players[0], leaderboard });
  assert.equal(model.title, "FINAL STANDINGS");
  assert.equal(model.headline, "@player0 · 12 points");
  assert.equal(model.standings.length, 5);
});

test("vote instructions follow the table's Imposter count", () => {
  assert.deepEqual(voteInstruction(1), {
    boardTitle: "WHO HID IT?",
    boardMeta: "TOP VOTE ACCUSED",
    outcome: "top vote is accused",
    howTo: "Type a player's number in chat, or tap them on your card · top vote is accused",
    bannerLines: ["Top vote accused", "Type a number in chat or tap your card"],
  });
  assert.equal(voteInstruction(1, 1).boardMeta, "1 STILL HIDDEN");
  assert.equal(voteInstruction(1, 1).bannerLines[0], "1 Imposter still hidden · top vote accused");
  assert.equal(voteInstruction(2).outcome, "top 2 are accused");
  assert.equal(voteInstruction(2).boardMeta, "2 IMPOSTERS");
  assert.equal(voteInstruction(2).bannerLines.length, 2);
});

test("lobby, leaderboard, and vote-lock copy reflect live state", () => {
  assert.equal(readyPlayersCopy(2), "2 players ready · 3 needed to start");
  assert.equal(readyPlayersCopy(8), "8 players ready");
  assert.equal(hasLeaderboardScore([{ score: 0 }, { player: { score: 0 } }]), false);
  assert.equal(hasLeaderboardScore([{ score: 1 }]), true);
  assert.equal(voteLockLabel(false), "VOTES LOCKED");
  assert.equal(voteLockLabel(true), "ALL VOTES IN");
});

test("overlay state helpers accept the server's explicit null values", () => {
  assert.equal(accusationToastDuration(null), 1_800);
  assert.equal(streamTableLabel(null), "");
  assert.equal(missedWordCopy(null).detail, "@imposter never found an opening · 0 people saw it");
  assert.equal(championBoardModel({ champion: null, round: { reveal: null }, leaders: null }).champion, null);
  assert.equal(hasLeaderboardScore(null), false);
  assert.equal(votePlayerLayout(null, null).playerName, "player");
  assert.equal(shouldAnimateVoteBanner(null), false);
  assert.equal(overlayRenderPlan(null, { state: "LOBBY", featuredTableId: null, round: null }).resetBase, true);
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
