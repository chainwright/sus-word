function normalizedLimit(limit, fallback) {
  const value = Number(limit);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function loginOf(player) {
  return String(player?.login || player?.displayName || "").toLowerCase();
}

export function selectRoundPlayers(
  players,
  messageCounts = {},
  messageRecency = {},
  limit = 8,
) {
  return [...(players || [])]
    .sort((left, right) => (
      (Number(messageCounts[right.id]) || 0) - (Number(messageCounts[left.id]) || 0)
      || (Number(messageRecency[right.id]) || 0) - (Number(messageRecency[left.id]) || 0)
      || loginOf(left).localeCompare(loginOf(right))
    ))
    .slice(0, normalizedLimit(limit, 8));
}

export function selectLobbyPlayers(players, limit = 8) {
  return [...(players || [])]
    .map((player, index) => ({ player, index }))
    .sort((left, right) => (
      (Number(right.player.joinedAt) || 0) - (Number(left.player.joinedAt) || 0)
      || right.index - left.index
    ))
    .slice(0, normalizedLimit(limit, 8))
    .map(({ player }) => player);
}

export function selectVoteSuspects(tallies, limit = 5) {
  return [...(tallies || [])]
    .sort((left, right) => (
      (Number(right.votes) || 0) - (Number(left.votes) || 0)
      || loginOf(left.player).localeCompare(loginOf(right.player))
    ))
    .slice(0, normalizedLimit(limit, 5));
}
