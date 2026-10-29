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
  };
}
