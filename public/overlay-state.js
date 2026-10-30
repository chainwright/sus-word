export function phaseOf(state = {}) {
  const safeState = state ?? {};
  return safeState.phase || safeState.state || "IDLE";
}

export function revealStateKey(state = {}) {
  const safeState = state ?? {};
  if (phaseOf(safeState) !== "REVEAL") return "";
  return `${safeState.roundNumber || 0}:${safeState.round?.reveal?.imposters?.length || 1}`;
}

export function overlayRenderPlan(previous, next) {
  const previousPhase = previous ? phaseOf(previous) : null;
  const nextPhase = phaseOf(next);
  const phaseChanged = previousPhase !== nextPhase;
  const previousRevealKey = revealStateKey(previous);
  const nextRevealKey = revealStateKey(next);
  const revealChanged = nextPhase === "REVEAL" && previousRevealKey !== nextRevealKey;
  return {
    phase: nextPhase,
    phaseChanged,
    revealKey: nextRevealKey,
    resetBase: !previous || phaseChanged || revealChanged,
    sameReveal: previousPhase === "REVEAL" && nextPhase === "REVEAL" && !revealChanged,
  };
}

export function shouldAnimateVoteBanner(plan = {}) {
  const safePlan = plan ?? {};
  return safePlan.phase === "VOTE" && safePlan.phaseChanged === true;
}

export function orderAccusationToasts(accusations = []) {
  return [...(accusations || [])].filter(Boolean).sort((left, right) => (
    Number(Boolean(right.correct)) - Number(Boolean(left.correct))
    || (Number(left.at) || 0) - (Number(right.at) || 0)
  ));
}

export function accusationToastDuration(accusation = {}) {
  return accusation?.correct ? 3_000 : 1_800;
}

export function bustedRowLabel(busted = null) {
  return busted ? "BUSTED" : "";
}

export function streamTableLabel(round = {}) {
  const safeRound = round ?? {};
  const count = Number(safeRound.tableCount) || 1;
  if (count <= 1) return "";
  return `TABLE ${Number(safeRound.tableId) || 1} OF ${count} · ON STREAM`;
}

export function formatOverlayClock(milliseconds) {
  const seconds = Math.max(0, Math.ceil((Number(milliseconds) || 0) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function updateCompactLobbyClock(target, milliseconds) {
  if (!target) return false;
  target.textContent = formatOverlayClock(milliseconds);
  return true;
}

export function syncBoardNoteVisibility(target) {
  if (!target) return false;
  const visible = Boolean(String(target.textContent || "").trim());
  target.hidden = !visible;
  return visible;
}

export function roundRule(impostorCount = 1) {
  return Number(impostorCount) > 1
    ? "Imposters hide words. Detectives hunt."
    : "The Imposter hides a word. Detectives hunt.";
}

export function caseFileHeadline(reveal = {}) {
  const supplied = String(reveal?.caseFileMessage || "").replace(/^Round\s+\d+:\s*/i, "").trim()
    .replaceAll("read it", "read\u00a0it");
  if (supplied) return supplied;
  const result = reveal?.imposters?.[0] || reveal || {};
  const word = String(result.word || "WORD").toUpperCase();
  if (!result.evidence) {
    return `${word} never landed · @${result.impostor?.login || "imposter"} never found an opening`;
  }
  if (result.evidence.source === "voice") {
    return `${word} was said out loud at ${result.elapsed || "0:00"} · ${result.verdict === "GOT AWAY" ? "nobody noticed" : "caught"}`;
  }
  const readers = Number(result.readerCount) || 0;
  return `${word} slipped in at ${result.elapsed || "0:00"} · ${readers} read\u00a0it · ${result.verdict === "GOT AWAY" ? "nobody noticed" : "caught"}`;
}

export function missedWordCopy(result = {}) {
  const safeResult = result ?? {};
  return {
    stamp: "NEVER DELIVERED",
    headline: "THE WORD NEVER LANDED",
    detail: `@${safeResult.impostor?.login || "imposter"} never found an opening · 0 people saw it`,
  };
}

export function championBoardModel(state = {}) {
  const safeState = state ?? {};
  const reveal = safeState.round?.reveal || {};
  const champion = safeState.champion || reveal.champion || null;
  const standings = (reveal.leaderboard || safeState.leaderboard || safeState.scores || []).filter(Boolean);
  const championEntry = standings.find((entry) => (entry?.player || entry)?.id === champion?.id);
  const score = championEntry?.score ?? champion?.score ?? 0;
  return {
    title: "FINAL STANDINGS",
    meta: "FINAL SCORE",
    champion,
    standings: standings.slice(0, 5),
    headline: `@${champion?.login || "winner"} · ${score} points`,
  };
}

export function voteNameColumnBudget(viewportWidth = 854, viewportHeight = 480) {
  const scale = Math.min(viewportWidth / 1280, viewportHeight / 720);
  const boardContentWidth = 396 - (2 * 8) - (2 * 10);
  const rowWidth = (boardContentWidth - 7) / 2;
  const logicalNameWidth = rowWidth - (2 * 4) - 26 - 24 - (2 * 4);
  return {
    scale,
    logicalNameWidth,
    physicalNameWidth: logicalNameWidth * scale,
  };
}

export function voteRowOptions(tally = {}, leader = 1, chatLeader = 1, showChat = false) {
  const safeTally = tally ?? {};
  const votes = safeTally.votes || 0;
  const chatVotes = safeTally.chatVotes || 0;
  return {
    vote: true,
    votes,
    bar: (votes / leader) * 100,
    chatVotes,
    chatBar: (chatVotes / chatLeader) * 100,
    showChat: showChat && chatVotes > 0,
    namePadding: 0,
    voteCountPlacement: "secondary-line",
  };
}

export function votePlayerLayout(player = {}, tally = {}, leader = 1, chatLeader = 1, showChat = false) {
  const safePlayer = player ?? {};
  return {
    ...voteRowOptions(tally, leader, chatLeader, showChat),
    playerName: String(safePlayer.login || "player"),
  };
}

export function readyPlayersCopy(count, needed = 3) {
  const ready = Math.max(0, Number(count) || 0);
  return ready >= needed ? `${ready} players ready` : `${ready} players ready · ${needed} needed to start`;
}

export function hasLeaderboardScore(entries) {
  return (entries || []).filter(Boolean).some((entry) => (Number(entry?.score ?? entry?.player?.score) || 0) !== 0);
}

export function voteLockLabel(allVotesIn) {
  return allVotesIn ? "ALL VOTES IN" : "VOTES LOCKED";
}

export function voteInstruction(impostorCount = 1) {
  const hidden = Math.max(1, Number(impostorCount) || 1);
  const multiple = hidden > 1;
  return {
    boardTitle: "WHO HID IT?",
    boardMeta: multiple ? `${hidden} STILL HIDDEN` : "1 STILL HIDDEN",
    outcome: multiple ? `top ${hidden} are accused` : "top vote is accused",
    howTo: `Type a player's number in chat, or tap them on your card · ${multiple ? `top ${hidden} are accused` : "top vote is accused"}`,
    bannerLines: [
      `${hidden} Imposter${multiple ? "s" : ""} still hidden · ${multiple ? `top ${hidden} accused` : "top vote accused"}`,
      "Type a number in chat or tap your card",
    ],
  };
}
