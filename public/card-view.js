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
