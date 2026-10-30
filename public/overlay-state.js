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
  return plan.phase === "VOTE" && plan.phaseChanged === true;
}

export function orderAccusationToasts(accusations = []) {
  return [...accusations].sort((left, right) => (
    Number(Boolean(right.correct)) - Number(Boolean(left.correct))
    || (Number(left.at) || 0) - (Number(right.at) || 0)
  ));
}

export function accusationToastDuration(accusation = {}) {
  return accusation.correct ? 3_000 : 1_800;
}

export function bustedRowLabel(busted = null) {
  return busted ? "BUSTED" : "";
}

export function streamTableLabel(round = {}) {
  const count = Number(round.tableCount) || 1;
  if (count <= 1) return "";
  return `TABLE ${Number(round.tableId) || 1} OF ${count} · ON STREAM`;
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
  const supplied = String(reveal?.caseFileMessage || "").replace(/^Round\s+\d+:\s*/i, "").trim();
  if (supplied) return supplied;
  const result = reveal?.imposters?.[0] || reveal || {};
  const word = String(result.word || "WORD").toUpperCase();
  if (!result.evidence) {
    return `${word} never landed · @${result.impostor?.login || "imposter"} never found an opening`;
  }
  const readers = Number(result.readerCount) || 0;
  return `${word} slipped in at ${result.elapsed || "0:00"} · ${readers} read it · ${result.verdict === "GOT AWAY" ? "nobody noticed" : "caught"}`;
}

export function missedWordCopy(result = {}) {
  return {
    stamp: "NEVER DELIVERED",
    headline: "THE WORD NEVER LANDED",
    detail: `@${result.impostor?.login || "imposter"} never found an opening · 0 people saw it`,
  };
}

export function championBoardModel(state = {}) {
  const reveal = state?.round?.reveal || {};
  const champion = state?.champion || reveal.champion || null;
  const standings = reveal.leaderboard || state?.leaderboard || state?.scores || [];
  const championEntry = standings.find((entry) => (entry.player || entry).id === champion?.id);
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
  const votes = tally.votes || 0;
  const chatVotes = tally.chatVotes || 0;
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
  return {
    ...voteRowOptions(tally, leader, chatLeader, showChat),
    playerName: String(player.login || "player"),
  };
}

export function voteInstruction(impostorCount = 1) {
  const multiple = Number(impostorCount) > 1;
  return {
    boardTitle: "WHO HID IT?",
    boardMeta: multiple ? "TOP 2 ACCUSED" : "TOP VOTE ACCUSED",
    outcome: multiple ? "top 2 are accused" : "top vote is accused",
    howTo: `Type a player's number in chat, or tap them on your card · ${multiple ? "top 2 are accused" : "top vote is accused"}`,
    bannerLines: [
      "Type a player's number in chat",
      `or tap your card · ${multiple ? "top 2 accused" : "top vote accused"}`,
    ],
  };
}
