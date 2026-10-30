export function cardScreen(state = {}) {
  const card = state ?? {};
  if (!card.linked) {
    if (card.pendingClaim?.error) return "join-wrong";
    if (card.pendingClaim) return "join-code";
    return "join-name";
  }
  if (card.revealHold) return "reveal-hold";
  if (card.showResult) return "result";
  if (card.sessionOver) return "session-over";
  if (card.state === "VOTE" && card.role) return "vote";
  if (card.role === "IMPOSTER") return "imposter";
  if (card.role === "DETECTIVE") return "detective";
  return "waiting";
}

export function voteProgress(state = {}, elapsed = 0) {
  const card = state ?? {};
  const duration = Math.max(1, Number(card.phaseDurationMs) || 30_000);
  const remaining = Math.max(0, (Number(card.remainingMs) || 0) - elapsed);
  return Math.min(1, remaining / duration);
}

export function vibrateIfActivated(navigatorLike, pattern = [80, 60, 80]) {
  if (navigatorLike?.userActivation?.hasBeenActive !== true) return false;
  if (typeof navigatorLike.vibrate !== "function") return false;
  navigatorLike.vibrate(pattern);
  return true;
}

export function impostorStatus(state = {}) {
  const card = state ?? {};
  if (card.busted) return {
    className: "busted",
    status: `BUSTED · caught by @${card.bustedBy?.login || "a detective"}`,
    job: "You were caught. Watch the rest of the round and see how the case closes.",
  };
  if (card.delivered) return {
    className: "delivered",
    status: `✓ DELIVERED ${card.deliveredAt || "0:00"} into the round`,
    job: "Your job: slip this word into chat inside a normal sentence before the timer runs out. Don’t get caught.",
  };
  return {
    className: "",
    status: "Word not sent yet",
    job: "Your job: slip this word into chat inside a normal sentence before the timer runs out. Don’t get caught.",
  };
}

export function showRoleTips(state, role) {
  const card = state ?? {};
  return !(role === "IMPOSTER" && card.busted === true);
}

export function hiddenImpostorCount(state) {
  const card = state ?? {};
  return Math.max(0, Number(card.remainingImpostorCount ?? card.impostorCount) || 0);
}

export function cardVoteInstruction(state) {
  const card = state ?? {};
  const hidden = hiddenImpostorCount(card);
  const busted = (card.bustedImpostorIds || []).filter(Boolean).length;
  if (hidden > 1) return `${hidden} Imposters${busted ? " still hidden" : ""} · top ${hidden} are accused`;
  return busted ? "1 Imposter still hidden · top vote accused" : "Top vote accused";
}

export function cardRenderSignature(state = {}) {
  const card = state ?? {};
  const mate = (player) => ({
    id: player?.id,
    login: player?.login,
    number: player?.number,
    avatar: player?.avatar,
  });
  return JSON.stringify({
    linked: card.linked,
    demoReadOnly: card.demoReadOnly,
    joined: card.joined,
    pendingClaim: card.pendingClaim,
    nameCheck: card.nameCheck,
    state: card.state,
    roundNumber: card.roundNumber,
    role: card.role,
    word: card.word,
    delivered: card.delivered,
    deliveredAt: card.deliveredAt,
    busted: card.busted,
    bustedBy: mate(card.bustedBy),
    impostorCount: card.impostorCount,
    remainingImpostorCount: card.remainingImpostorCount,
    bustedImpostorIds: card.bustedImpostorIds,
    hints: card.hints,
    tableId: card.tableId,
    tableCount: card.tableCount,
    onStream: card.onStream,
    player: mate(card.player),
    tableMates: (card.tableMates || []).filter(Boolean).map(mate),
    messages: card.onStream ? null : (card.messages || []).filter(Boolean).map((message) => ({
      id: message?.id,
      text: message?.text,
      source: message?.source,
      playerId: message?.player?.id,
    })),
    accusationUsed: card.accusationUsed,
    voteTargetId: card.voteTargetId,
    revealHold: card.revealHold,
    showResult: card.showResult,
    sessionOver: card.sessionOver,
    result: card.result,
    champion: card.champion,
    roundPoints: card.roundPoints,
    totalScore: card.totalScore,
    rank: card.rank,
  });
}
