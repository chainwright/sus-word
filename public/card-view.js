export function cardScreen(state = {}) {
  if (!state.linked) {
    if (state.pendingClaim?.error) return "join-wrong";
    if (state.pendingClaim) return "join-code";
    return "join-name";
  }
  if (state.revealHold) return "reveal-hold";
  if (state.showResult) return "result";
  if (state.state === "VOTE" && state.role) return "vote";
  if (state.role === "IMPOSTER") return "imposter";
  if (state.role === "DETECTIVE") return "detective";
  return "waiting";
}

export function voteProgress(state = {}, elapsed = 0) {
  const duration = Math.max(1, Number(state.phaseDurationMs) || 30_000);
  const remaining = Math.max(0, (Number(state.remainingMs) || 0) - elapsed);
  return Math.min(1, remaining / duration);
}

export function cardRenderSignature(state = {}) {
  const mate = (player = {}) => ({
    id: player.id,
    login: player.login,
    number: player.number,
    avatar: player.avatar,
  });
  return JSON.stringify({
    linked: state.linked,
    joined: state.joined,
    pendingClaim: state.pendingClaim,
    nameCheck: state.nameCheck,
    state: state.state,
    roundNumber: state.roundNumber,
    role: state.role,
    word: state.word,
    delivered: state.delivered,
    deliveredAt: state.deliveredAt,
    impostorCount: state.impostorCount,
    hints: state.hints,
    tableId: state.tableId,
    tableCount: state.tableCount,
    onStream: state.onStream,
    player: mate(state.player),
    tableMates: (state.tableMates || []).map(mate),
    messages: state.onStream ? null : (state.messages || []).map((message) => ({
      id: message.id,
      text: message.text,
      source: message.source,
      playerId: message.player?.id,
    })),
    accusationUsed: state.accusationUsed,
    voteTargetId: state.voteTargetId,
    revealHold: state.revealHold,
    showResult: state.showResult,
    result: state.result,
    champion: state.champion,
    roundPoints: state.roundPoints,
    totalScore: state.totalScore,
    rank: state.rank,
  });
}
