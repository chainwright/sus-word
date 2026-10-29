const CONTROL_ACTIONS = new Set(["start", "go", "vote", "next", "end"]);

export function parseVoteMessage(message) {
  if (typeof message !== "string") return null;
  const text = message.trim();
  let match = /^(?:#|!)(\d{1,3})$/.exec(text) ?? /^(\d{1,3})$/.exec(text);
  if (!match) match = /^!vote\s+#?(\d{1,3})$/i.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 ? { type: "vote", number, voteMessage: true } : null;
}

export function parseCommand(message) {
  if (typeof message !== "string") return null;
  const text = message.trim();
  const numericVote = parseVoteMessage(text);
  if (numericVote) return numericVote;

  let match = /^(?:join|ijoin)$/i.exec(text);
  if (match) return { type: "joinAlias" };

  match = /^!join$/i.exec(text);
  if (match) return { type: "join" };

  match = /^!join\s+([A-HJ-NP-Z2-9]{4})$/i.exec(text);
  if (match) return { type: "claim", code: match[1].toUpperCase(), joinCommand: true };

  match = /^!leave$/i.exec(text);
  if (match) return { type: "leave" };

  match = /^!claim\s+([A-HJ-NP-Z2-9]{4})$/i.exec(text);
  if (match) return { type: "claim", code: match[1].toUpperCase() };

  match = /^!vote\s+@?([a-z0-9_]{1,25})$/i.exec(text);
  if (match) return { type: "vote", target: match[1].toLowerCase() };

  match = /^!accuse\s+@?([a-z0-9_]{1,25})\s+([a-z][a-z’']{1,19})$/i.exec(text);
  if (match) {
    return {
      type: "accuse",
      target: match[1].toLowerCase(),
      word: match[2].toLowerCase(),
    };
  }

  match = /^!sus\s+mute\s+@?([a-z0-9_]{1,25})$/i.exec(text);
  if (match) {
    return {
      type: "sus",
      action: "mute",
      target: match[1].toLowerCase(),
      requiresControl: true,
    };
  }

  match = /^!sus\s+(start|go|vote|next|end|help)$/i.exec(text);
  if (!match) return null;
  const action = match[1].toLowerCase();
  return {
    type: "sus",
    action,
    requiresControl: CONTROL_ACTIONS.has(action),
  };
}

export function canControl(message) {
  return Boolean(message?.isBroadcaster || message?.isModerator);
}
