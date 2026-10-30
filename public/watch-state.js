export function revealMarkerPlan(state, payoffWindowMs = 3_000) {
  const phase = state?.phase ?? state?.state;
  if (phase !== "REVEAL") return null;
  const reveal = state?.round?.reveal;
  const results = reveal?.imposters?.length ? reveal.imposters : [reveal].filter(Boolean);
  const numbers = results
    .map((result) => Number(result?.impostor?.number))
    .filter(Number.isFinite);
  if (!numbers.length) return null;
  return {
    numbers,
    delayMs: Math.max(0, (Number(state?.remainingMs) || 0) - payoffWindowMs),
  };
}
