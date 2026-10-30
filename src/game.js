import { EventEmitter } from "node:events";

import { parseVoteMessage } from "./commands.js";
import { WORDS, findWord } from "./words.js";

export const PHASES = Object.freeze({
  IDLE: "IDLE",
  LOBBY: "LOBBY",
  ROUND: "ROUND",
  VOTE: "VOTE",
  REVEAL: "REVEAL",
});

export const DEFAULT_DURATIONS = Object.freeze({
  claim: 10 * 60_000,
  lobby: 60_000,
  categoryHint: 90_000,
  letterHint: 150_000,
  round: 180_000,
  vote: 30_000,
  voteGrace: 6_000,
  reveal: 20_000,
  revealOne: 12_000,
  revealTwo: 20_000,
  championHold: 10_000,
  cardResultDelay: 6_000,
});

const CLAIM_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ACTIVE_PHASES = new Set([PHASES.ROUND, PHASES.VOTE, PHASES.REVEAL]);
const SYSTEM_CLOCK = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

function normalizeLogin(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function isVoteText(value) {
  const text = String(value ?? "").trim();
  return Boolean(parseVoteMessage(text) || /^!vote\s+@?[a-z0-9_]{1,25}$/i.test(text));
}

function publicPlayer(player, score = 0) {
  if (!player) return null;
  return {
    id: player.id,
    login: player.login,
    displayName: player.displayName,
    avatar: player.avatar,
    number: player.number ?? null,
    claimed: Boolean(player.claimed),
    muted: Boolean(player.muted),
    joinedAt: player.joinedAt ?? null,
    messageCount: player.messageCount ?? 0,
    simulated: Boolean(player.simulated),
    score,
  };
}

function userDetails(input, login, details = {}) {
  if (input && typeof input === "object") {
    return {
      id: input.id ?? input.userId,
      login: input.login ?? input.userLogin ?? input.chatterLogin,
      displayName: input.displayName ?? input.userName,
      avatar: input.avatar ?? input.profileImageUrl,
      simulated: input.simulated,
    };
  }
  return { id: input, login, ...details, simulated: details.simulated };
}

function stableShuffle(items, random) {
  return items
    .map((item, index) => ({ item, index, roll: random() }))
    .sort((left, right) => left.roll - right.roll || left.index - right.index)
    .map(({ item }) => item);
}

export function seatPlayers(players, random = Math.random, maxTableSize = 12) {
  const shuffled = stableShuffle([...players], random);
  if (shuffled.length < 3) return [];
  const capacity = Math.max(3, Math.min(12, Number(maxTableSize) || 12));
  const tableCount = Math.ceil(shuffled.length / capacity);
  const baseSize = Math.floor(shuffled.length / tableCount);
  const largerTables = shuffled.length % tableCount;
  const tables = [];
  let cursor = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const size = baseSize + (index < largerTables ? 1 : 0);
    tables.push(shuffled.slice(cursor, cursor + size));
    cursor += size;
  }
  return tables;
}

export function selectVoteAccused(tallies, count) {
  if (count <= 0) return [];
  const sorted = [...tallies]
    .filter(({ votes }) => votes > 0)
    .sort((left, right) => (
      right.votes - left.votes || left.player.login.localeCompare(right.player.login)
    ));
  if (sorted.length <= count) return sorted.map(({ player }) => player.id);
  const boundary = sorted[count - 1].votes;
  const above = sorted.filter(({ votes }) => votes > boundary);
  const atBoundary = sorted.filter(({ votes }) => votes === boundary);
  if (above.length + atBoundary.length <= count) {
    return [...above, ...atBoundary].map(({ player }) => player.id);
  }
  const slots = count - above.length;
  if (slots <= 0) return above.map(({ player }) => player.id);
  const byChat = [...atBoundary].sort((left, right) => (
    (right.chatVotes ?? 0) - (left.chatVotes ?? 0)
    || left.player.login.localeCompare(right.player.login)
  ));
  const resolved = [];
  let remaining = slots;
  for (let index = 0; index < byChat.length && remaining > 0;) {
    const chatVotes = byChat[index].chatVotes ?? 0;
    const group = [];
    while (index < byChat.length && (byChat[index].chatVotes ?? 0) === chatVotes) {
      group.push(byChat[index]);
      index += 1;
    }
    if (group.length > remaining) break;
    resolved.push(...group);
    remaining -= group.length;
  }
  return [...above, ...resolved].map(({ player }) => player.id);
}

export class Game extends EventEmitter {
  constructor(options = {}) {
    super();
    const sourceClock = options.clock ?? SYSTEM_CLOCK;
    this.clock = {
      now: () => Number(typeof sourceClock.now === "function" ? sourceClock.now() : sourceClock.now),
      setTimeout: (callback, delay) => sourceClock.setTimeout(callback, delay),
      clearTimeout: (timer) => sourceClock.clearTimeout(timer),
    };
    this.random = options.random ?? Math.random;
    this.wordPicker = options.wordPicker ?? null;
    this.maxTableSize = Math.max(3, Math.min(12, Number(options.maxTableSize) || 12));
    this.codeGenerator = options.codeGenerator ?? null;
    this.words = options.words ?? WORDS;
    this.durations = { ...DEFAULT_DURATIONS, ...options.durations };
    if (Object.hasOwn(options.durations ?? {}, "reveal")) {
      if (!Object.hasOwn(options.durations, "revealOne")) this.durations.revealOne = options.durations.reveal;
      if (!Object.hasOwn(options.durations, "revealTwo")) this.durations.revealTwo = options.durations.reveal;
    }
    this.streamerLogin = normalizeLogin(options.streamerLogin);
    this.hostPlays = options.hostPlays !== false;
    this.state = PHASES.IDLE;
    this.roundNumber = 0;
    this.players = new Map();
    this.profiles = new Map();
    this.scores = new Map();
    this.playerStats = new Map();
    this.claims = new Map();
    this.sessions = new Map();
    this.tables = new Map();
    this.playerTables = new Map();
    this.votes = new Map();
    this.currentRound = null;
    this.featuredTableId = null;
    this.lastFeaturedTableId = 0;
    this.lastFeaturedPlayerIds = new Set();
    this.lastRoundSeating = [];
    this.lastImpostorIds = new Set();
    this.lastImpostorId = null;
    this.lastReveal = null;
    this.lastChampion = null;
    this.crowdParticipants = new Set();
    this.crowdAccusations = new Set();
    this.crowdVoteTables = new Map();
    this.roundAccusations = new Set();
    this.roundVoteTables = new Map();
    this.crowdMessageCount = 0;
    this.mutedPlayerIds = new Set();
    this.isFinalRound = false;
    this.sessionOver = false;
    this.nextSessionStartsAt = null;
    this.cardResults = new Map();
    this.nextPlayerNumber = 1;
    this.lobbyOpenedAt = null;
    this.timers = new Map();
  }

  get phase() { return this.state; }

  configureStreamer(login) {
    this.streamerLogin = normalizeLogin(login);
    return { ok: true, login: this.streamerLogin, hostPlays: this.hostPlays };
  }

  setHostPlays(enabled) {
    this.hostPlays = Boolean(enabled);
    const streamer = this.#streamerPlayer();
    if (ACTIVE_PHASES.has(this.state)) {
      if (this.hostPlays && streamer) this.#moveStreamerTo(this.featuredTableId);
      if (!this.hostPlays && streamer) this.#removeFromActiveTable(streamer.id);
    }
    this.#publish("hostPlays", { enabled: this.hostPlays });
    return { ok: true, enabled: this.hostPlays };
  }

  mute(reference) {
    const player = this.#resolvePlayer(reference, this.players)
      ?? this.#resolvePlayer(reference, this.profiles);
    if (!player) return { ok: false, reason: "unknown_player" };
    this.mutedPlayerIds.add(player.id);
    const active = this.players.get(player.id);
    if (active) active.muted = true;
    const profile = this.profiles.get(player.id);
    if (profile) profile.muted = true;
    this.#removeFromActiveTable(player.id);
    this.#publish("player", { action: "mute", player: this.#publicPlayer(player) });
    return { ok: true, player: this.#publicPlayer(player) };
  }

  start() {
    if (this.state !== PHASES.IDLE) return { ok: false, reason: "invalid_state" };
    this.sessionOver = false;
    this.nextSessionStartsAt = null;
    this.#enterLobby();
    return { ok: true, state: this.state };
  }

  end() {
    if (this.state === PHASES.IDLE) return { ok: false, reason: "invalid_state" };
    this.cardResults.clear();
    this.sessionOver = true;
    this.nextSessionStartsAt = null;
    this.#clearActiveRound();
    this.#transition(PHASES.IDLE);
    return { ok: true, state: this.state };
  }

  reset() {
    this.#clearTimers();
    this.players.clear();
    this.profiles.clear();
    this.scores.clear();
    this.playerStats.clear();
    this.claims.clear();
    this.sessions.clear();
    this.lastRoundSeating = [];
    this.lastImpostorIds.clear();
    this.lastImpostorId = null;
    this.lastReveal = null;
    this.lastChampion = null;
    this.sessionOver = false;
    this.nextSessionStartsAt = null;
    this.lastFeaturedTableId = 0;
    this.lastFeaturedPlayerIds.clear();
    this.cardResults.clear();
    this.#clearActiveRound();
    this.lobbyOpenedAt = null;
    this.roundNumber = 0;
    this.nextPlayerNumber = 1;
    const previous = this.state;
    this.state = PHASES.IDLE;
    this.#publish("state", { from: previous, to: PHASES.IDLE });
    return { ok: true, state: this.state };
  }

  join(input, login, details) {
    const user = userDetails(input, login, details);
    const id = String(user.id ?? "").trim();
    const normalized = normalizeLogin(user.login);
    if (!id || !normalized) return { ok: false, reason: "invalid_player" };
    const existing = this.players.get(id);
    const known = existing ?? this.profiles.get(id);
    const profile = {
      id,
      login: normalized,
      displayName: String(user.displayName ?? known?.displayName ?? user.login ?? normalized),
      avatar: String(user.avatar ?? known?.avatar ?? ""),
      simulated: Boolean(user.simulated ?? known?.simulated),
    };
    const claimed = Boolean(existing?.claimed
      || [...this.sessions.values()].some((session) => session.userId === id));
    const player = {
      ...profile,
      number: known?.number ?? this.nextPlayerNumber++,
      claimed,
      muted: this.mutedPlayerIds.has(id),
      joinedAt: existing?.joinedAt ?? this.#now(),
      messageCount: existing?.messageCount ?? 0,
    };
    this.players.set(id, player);
    this.profiles.set(id, { ...player });
    if (!this.scores.has(id)) this.scores.set(id, 0);
    this.#statsFor(id);
    this.#publish("player", {
      action: existing ? "update" : "join",
      waitingForNextRound: ACTIVE_PHASES.has(this.state) && !this.playerTables.has(id),
      player: this.#publicPlayer(player),
    });
    this.#maybeAutoStartLobby();
    return { ok: true, joined: !existing, player: this.#publicPlayer(player) };
  }

  leave(reference) {
    const player = this.#resolvePlayer(reference, this.players);
    if (!player) return { ok: false, reason: "not_joined" };
    this.profiles.set(player.id, { ...player });
    this.players.delete(player.id);
    this.#publish("player", { action: "leave", player: this.#publicPlayer(player) });
    return { ok: true, player: this.#publicPlayer(player) };
  }

  createClaim(sessionOrOptions, requestedLogin) {
    const options = sessionOrOptions && typeof sessionOrOptions === "object"
      ? sessionOrOptions : { sessionId: sessionOrOptions, login: requestedLogin };
    const sessionId = String(options.sessionId ?? options.sid ?? "").trim();
    const login = normalizeLogin(options.login ?? options.requestedLogin);
    if (!sessionId || !login) return { ok: false, reason: "invalid_claim" };
    const now = this.#now();
    this.#pruneClaims(now);
    for (const [code, claim] of this.claims) {
      if (claim.sessionId === sessionId && !claim.usedAt) this.claims.delete(code);
    }
    let code;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      code = this.codeGenerator
        ? String(this.codeGenerator() ?? "").trim().toUpperCase()
        : this.#randomCode();
      if (/^[A-HJ-NP-Z2-9]{4}$/.test(code) && !this.claims.has(code)) break;
      code = null;
    }
    if (!code) return { ok: false, reason: "code_unavailable" };
    const claim = { code, sessionId, login, createdAt: now, expiresAt: now + this.durations.claim, usedAt: null, userId: null };
    this.claims.set(code, claim);
    return { ok: true, code, login, expiresAt: claim.expiresAt };
  }

  claim(codeOrOptions, chatter, userId) {
    const options = codeOrOptions && typeof codeOrOptions === "object"
      ? codeOrOptions
      : typeof chatter === "object" ? { code: codeOrOptions, ...chatter }
        : { code: codeOrOptions, login: chatter, userId };
    const code = String(options.code ?? "").trim().toUpperCase();
    const claim = this.claims.get(code);
    if (!claim) return { ok: false, reason: "invalid_code" };
    if (claim.usedAt !== null) return { ok: false, reason: "code_used" };
    if (this.#now() - claim.createdAt >= this.durations.claim) {
      this.claims.delete(code);
      return { ok: false, reason: "code_expired" };
    }
    const login = normalizeLogin(options.login ?? options.chatterLogin ?? options.userLogin);
    if (login !== claim.login) {
      const message = `@${login || "viewer"} this code was made for @${claim.login}. Open the card and type your own Twitch name`;
      claim.error = message;
      this.#publishPrivateCard(claim.sessionId);
      return {
        ok: false,
        reason: "name_mismatch",
        expectedLogin: claim.login,
        senderLogin: login,
        message,
      };
    }
    const id = String(options.userId ?? options.id ?? "").trim();
    if (!id) return { ok: false, reason: "invalid_player" };
    const linkedSession = this.sessions.get(claim.sessionId);
    if (linkedSession && linkedSession.userId !== id) return { ok: false, reason: "session_linked" };
    const now = this.#now();
    claim.usedAt = now;
    claim.userId = id;
    this.sessions.set(claim.sessionId, { userId: id, linkedAt: now });
    const joined = this.join({
      id,
      login,
      displayName: options.displayName ?? options.userName ?? login,
      avatar: options.avatar ?? options.profileImageUrl ?? "",
      simulated: options.simulated,
    });
    const player = this.players.get(id);
    player.claimed = true;
    this.profiles.set(id, { ...player });
    this.#publish("claim", {
      waitingForNextRound: ACTIVE_PHASES.has(this.state) && !this.playerTables.has(id),
      player: this.#publicPlayer(player),
    });
    this.#maybeAutoStartLobby();
    return { ok: true, sessionId: claim.sessionId, joined: joined.joined, player: this.#publicPlayer(player) };
  }

  go(options = {}) {
    if (this.state !== PHASES.LOBBY) return { ok: false, reason: "invalid_state" };
    const claimed = [...this.players.values()].filter((player) => (
      player.claimed
      && !this.mutedPlayerIds.has(player.id)
      && (this.hostPlays || player.login !== this.streamerLogin)
    ));
    return this.#startRound(claimed, options, false);
  }

  final(options = {}) {
    if (this.state !== PHASES.LOBBY) return { ok: false, reason: "invalid_state" };
    if (!this.lastRoundSeating.length) return { ok: false, reason: "no_previous_tables" };
    let finalists;
    if (this.lastRoundSeating.length > 12) {
      const eligible = new Set(this.lastRoundSeating.flatMap(({ playerIds }) => playerIds));
      finalists = this.#rankPlayers([...eligible].map((id) => this.players.get(id)).filter(Boolean)).slice(0, 12);
    } else {
      const rankedTables = this.lastRoundSeating.map(({ playerIds }) => (
        this.#rankPlayers(playerIds.map((id) => this.players.get(id)).filter(Boolean))
      )).filter(({ length }) => length);
      const winners = rankedTables.map(([winner]) => winner);
      const selectedIds = new Set(winners.map(({ id }) => id));
      const runnersUp = this.#rankPlayers(rankedTables.flatMap((players) => players.slice(1)));
      const targetSize = Math.min(12, Math.max(6, winners.length), winners.length + runnersUp.length);
      finalists = [...winners];
      for (const player of runnersUp) {
        if (finalists.length >= targetSize) break;
        if (!selectedIds.has(player.id)) {
          selectedIds.add(player.id);
          finalists.push(player);
        }
      }
    }
    finalists = finalists.filter((player) => !this.mutedPlayerIds.has(player.id));
    const streamer = this.#streamerPlayer();
    const selected = finalists.slice(0, 12);
    if (this.hostPlays && streamer && !selected.some(({ id }) => id === streamer.id)) {
      selected.push(streamer);
    }
    if (selected.length < 3) return { ok: false, reason: "not_enough_finalists" };
    return this.#startRound(selected, options, true);
  }

  featureTable(tableId) {
    const id = Number(tableId);
    const table = this.tables.get(id);
    if (!table || !ACTIVE_PHASES.has(this.state)) return { ok: false, reason: "unknown_table" };
    if (this.hostPlays) this.#moveStreamerTo(id);
    this.featuredTableId = id;
    this.currentRound = table;
    this.lastFeaturedTableId = id;
    this.#publish("feature", { tableId: id });
    return { ok: true, tableId: id };
  }

  recordMessage(input, text) {
    if (this.state !== PHASES.ROUND || !this.tables.size) return { ok: false, reason: "invalid_state" };
    const options = input && typeof input === "object" ? input : { userId: input, text };
    const reference = options.userId ?? options.id ?? options.login;
    const messageText = String(options.text ?? options.message ?? "");
    if (!reference || !messageText) return { ok: false, reason: "invalid_message" };
    if (isVoteText(messageText)) {
      return {
        ok: true,
        ignored: true,
        voteMessage: true,
        evidence: false,
        visible: false,
      };
    }
    const knownPlayer = this.#resolvePlayer(reference, this.players)
      ?? this.#resolvePlayer(reference, this.profiles);
    if (knownPlayer && this.mutedPlayerIds.has(knownPlayer.id)) {
      return { ok: false, reason: "muted" };
    }
    const table = this.#tableForPlayer(reference);
    const transport = options.transport ?? (options.source === "voice" ? "voice" : "direct");
    if (transport === "card" && (!table || table.id === this.featuredTableId)) {
      return { ok: false, reason: table ? "featured_table_locked" : "not_seated" };
    }
    if (transport === "twitch" && table && table.id !== this.featuredTableId) {
      this.crowdMessageCount += 1;
      this.#publish("crowdMessage", { count: this.crowdMessageCount, playerId: String(reference) });
      return { ok: true, crowd: true, counted: true };
    }
    if (!table) {
      if (options.source === "voice") return { ok: false, reason: "invalid_message" };
      const crowd = this.#rememberParticipant(options);
      if (!crowd) return { ok: false, reason: "invalid_message" };
      this.crowdParticipants.add(crowd.id);
      this.crowdMessageCount += 1;
      this.#publish("crowdMessage", { count: this.crowdMessageCount });
      return { ok: true, crowd: true, counted: true };
    }
    const player = this.#resolvePlayer(reference, table.roster);
    if (!player) return { ok: false, reason: "invalid_message" };
    const now = this.#now();
    const message = {
      id: String(options.messageId ?? options.idempotencyKey ?? `${this.roundNumber}:${table.id}:${table.messages.length + 1}`),
      userId: player.id,
      login: player.login,
      displayName: player.displayName,
      avatar: player.avatar,
      text: messageText,
      source: options.source === "voice" ? "voice" : "chat",
      transport,
      visible: true,
      at: now,
      elapsedMs: Math.max(0, now - table.startedAt),
      sequence: table.messages.length,
    };
    table.messages.push(message);
    const count = (table.messageCounts.get(player.id) ?? 0) + 1;
    table.messageCounts.set(player.id, count);
    const activePlayer = this.players.get(player.id);
    if (activePlayer) activePlayer.messageCount = count;
    const smuggled = [];
    const decoys = [];
    for (const assignment of table.impostors) {
      const match = findWord(messageText, assignment.word);
      if (!match.hit) continue;
      if (player.id === assignment.playerId) {
        if (!assignment.smuggle) {
          assignment.smuggle = { ...message, match };
          smuggled.push(assignment.playerId);
          if (assignment === table.impostors[0]) table.smuggle = assignment.smuggle;
          this.#publishCardsFor(player.id);
        }
      } else {
        table.decoys.push({ ...message, match, wordOwnerId: assignment.playerId });
        decoys.push(assignment.playerId);
      }
    }
    this.#publish("message", { tableId: table.id, message: { ...message }, messageCount: count });
    return { ok: true, tableId: table.id, message: { ...message }, delivered: smuggled.length > 0, decoy: decoys.length > 0, smuggled, decoys };
  }

  accuse(accuserReference, targetReference, guessedWord) {
    if (this.state !== PHASES.ROUND || !this.tables.size) return { ok: false, reason: "invalid_state" };
    const input = accuserReference && typeof accuserReference === "object"
      ? accuserReference : { userId: accuserReference };
    const accuser = this.#rememberParticipant(input);
    if (!accuser) return { ok: false, reason: "invalid_accuser" };
    if (this.mutedPlayerIds.has(accuser.id)) return { ok: false, reason: "muted" };
    const seatedTable = this.#tableForPlayer(accuser.id);
    const ownTable = seatedTable && input.transport !== "twitch";
    const table = ownTable ? seatedTable : this.tables.get(this.featuredTableId);
    if (!table) return { ok: false, reason: "unknown_table" };
    if (input.transport === "card" && table.id === this.featuredTableId) {
      return { ok: false, reason: "featured_table_locked" };
    }
    if (this.roundAccusations.has(accuser.id)) return { ok: false, reason: "already_accused" };
    this.roundAccusations.add(accuser.id);
    if (!ownTable) {
      this.crowdParticipants.add(accuser.id);
      this.crowdAccusations.add(accuser.id);
    }
    const target = this.#resolvePlayer(targetReference, table.roster);
    const assignment = target ? table.impostors.find(({ playerId }) => playerId === target.id) : null;
    const wordMatch = assignment
      ? findWord(`guess is ${String(guessedWord ?? "")}`, assignment.word).hit : false;
    const correct = Boolean(assignment && assignment.smuggle && !assignment.busted && wordMatch);
    const accusation = {
      accuserId: accuser.id,
      targetId: target?.id ?? null,
      target: normalizeLogin(targetReference),
      word: String(guessedWord ?? "").trim().toLowerCase(),
      correct,
      at: this.#now(),
    };
    table.accusations.set(accuser.id, accusation);
    table.accusationLog.push(accusation);
    if (!correct) {
      const toast = `❌ @${accuser.login} guessed wrong`;
      const payload = {
        tableId: table.id,
        accuser: this.#publicPlayer(accuser),
        accusation,
        toast,
        toastKind: "miss",
      };
      this.#publish("accuseMiss", payload);
      return { ok: true, correct: false, tableId: table.id, toast, toastKind: "miss" };
    }
    assignment.busted = true;
    assignment.bustedAt = accusation.at;
    assignment.bustedBy = accuser.id;
    for (const votes of [table.earlyVotes, table.crowdEarlyVotes, table.votes, table.crowdVotes]) {
      for (const [voterId, targetId] of votes) {
        if (targetId === target.id) votes.delete(voterId);
      }
    }
    this.#addScore(accuser.id, 2, table);
    this.#statsFor(accuser.id).catches += 1;
    const toast = `@${accuser.login} BUSTED @${target.login}: ${assignment.word.toUpperCase()}`;
    const payload = {
      tableId: table.id,
      accuser: this.#publicPlayer(accuser),
      impostor: this.#publicPlayer(target),
      word: assignment.word,
      accusation,
      toast,
      toastKind: "busted",
    };
    this.#publish("busted", payload);
    this.#finishIfEveryImpostorIsBusted();
    return { ok: true, correct: true, busted: true, tableId: table.id, toast, toastKind: "busted" };
  }

  #finishIfEveryImpostorIsBusted() {
    if (this.state !== PHASES.ROUND || !this.tables.size) return false;
    if (![...this.tables.values()].every((table) => (
      table.impostors.length > 0 && table.impostors.every(({ busted }) => busted)
    ))) return false;
    const now = this.#now();
    for (const table of this.tables.values()) {
      table.endedAt = now;
      table.endsAt = now;
      table.voteEndsAt = now;
      table.votes = new Map();
      table.crowdVotes = new Map();
    }
    this.votes.clear();
    this.#completeReveal();
    return true;
  }

  beginVote() {
    if (this.state !== PHASES.ROUND || !this.tables.size) return { ok: false, reason: "invalid_state" };
    const now = this.#now();
    for (const table of this.tables.values()) {
      table.endedAt = now;
      table.voteEndsAt = now + this.durations.vote;
      table.votes = new Map(table.earlyVotes);
      table.crowdVotes = new Map(table.crowdEarlyVotes);
      table.allVotesIn = false;
    }
    this.votes = new Map([...this.tables.values()].flatMap((table) => [...table.votes]));
    this.#transition(PHASES.VOTE);
    this.#setTimer("voteWarning", Math.max(0, this.durations.vote - 10_000), () => {
      if (this.state === PHASES.VOTE) this.#publish("voteWarning", { seconds: 10 });
    });
    this.#setTimer("vote", this.durations.vote + this.durations.voteGrace, () => this.finishVote());
    this.#publish("voteStart", {
      roundNumber: this.roundNumber,
      duration: this.durations.vote,
      grace: this.durations.voteGrace,
    });
    const allVotesIn = this.#finishVoteIfAllSeated();
    return { ok: true, state: this.state, allVotesIn };
  }

  vote(voterReference, targetReference) {
    if (![PHASES.ROUND, PHASES.VOTE].includes(this.state) || !this.tables.size) {
      return { ok: false, reason: "invalid_state" };
    }
    const input = voterReference && typeof voterReference === "object"
      ? voterReference : { userId: voterReference };
    const voter = this.#rememberParticipant(input);
    if (!voter) return { ok: false, reason: "not_a_player" };
    if (this.mutedPlayerIds.has(voter.id)) return { ok: false, reason: "muted" };
    const seatedTable = this.#tableForPlayer(voter.id);
    const crowd = !seatedTable && input.transport === "twitch";
    const table = seatedTable ?? (crowd ? this.tables.get(this.featuredTableId) : null);
    if (!table) return { ok: false, reason: "not_seated" };
    if (this.state === PHASES.VOTE
      && this.#now() > table.voteEndsAt + this.durations.voteGrace) {
      return { ok: false, reason: "vote_closed" };
    }
    const target = this.#resolveVoteTarget(targetReference, table);
    if (!target) return { ok: false, reason: "unknown_target" };
    if (table.impostors.some(({ playerId, busted }) => busted && playerId === target.id)) {
      return {
        ok: false,
        reason: "already_busted",
        target: this.#publicPlayer(target),
        message: `@${target.login} is already busted · vote for someone else`,
      };
    }
    if (voter.id === target.id) return { ok: false, reason: "self_vote" };
    if (crowd) {
      const previousTableId = this.crowdVoteTables.get(voter.id);
      if (previousTableId && previousTableId !== table.id) {
        const previousTable = this.tables.get(previousTableId);
        previousTable?.crowdEarlyVotes.delete(voter.id);
        previousTable?.crowdVotes.delete(voter.id);
      }
      this.crowdParticipants.add(voter.id);
      this.crowdVoteTables.set(voter.id, table.id);
    } else {
      this.roundVoteTables.set(voter.id, table.id);
    }
    if (this.state === PHASES.ROUND) {
      const voteMap = crowd ? table.crowdEarlyVotes : table.earlyVotes;
      const previousTargetId = voteMap.get(voter.id) ?? null;
      const shouldReply = !crowd && !table.earlyVoteReplies.has(voter.id);
      voteMap.set(voter.id, target.id);
      if (!crowd) {
        table.earlyVoteReplies.add(voter.id);
        this.votes.set(voter.id, target.id);
      }
      const result = {
        ok: true,
        crowd,
        early: true,
        saved: true,
        shouldReply,
        tableId: table.id,
        voterId: voter.id,
        targetId: target.id,
        targetNumber: target.number,
        replaced: previousTargetId !== null,
        previousTargetId,
      };
      this.#publish("earlyVote", result);
      return { ...result, state: this.state };
    }
    const voteMap = crowd ? table.crowdVotes : table.votes;
    const previousTargetId = voteMap.get(voter.id) ?? null;
    voteMap.set(voter.id, target.id);
    if (!crowd) this.votes.set(voter.id, target.id);
    const result = {
      ok: true,
      crowd,
      tableId: table.id,
      replaced: previousTargetId !== null,
      previousTargetId,
      voterId: voter.id,
      targetId: target.id,
      tallies: this.getTallies(table.id),
    };
    this.#publish("vote", result);
    const allVotesIn = !crowd && this.#finishVoteIfAllSeated();
    return { ...result, allVotesIn, state: this.state };
  }

  #finishVoteIfAllSeated() {
    if (this.state !== PHASES.VOTE || !this.tables.size) return false;
    if (![...this.tables.values()].every((table) => table.votes.size === table.roster.size)) return false;
    for (const table of this.tables.values()) table.allVotesIn = true;
    this.#publish("allVotesIn", {
      roundNumber: this.roundNumber,
      message: "ALL VOTES IN",
    });
    this.#completeReveal();
    return true;
  }

  finishVote() {
    if (this.state !== PHASES.VOTE || !this.tables.size) return { ok: false, reason: "invalid_state" };
    return this.#completeReveal();
  }

  #completeReveal() {
    const now = this.#now();
    const revealDuration = this.#revealDuration();
    for (const table of this.tables.values()) {
      table.revealEndsAt = now + revealDuration;
      table.reveal = this.#buildTableReveal(table);
      table.phaseResult = this.#phaseResult(table.reveal.imposters);
    }
    const finalTable = this.isFinalRound ? this.tables.values().next().value : null;
    const rankedFinalists = this.isFinalRound
      ? this.#rankFinalPlayers(
        [...this.playerTables.keys()].map((id) => this.players.get(id) ?? this.profiles.get(id)).filter(Boolean),
        finalTable,
      ) : [];
    const finalStandings = this.isFinalRound
      ? rankedFinalists.map((player, index, ranked) => ({
        player: this.#publicPlayer(player),
        score: this.scores.get(player.id) ?? 0,
        rank: ranked.findIndex((candidate) => (
          (this.scores.get(candidate.id) ?? 0) === (this.scores.get(player.id) ?? 0)
        )) + 1,
      })) : [];
    const finalLeaderboard = this.isFinalRound ? finalStandings.slice(0, 5) : this.#leaderboard(5);
    for (const table of this.tables.values()) table.reveal.leaderboard = finalLeaderboard;
    if (this.isFinalRound) {
      const champion = rankedFinalists[0] ?? null;
      this.lastChampion = champion;
      for (const table of this.tables.values()) {
        table.reveal.champion = champion;
        table.reveal.championRoundPoints = champion ? table.scoreChanges.get(champion.id) ?? 0 : 0;
        table.reveal.championTotalScore = champion ? this.scores.get(champion.id) ?? 0 : 0;
      }
    }
    const fullLeaderboard = this.#leaderboard(Infinity);
    this.cardResults.clear();
    for (const table of this.tables.values()) {
      for (const player of table.roster.values()) {
        const assignment = table.impostors.find(({ playerId }) => playerId === player.id);
        const voteTargetId = table.votes.get(player.id) ?? null;
        const voteTarget = voteTargetId ? table.roster.get(voteTargetId) : null;
        const voteWasRight = Boolean(table.impostors.some(({ playerId }) => playerId === voteTargetId));
        const standingSource = this.isFinalRound ? finalStandings : fullLeaderboard;
        const standing = standingSource.find(({ player: ranked }) => ranked.id === player.id);
        const availableAt = table.revealEndsAt + this.durations.cardResultDelay;
        this.cardResults.set(player.id, {
          availableAt,
          championUntil: this.isFinalRound ? availableAt + this.durations.championHold : null,
          roundNumber: table.number,
          role: assignment ? "IMPOSTER" : "DETECTIVE",
          tableId: table.id,
          result: table.reveal,
          voteTarget: voteTarget ? this.#publicPlayer(voteTarget) : null,
          voteWasRight,
          roundPoints: table.scoreChanges.get(player.id) ?? 0,
          totalScore: this.scores.get(player.id) ?? 0,
          rank: standing?.rank ?? null,
          playerCount: this.isFinalRound ? rankedFinalists.length : fullLeaderboard.length,
        });
      }
    }
    this.currentRound = this.tables.get(this.featuredTableId);
    this.lastReveal = this.currentRound.reveal;
    const otherResults = [...this.tables.values()]
      .filter(({ id }) => id !== this.featuredTableId).flatMap(({ reveal }) => reveal.imposters);
    this.lastReveal.otherTables = [...this.tables.values()]
      .filter(({ id }) => id !== this.featuredTableId)
      .map((table) => ({
        id: table.id,
        results: table.reveal.imposters.map((result) => ({
          impostor: result.impostor,
          verdict: result.verdict,
          bustedBy: result.bustedBy,
        })),
      }));
    const caughtCount = otherResults.filter(({ verdict }) => verdict === "CAUGHT" || verdict === "BUSTED").length;
    const gotAwayCount = otherResults.filter(({ verdict }) => verdict === "GOT AWAY").length;
    this.lastReveal.otherTablesMessage = this.tables.size > 1
      ? `Other tables: ${caughtCount} caught, ${gotAwayCount} got away.` : null;
    this.#transition(PHASES.REVEAL);
    this.#publish("reveal", {
      ...this.lastReveal,
      revealHoldMs: revealDuration + this.durations.cardResultDelay,
      caseFileDelayMs: revealDuration,
    });
    this.#setTimer("reveal", revealDuration, () => this.nextRound());
    return { ok: true, state: this.state, reveal: this.lastReveal, revealDuration };
  }

  nextRound() {
    if (this.state !== PHASES.REVEAL) return { ok: false, reason: "invalid_state" };
    const sessionEnded = this.isFinalRound;
    this.#enterLobby();
    this.sessionOver = sessionEnded;
    if (sessionEnded) this.#publish("sessionOver", { champion: this.#publicPlayer(this.lastChampion) });
    return { ok: true, state: this.state };
  }

  prepareNextSession(delayMs = 8_000) {
    if (this.state !== PHASES.LOBBY || !this.sessionOver) return { ok: false, reason: "invalid_state" };
    const delay = Math.max(0, Number(delayMs) || 0);
    this.nextSessionStartsAt = this.#now() + delay;
    this.#publish("nextSession", { startsAt: this.nextSessionStartsAt, delayMs: delay });
    return { ok: true, startsAt: this.nextSessionStartsAt, delayMs: delay };
  }

  completeSession() {
    if (this.state !== PHASES.LOBBY || this.sessionOver) return { ok: false, reason: "invalid_state" };
    this.#clearTimers();
    this.sessionOver = true;
    this.nextSessionStartsAt = null;
    this.#publish("sessionOver", { champion: this.#publicPlayer(this.lastChampion) });
    this.#armCardResultTimer();
    return { ok: true, state: this.state };
  }

  getTallies(tableId = this.featuredTableId) {
    const table = this.tables.get(Number(tableId));
    if (!table) return [];
    const counts = new Map([...table.roster.keys()].map((id) => [id, 0]));
    const chatCounts = new Map([...table.roster.keys()].map((id) => [id, 0]));
    const bustedIds = new Set(table.impostors.filter(({ busted }) => busted).map(({ playerId }) => playerId));
    for (const targetId of table.votes.values()) {
      if (!bustedIds.has(targetId)) counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
    }
    for (const targetId of table.crowdVotes.values()) {
      if (!bustedIds.has(targetId)) chatCounts.set(targetId, (chatCounts.get(targetId) ?? 0) + 1);
    }
    return [...table.roster.values()].map((player) => ({
      player: this.#publicPlayer(player),
      votes: counts.get(player.id) ?? 0,
      chatVotes: chatCounts.get(player.id) ?? 0,
    }));
  }

  getCard(sessionId) {
    const session = this.sessions.get(String(sessionId ?? ""));
    if (!session) return { linked: false, role: null };
    const player = this.players.get(session.userId) ?? this.profiles.get(session.userId);
    if (!player) return { linked: true, joined: false, role: null };
    const table = this.#tableForPlayer(session.userId);
    const base = {
      linked: true,
      joined: this.players.has(session.userId),
      muted: this.mutedPlayerIds.has(session.userId),
      player: this.#publicPlayer(player),
      state: this.state,
      sessionOver: this.sessionOver,
      nextSessionStartsAt: this.nextSessionStartsAt,
      roundNumber: this.roundNumber,
      phaseEndsAt: this.#phaseEndsAt(),
      phaseDurationMs: this.state === PHASES.REVEAL
        ? this.#revealDuration() : this.durations[this.state.toLowerCase()] ?? 0,
      remainingMs: Math.max(0, (this.#phaseEndsAt() ?? this.#now()) - this.#now()),
    };
    const heldResult = this.cardResults.get(player.id);
    if (heldResult && [PHASES.REVEAL, PHASES.LOBBY].includes(this.state)) {
      if (this.#now() < heldResult.availableAt) {
        return {
          ...base,
          role: null,
          revealHold: true,
          resultAvailableAt: heldResult.availableAt,
        };
      }
      if (heldResult.championUntil && this.#now() >= heldResult.championUntil) {
        return { ...base, role: null, sessionOver: true };
      }
      return {
        ...base,
        ...heldResult,
        showResult: true,
        revealHold: false,
      };
    }
    if (!table || !ACTIVE_PHASES.has(this.state)) {
      return { ...base, role: null, crowd: ACTIVE_PHASES.has(this.state) };
    }
    const assignment = table.impostors.find(({ playerId }) => player.id === playerId);
    const onStream = table.id === this.featuredTableId;
    const tableView = {
      tableId: table.id,
      tableCount: this.tables.size,
      impostorCount: table.impostors.length,
      remainingImpostorCount: table.impostors.filter(({ busted }) => !busted).length,
      bustedImpostorIds: table.impostors.filter(({ busted }) => busted).map(({ playerId }) => playerId),
      featuredTableId: this.featuredTableId,
      onStream,
      chatLocked: onStream,
      tableMates: [...table.roster.values()].map((mate) => this.#publicPlayer(mate)),
      messages: table.messages.slice(-20).map((message) => this.#publicMessage(message, table)),
      hints: this.#publicHints(table),
      roundPoints: table.scoreChanges.get(player.id) ?? 0,
      accusationUsed: this.roundAccusations.has(player.id),
      voteSavedEarly: table.earlyVotes.has(player.id),
      earlyVoteTargetId: table.earlyVotes.get(player.id) ?? null,
      earlyVoteTargetNumber: table.roster.get(table.earlyVotes.get(player.id))?.number ?? null,
      voteTargetId: table.votes.get(player.id) ?? null,
      allVotesIn: table.allVotesIn,
      canAccuse: this.state === PHASES.ROUND && !this.roundAccusations.has(player.id),
      canVote: this.state === PHASES.VOTE,
    };
    if (this.state === PHASES.REVEAL) tableView.result = table.reveal;
    if (!assignment) return {
      ...base,
      ...tableView,
      role: "DETECTIVE",
      mission: "Someone is hiding a word. Watch the chat.",
    };
    return {
      ...base,
      ...tableView,
      role: "IMPOSTER",
      word: assignment.word,
      category: assignment.category,
      mission: "Get this word into chat naturally in a real sentence before time runs out.",
      note: "You might not be the only Imposter at your table.",
      delivered: Boolean(assignment.smuggle),
      deliveredAt: assignment.smuggle ? formatElapsed(assignment.smuggle.elapsedMs) : null,
      busted: assignment.busted,
      bustedBy: assignment.bustedBy
        ? this.#publicPlayer(table.roster.get(assignment.bustedBy) ?? this.profiles.get(assignment.bustedBy))
        : null,
    };
  }

  getPublicState() {
    const now = this.#now();
    const table = this.tables.get(this.featuredTableId);
    const state = {
      state: this.state,
      phase: this.state,
      roundNumber: this.roundNumber,
      featuredTableId: this.featuredTableId,
      players: table ? [...table.roster.values()].map((player) => this.#publicPlayer(player))
        : [...this.players.values()].map((player) => this.#publicPlayer(player)),
      claimedCount: [...this.players.values()].filter((player) => (
        player.claimed
        && !this.mutedPlayerIds.has(player.id)
        && (this.hostPlays || player.login !== this.streamerLogin)
      )).length,
      scores: this.#leaderboard(),
      leaderboard: this.#leaderboard(),
      tables: [...this.tables.values()].map((entry) => ({
        id: entry.id,
        playerCount: entry.roster.size,
        ...(entry.phaseResult ? { phaseResult: entry.phaseResult } : {}),
      })),
      accusations: [...this.tables.values()].flatMap((entry) => (
        entry.accusationLog.map((accusation) => this.#publicAccusation(entry, accusation))
      )).sort((left, right) => right.at - left.at).slice(0, 12),
      crowdCount: this.#crowdCount(),
      phaseEndsAt: this.#phaseEndsAt(),
      phaseDurationMs: this.state === PHASES.REVEAL
        ? this.#revealDuration() : this.durations[this.state.toLowerCase()] ?? 0,
      remainingMs: Math.max(0, (this.#phaseEndsAt() ?? now) - now),
      newRound: this.state === PHASES.ROUND && now - table?.startedAt < 4_000,
      final: this.isFinalRound,
      canFinal: this.state === PHASES.LOBBY && this.lastRoundSeating.length > 0,
      champion: this.state === PHASES.REVEAL ? this.lastChampion : null,
      sessionOver: this.sessionOver,
      nextSessionStartsAt: this.nextSessionStartsAt,
      hostPlays: this.hostPlays,
      streamerLogin: this.streamerLogin,
      streamerSeated: Boolean(this.#streamerPlayer() && this.#tableForPlayer(this.#streamerPlayer().id)),
    };
    if (!table) return state;
    const round = {
      number: table.number,
      tableId: table.id,
      tableCount: this.tables.size,
      impostorCount: table.impostors.length,
      remainingImpostorCount: table.impostors.filter(({ busted }) => !busted).length,
      totalPlayers: [...this.tables.values()].reduce((sum, entry) => sum + entry.roster.size, 0),
      startedAt: table.startedAt,
      remainingMs: this.state === PHASES.ROUND ? Math.max(0, table.endsAt - now) : 0,
      hints: this.#publicHints(table),
      delivered: this.state === PHASES.REVEAL ? table.impostors.some(({ smuggle }) => smuggle) : undefined,
      players: [...table.roster.values()].map((player) => this.#publicPlayer(player)),
      messageCounts: Object.fromEntries(table.messageCounts),
      messageRecency: Object.fromEntries(table.messages.map((message, index) => [message.userId, index + 1])),
      latestMessages: table.messages.slice(-3).map((message) => this.#publicMessage(message, table)),
      recentMessages: table.messages.slice(-6).map((message) => this.#publicMessage(message, table)),
      voteSavedEarly: Object.fromEntries([...table.earlyVotes.keys()].map((playerId) => [playerId, true])),
      tallies: this.state === PHASES.VOTE ? this.getTallies(table.id) : undefined,
      accusations: table.accusationLog.map((accusation) => this.#publicAccusation(table, accusation)),
      busted: table.impostors.filter(({ busted }) => busted).map((assignment) => ({
        impostor: this.#publicPlayer(table.roster.get(assignment.playerId) ?? this.profiles.get(assignment.playerId)),
        accuser: this.#publicPlayer(this.profiles.get(assignment.bustedBy)),
      })),
      allVotesIn: table.allVotesIn,
    };
    if (this.state === PHASES.REVEAL) round.reveal = table.reveal;
    return { ...state, round };
  }

  getPendingClaim(sessionId) {
    const sid = String(sessionId ?? "");
    const now = this.#now();
    this.#pruneClaims(now);
    const claim = [...this.claims.values()].find((candidate) => candidate.sessionId === sid && candidate.usedAt === null);
    if (!claim) return null;
    return {
      code: claim.code,
      login: claim.login,
      expiresAt: claim.expiresAt,
      ...(claim.error ? { error: claim.error } : {}),
    };
  }

  #startRound(eligible, options, finalRound) {
    if (eligible.length < 3) return { ok: false, reason: "not_enough_claimed" };
    this.cardResults.clear();
    const streamer = this.hostPlays
      ? eligible.find(({ login }) => login === this.streamerLogin)
      : null;
    const regularPlayers = streamer
      ? eligible.filter(({ id }) => id !== streamer.id)
      : eligible;
    const seatedGroups = finalRound
      ? [stableShuffle(regularPlayers, this.random)]
      : regularPlayers.length < 3
        ? [stableShuffle(regularPlayers, this.random)]
        : seatPlayers(regularPlayers, this.random, this.maxTableSize);
    const tableCount = seatedGroups.length;
    const nextFeaturedId = finalRound ? 1 : (this.lastFeaturedTableId % tableCount) + 1;
    if (!finalRound && tableCount > 1 && this.lastFeaturedPlayerIds.size) {
      const sizes = seatedGroups.map((group) => group.length);
      const all = seatedGroups.flat();
      const spotlight = all.filter((player) => this.lastFeaturedPlayerIds.has(player.id));
      const others = all.filter((player) => !this.lastFeaturedPlayerIds.has(player.id));
      const arranged = sizes.map(() => []);
      const nonFeatured = arranged.map((group, index) => ({ group, index }))
        .filter(({ index }) => index + 1 !== nextFeaturedId);
      let destination = 0;
      while (spotlight.length && nonFeatured.some(({ group, index }) => group.length < sizes[index])) {
        const entry = nonFeatured[destination % nonFeatured.length];
        destination += 1;
        if (entry.group.length < sizes[entry.index]) entry.group.push(spotlight.shift());
      }
      const featuredIndex = nextFeaturedId - 1;
      while (others.length && arranged[featuredIndex].length < sizes[featuredIndex]) {
        arranged[featuredIndex].push(others.shift());
      }
      const remaining = [...others, ...spotlight];
      for (const [index, group] of arranged.entries()) {
        while (group.length < sizes[index]) group.push(remaining.shift());
      }
      seatedGroups.splice(0, seatedGroups.length, ...arranged);
    }
    // Keep the broadcaster first in the featured roster. Besides making the
    // host easy to spot, this preserves the single-table seeded role order.
    if (streamer) seatedGroups[nextFeaturedId - 1].unshift(streamer);
    const now = this.#now();
    const previousImpostors = new Set(this.lastImpostorIds);
    const nextImpostors = new Set();
    const nextTables = new Map();
    const nextPlayerTables = new Map();
    for (const [index, group] of seatedGroups.entries()) {
      const id = index + 1;
      const impostorCount = group.length >= 10 ? 2 : 1;
      const fresh = group.filter((player) => !previousImpostors.has(player.id));
      const repeats = group.filter((player) => previousImpostors.has(player.id));
      const candidates = [
        ...stableShuffle(fresh, this.random),
        ...stableShuffle(repeats, this.random),
      ];
      const impostorPlayers = candidates.slice(0, impostorCount);
      const words = this.#pickWords(impostorCount, options, id);
      if (!words) return { ok: false, reason: "word_unavailable" };
      const roster = new Map(group.map((player) => {
        player.messageCount = 0;
        return [player.id, { ...player, messageCount: 0 }];
      }));
      const impostors = impostorPlayers.map((player, assignmentIndex) => ({
        playerId: player.id,
        word: words[assignmentIndex].word,
        category: words[assignmentIndex].category,
        smuggle: null,
        busted: false,
        bustedAt: null,
        bustedBy: null,
        caught: false,
      }));
      for (const player of group) nextPlayerTables.set(player.id, id);
      for (const player of impostorPlayers) nextImpostors.add(player.id);
      nextTables.set(id, {
        id,
        number: this.roundNumber + 1,
        startedAt: now,
        endsAt: now + this.durations.round,
        endedAt: null,
        voteEndsAt: null,
        revealEndsAt: null,
        roster,
        messages: [],
        messageCounts: new Map([...roster.keys()].map((playerId) => [playerId, 0])),
        hints: { category: false, letter: false },
        impostors,
        impostorId: impostors[0].playerId,
        word: impostors[0].word,
        category: impostors[0].category,
        smuggle: null,
        decoys: [],
        accusations: new Map(),
        accusationLog: [],
        earlyVotes: new Map(),
        earlyVoteReplies: new Set(),
        votes: new Map(),
        crowdEarlyVotes: new Map(),
        crowdVotes: new Map(),
        scoreChanges: new Map([...roster.keys()].map((playerId) => [playerId, 0])),
        reveal: null,
        phaseResult: null,
        allVotesIn: false,
      });
    }
    this.roundNumber += 1;
    this.tables = nextTables;
    this.playerTables = nextPlayerTables;
    this.featuredTableId = nextFeaturedId;
    this.lastFeaturedTableId = nextFeaturedId;
    this.currentRound = this.tables.get(nextFeaturedId);
    this.lastImpostorIds = nextImpostors;
    this.lastImpostorId = this.currentRound.impostorId;
    this.lastReveal = null;
    this.lastChampion = null;
    this.sessionOver = false;
    this.nextSessionStartsAt = null;
    this.crowdParticipants.clear();
    this.crowdAccusations.clear();
    this.crowdVoteTables.clear();
    this.roundAccusations.clear();
    this.roundVoteTables.clear();
    this.crowdMessageCount = 0;
    this.votes.clear();
    this.isFinalRound = finalRound;
    this.#transition(PHASES.ROUND);
    this.#setTimer("categoryHint", this.durations.categoryHint, () => this.#showHint("category"));
    this.#setTimer("letterHint", this.durations.letterHint, () => this.#showHint("letter"));
    this.#setTimer("round", this.durations.round, () => this.beginVote());
    this.#publish("round", {
      action: "start",
      roundNumber: this.roundNumber,
      duration: this.durations.round,
      tableCount: this.tables.size,
      final: finalRound,
    });
    return { ok: true, roundNumber: this.roundNumber, tableCount: this.tables.size, featuredTableId: this.featuredTableId, final: finalRound, state: this.state };
  }

  #pickWords(count, options, tableId) {
    const picked = [];
    for (let index = 0; index < count; index += 1) {
      const excluded = new Set(picked.map(({ category }) => category.toLowerCase()));
      const word = this.#pickWord(index === 0 ? options : {}, excluded, tableId, index);
      if (!word) return null;
      picked.push(word);
    }
    return picked;
  }

  #pickWord(options = {}, excludedCategories = new Set(), tableId = 1, impostorIndex = 0) {
    const requested = typeof options === "string" ? { category: options } : options;
    if (requested.word) {
      const word = typeof requested.word === "string" ? requested.word.toLowerCase()
        : String(requested.word.word ?? "").toLowerCase();
      if (!/^[a-z]{4,9}$/.test(word)) return null;
      const catalogEntry = this.words.find((entry) => entry.word === word);
      const category = String(requested.category ?? requested.word.category ?? catalogEntry?.category ?? "general").toLowerCase();
      if (!excludedCategories.has(category)) return { word, category };
    }
    const requestedCategory = requested.category ? String(requested.category).trim().toLowerCase() : null;
    let pool = this.words.filter(({ category }) => !excludedCategories.has(category.toLowerCase()));
    if (requestedCategory && !excludedCategories.has(requestedCategory)) {
      const matching = pool.filter(({ category }) => category.toLowerCase() === requestedCategory);
      if (matching.length) pool = matching;
    }
    if (!pool.length) return null;
    if (this.wordPicker) {
      const candidate = this.wordPicker({ words: [...pool], category: requestedCategory, roundNumber: this.roundNumber + 1, tableId, impostorIndex, random: this.random });
      if (typeof candidate === "string") {
        return pool.find(({ word }) => word === candidate.toLowerCase())
          ?? { word: candidate.toLowerCase(), category: requestedCategory ?? "general" };
      }
      if (candidate?.word) {
        const catalogEntry = this.words.find(({ word }) => word === candidate.word.toLowerCase());
        const category = String(candidate.category ?? catalogEntry?.category ?? requestedCategory ?? "general");
        if (!excludedCategories.has(category.toLowerCase())) {
          return { word: candidate.word.toLowerCase(), category };
        }
      }
    }
    return this.#randomItem(pool);
  }

  #showHint(kind) {
    if (this.state !== PHASES.ROUND || !this.tables.size) return;
    for (const table of this.tables.values()) {
      if (table.impostors.some(({ busted }) => !busted)) table.hints[kind] = true;
    }
    const table = this.tables.get(this.featuredTableId);
    const activeImpostors = table.impostors.filter(({ busted }) => !busted);
    if (!activeImpostors.length) return;
    const value = kind === "category"
      ? [...new Set(activeImpostors.map(({ category }) => category))].join(" · ")
      : [...new Set(activeImpostors.map(({ word }) => word[0]))].join(" · ");
    this.#publish("hint", {
      roundNumber: this.roundNumber,
      tableId: table.id,
      kind,
      value,
      message: `Table ${table.id} hint: ${value}`,
      at: this.#now(),
    });
  }

  #buildTableReveal(table) {
    const tallies = this.getTallies(table.id);
    const unbusted = table.impostors.filter(({ busted }) => !busted);
    const accusedIds = new Set(selectVoteAccused(tallies, unbusted.length));
    for (const assignment of unbusted) assignment.caught = accusedIds.has(assignment.playerId);
    for (const assignment of table.impostors) {
      const delta = assignment.smuggle ? (assignment.busted || assignment.caught ? 1 : 3) : 0;
      this.#addScore(assignment.playerId, delta, table);
    }
    for (const [voterId, targetId] of table.votes) {
      if (table.impostors.find(({ playerId, caught }) => playerId === targetId && caught)) {
        this.#addScore(voterId, 1, table);
        this.#statsFor(voterId).catches += 1;
      }
    }
    for (const player of table.roster.values()) {
      const assignment = table.impostors.find(({ playerId }) => playerId === player.id);
      if (!assignment || (!assignment.busted && !assignment.caught)) {
        this.#statsFor(player.id).roundsSurvived += 1;
      }
    }
    const results = table.impostors.map((assignment) => this.#assignmentReveal(table, assignment));
    const primary = results[0];
    const scoreChanges = [...table.scoreChanges].map(([playerId, delta]) => {
      const player = table.roster.get(playerId) ?? this.profiles.get(playerId);
      const score = this.scores.get(playerId) ?? 0;
      return { player: this.#publicPlayer(player, score), delta, score };
    });
    const botMessage = results.length === 1 ? primary.botMessage
      : `🕵️ Table ${table.id}: ${results.map((result) => `@${result.impostor.login} ${result.word.toUpperCase()} — ${result.verdict}`).join(" · ")}`;
    const caseFileMessage = `Round ${table.number}: ${results.map((result) => (
      result.evidence
        ? result.evidence.source === "voice"
          ? `${result.word.toUpperCase()} was said out loud at ${result.elapsed} · ${result.verdict === "GOT AWAY" ? "nobody noticed" : "caught"}`
          : `${result.word.toUpperCase()} slipped in at ${result.elapsed} · ${result.readerCount} read it · ${result.verdict === "GOT AWAY" ? "nobody noticed" : "caught"}`
        : `${result.word.toUpperCase()} never landed · 0 read it`
    )).join(" · ")}`;
    return {
      ...primary,
      tableId: table.id,
      imposters: results,
      accusedIds: [...accusedIds],
      scoreChanges,
      leaderboard: this.#leaderboard(5),
      botMessage,
      caseFileMessage,
    };
  }

  #assignmentReveal(table, assignment) {
    const impostor = this.#publicPlayer(
      table.roster.get(assignment.playerId) ?? this.profiles.get(assignment.playerId),
      this.scores.get(assignment.playerId) ?? 0,
    );
    const evidence = assignment.smuggle ? this.#revealMessage(assignment.smuggle, table) : null;
    const readers = assignment.smuggle ? [...new Set(
      table.messages.slice(assignment.smuggle.sequence + 1).map(({ userId }) => userId)
        .filter((id) => id !== assignment.playerId),
    )].map((id) => this.#publicPlayer(table.roster.get(id))).filter(Boolean) : [];
    const elapsed = assignment.smuggle ? formatElapsed(assignment.smuggle.elapsedMs) : null;
    const verdict = !assignment.smuggle ? "WORD NEVER LANDED"
      : assignment.busted ? "BUSTED" : assignment.caught ? "CAUGHT" : "GOT AWAY";
    const noticed = assignment.busted || assignment.caught;
    const caption = assignment.smuggle
      ? assignment.smuggle.source === "voice"
        ? `Said out loud on stream. ${noticed ? "Someone noticed." : "Nobody noticed."}`
        : readers.length === 0
          ? `${elapsed} into the round. Nobody spoke after it. ${noticed ? "Someone noticed anyway." : "It slipped by quietly."}`
          : `${elapsed} into the round. ${readers.length} ${readers.length === 1 ? "person" : "people"} read this. ${noticed ? "Someone noticed." : "Nobody noticed."}`
      : "The word never made it out.";
    const sneakiness = !assignment.smuggle ? `Never found a clean opening for '${assignment.word}'.`
      : noticed ? `Slipped '${assignment.word}' in, but chat smelled it.`
        : `Hid '${assignment.word}' in plain sight. Cold.`;
    const delta = table.scoreChanges.get(assignment.playerId) ?? 0;
    const botMessage = assignment.smuggle
      ? assignment.smuggle.source === "voice"
        ? `🕵️ Table ${table.id}: @${impostor.login} was the Imposter! ${assignment.word.toUpperCase()}, said out loud ${elapsed} into the round. ${verdict}. +${delta}`
        : `🕵️ Table ${table.id}: @${impostor.login} was the Imposter! ${assignment.word.toUpperCase()}, hidden ${elapsed} into the round in their message ('${assignment.smuggle.text}'). ${verdict}. +${delta}`
      : `🕵️ Table ${table.id}: @${impostor.login} was the Imposter! ${assignment.word.toUpperCase()}. The word never made it out. ${verdict}. +0`;
    const accidentalDecoys = table.decoys.filter(({ wordOwnerId }) => wordOwnerId === assignment.playerId)
      .map((message) => {
        const decoy = this.#revealMessage(message, table);
        return {
          ...decoy,
          ...(message === table.decoys[0] ? { ribbon: "Most suspicious civilian" } : {}),
          caption: `@${decoy.player.login} said it too, by accident.`,
        };
      });
    return {
      roundNumber: table.number,
      impostor,
      word: assignment.word,
      category: assignment.category,
      smuggled: Boolean(assignment.smuggle),
      evidence,
      elapsed,
      readerCount: readers.length,
      readers,
      caption,
      messages: table.messages.map((message) => this.#publicMessage(message, table)),
      accidentalDecoys,
      votes: [...table.votes].map(([voterId, targetId]) => ({ voterId, targetId })),
      tallies: this.getTallies(table.id),
      busted: assignment.busted,
      bustedBy: assignment.bustedBy ? this.#publicPlayer(this.profiles.get(assignment.bustedBy)) : null,
      caught: assignment.caught,
      verdict,
      outcome: !assignment.smuggle ? "word_never_landed"
        : assignment.busted ? "busted" : assignment.caught ? "caught" : "got_away",
      sneakiness,
      botMessage,
    };
  }

  #phaseResult(results) {
    if (results.length === 1) return results[0].verdict;
    const counts = new Map();
    for (const { verdict } of results) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
    return [...counts].map(([verdict, count]) => `${count} ${verdict}`).join(" · ");
  }

  #revealMessage(message, table) {
    return { ...this.#publicMessage(message, table), index: message.match.index, length: message.match.length };
  }

  #publicMessage(message, table) {
    return {
      id: message.id,
      player: this.#publicPlayer(table.roster.get(message.userId) ?? this.profiles.get(message.userId)),
      text: message.text,
      source: message.source,
      visible: message.visible !== false,
      at: message.at,
      elapsedMs: message.elapsedMs,
      elapsed: formatElapsed(message.elapsedMs),
    };
  }

  #publicHints(table) {
    const active = table.impostors.filter(({ busted }) => !busted);
    return {
      category: table.hints.category && active.length
        ? [...new Set(active.map(({ category }) => category))].join(" · ") : null,
      letter: table.hints.letter && active.length
        ? [...new Set(active.map(({ word }) => word[0]))].join(" · ") : null,
    };
  }

  #publicAccusation(table, accusation) {
    const accuser = this.#publicPlayer(this.profiles.get(accusation.accuserId));
    const target = accusation.correct
      ? this.#publicPlayer(table.roster.get(accusation.targetId) ?? this.profiles.get(accusation.targetId))
      : null;
    const word = accusation.correct
      ? table.impostors.find(({ playerId }) => playerId === accusation.targetId)?.word ?? accusation.word
      : null;
    return {
      tableId: table.id,
      correct: accusation.correct,
      at: accusation.at,
      accuser,
      target,
      word,
      toast: accusation.correct
        ? `@${accuser?.login || "detective"} BUSTED @${target?.login || "imposter"}: ${word.toUpperCase()}`
        : `❌ @${accuser?.login || "player"} guessed wrong`,
      toastKind: accusation.correct ? "busted" : "miss",
    };
  }

  #leaderboard(limit = Infinity) {
    const sorted = [...this.scores.entries()].map(([id, score]) => ({
      player: this.#publicPlayer(this.players.get(id) ?? this.profiles.get(id), score),
      score,
    })).filter(({ player }) => player)
      .sort((left, right) => right.score - left.score || left.player.login.localeCompare(right.player.login));
    return sorted.map((entry, index) => ({
      ...entry,
      rank: sorted.findIndex(({ score }) => score === entry.score) + 1,
    })).slice(0, limit);
  }

  #rankPlayers(players) {
    return [...players].sort((left, right) => {
      const leftStats = this.#statsFor(left.id);
      const rightStats = this.#statsFor(right.id);
      return (this.scores.get(right.id) ?? 0) - (this.scores.get(left.id) ?? 0)
        || rightStats.catches - leftStats.catches
        || rightStats.roundsSurvived - leftStats.roundsSurvived
        || (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
        || (left.joinedAt ?? Number.MAX_SAFE_INTEGER) - (right.joinedAt ?? Number.MAX_SAFE_INTEGER);
    });
  }

  // The final is its own case: winning it outranks carrying a larger score into it.
  #rankFinalPlayers(players, table) {
    return [...players].sort((left, right) => {
      const leftAssignment = table?.impostors.find(({ playerId }) => playerId === left.id);
      const rightAssignment = table?.impostors.find(({ playerId }) => playerId === right.id);
      const leftLostFinal = Number(Boolean(leftAssignment?.busted || leftAssignment?.caught));
      const rightLostFinal = Number(Boolean(rightAssignment?.busted || rightAssignment?.caught));
      const leftStats = this.#statsFor(left.id);
      const rightStats = this.#statsFor(right.id);
      return leftLostFinal - rightLostFinal
        || (table?.scoreChanges.get(right.id) ?? 0) - (table?.scoreChanges.get(left.id) ?? 0)
        || (this.scores.get(right.id) ?? 0) - (this.scores.get(left.id) ?? 0)
        || rightStats.catches - leftStats.catches
        || rightStats.roundsSurvived - leftStats.roundsSurvived
        || (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER);
    });
  }

  #statsFor(playerId) {
    if (!this.playerStats.has(playerId)) {
      this.playerStats.set(playerId, { catches: 0, roundsSurvived: 0 });
    }
    return this.playerStats.get(playerId);
  }

  #addScore(playerId, delta, table) {
    if (!this.scores.has(playerId)) this.scores.set(playerId, 0);
    if (delta) this.scores.set(playerId, (this.scores.get(playerId) ?? 0) + delta);
    table.scoreChanges.set(playerId, (table.scoreChanges.get(playerId) ?? 0) + delta);
  }

  #maybeAutoStartLobby() {
    if (this.state === PHASES.LOBBY && this.lobbyOpenedAt !== null
      && this.#now() - this.lobbyOpenedAt >= this.durations.lobby
      && [...this.players.values()].filter(({ claimed }) => claimed).length >= 3) this.go();
  }

  #enterLobby() {
    if (this.tables.size) {
      const featured = this.tables.get(this.featuredTableId);
      this.lastFeaturedPlayerIds = new Set(featured?.roster.keys() ?? []);
      this.lastFeaturedTableId = this.featuredTableId ?? this.lastFeaturedTableId;
      this.lastRoundSeating = [...this.tables.values()].map((table) => ({ id: table.id, playerIds: [...table.roster.keys()] }));
    }
    this.#clearActiveRound();
    this.lobbyOpenedAt = this.#now();
    this.#transition(PHASES.LOBBY);
    this.#armLobbyTimer();
    this.#armCardResultTimer();
  }

  #armCardResultTimer() {
    if (!this.cardResults.size) return;
    const now = this.#now();
    const nextChangeAt = Math.min(...[...this.cardResults.values()].flatMap((result) => (
      [result.availableAt, result.championUntil].filter((at) => Number.isFinite(at) && at > now)
    )));
    if (!Number.isFinite(nextChangeAt)) return;
    this.#setTimer("cardResults", Math.max(0, nextChangeAt - now), () => {
      for (const [sessionId, session] of this.sessions) {
        if (this.cardResults.has(session.userId)) this.#publishPrivateCard(sessionId);
      }
      this.#armCardResultTimer();
    });
  }

  #armLobbyTimer() {
    this.#setTimer("lobby", this.durations.lobby, () => {
      if (this.state !== PHASES.LOBBY) return;
      if (this.sessionOver) return;
      const result = this.go();
      if (!result.ok && this.state === PHASES.LOBBY) {
        this.lobbyOpenedAt = this.#now();
        this.#armLobbyTimer();
        this.#publish("lobbyTimer", { remainingMs: this.durations.lobby });
      }
    });
  }

  #clearActiveRound() {
    this.tables.clear();
    this.playerTables.clear();
    this.votes.clear();
    this.crowdParticipants.clear();
    this.crowdAccusations.clear();
    this.crowdVoteTables.clear();
    this.roundAccusations.clear();
    this.roundVoteTables.clear();
    this.crowdMessageCount = 0;
    this.currentRound = null;
    this.featuredTableId = null;
    this.isFinalRound = false;
  }

  #streamerPlayer() {
    if (!this.streamerLogin) return null;
    const player = [...this.players.values()].find(({ login }) => login === this.streamerLogin);
    if (!player?.claimed || this.mutedPlayerIds.has(player.id)) return null;
    return player;
  }

  #removeFromActiveTable(playerId) {
    const table = this.#tableForPlayer(playerId);
    if (!table) return null;
    const assignments = table.impostors.filter((assignment) => assignment.playerId === playerId);
    table.impostors = table.impostors.filter((assignment) => assignment.playerId !== playerId);
    table.roster.delete(playerId);
    table.messageCounts.delete(playerId);
    table.votes.delete(playerId);
    table.accusations.delete(playerId);
    for (const [voterId, targetId] of table.votes) {
      if (targetId === playerId) table.votes.delete(voterId);
    }
    this.playerTables.delete(playerId);
    const primary = table.impostors[0] ?? null;
    table.impostorId = primary?.playerId ?? null;
    table.word = primary?.word ?? null;
    table.category = primary?.category ?? null;
    table.smuggle = primary?.smuggle ?? null;
    return { table, assignments };
  }

  #moveStreamerTo(tableId) {
    const streamer = this.#streamerPlayer();
    const destination = this.tables.get(Number(tableId));
    if (!streamer || !destination) return;
    const current = this.#tableForPlayer(streamer.id);
    if (current?.id === destination.id) return;
    const removed = this.#removeFromActiveTable(streamer.id);
    destination.roster.set(streamer.id, { ...streamer, messageCount: 0 });
    destination.messageCounts.set(streamer.id, 0);
    destination.scoreChanges.set(streamer.id, destination.scoreChanges.get(streamer.id) ?? 0);
    if (removed?.assignments.length) {
      destination.impostors.push(...removed.assignments);
      const primary = destination.impostors[0];
      destination.impostorId = primary.playerId;
      destination.word = primary.word;
      destination.category = primary.category;
      destination.smuggle = primary.smuggle;
    }
    this.playerTables.set(streamer.id, destination.id);
  }

  #tableForPlayer(reference) {
    let playerId = reference && typeof reference === "object" ? reference.id ?? reference.userId : reference;
    if (!this.playerTables.has(playerId)) {
      const login = normalizeLogin(playerId);
      playerId = [...this.playerTables.keys()].find((id) => this.tables.get(this.playerTables.get(id))?.roster.get(id)?.login === login);
    }
    return this.tables.get(this.playerTables.get(playerId));
  }

  #rememberParticipant(input) {
    const details = userDetails(input);
    let id = String(details.id ?? "").trim();
    if (!id && details.login) id = this.#resolvePlayer(details.login, this.players)?.id ?? "";
    if (!id) return null;
    const existing = this.players.get(id) ?? this.profiles.get(id);
    const login = normalizeLogin(details.login ?? existing?.login ?? id);
    const profile = {
      id,
      login,
      displayName: String(details.displayName ?? existing?.displayName ?? login),
      avatar: String(details.avatar ?? existing?.avatar ?? ""),
      claimed: Boolean(existing?.claimed),
      joinedAt: existing?.joinedAt ?? this.#now(),
      messageCount: existing?.messageCount ?? 0,
    };
    this.profiles.set(id, profile);
    if (!this.scores.has(id)) this.scores.set(id, 0);
    this.#statsFor(id);
    return profile;
  }

  #crowdCount() {
    const waiting = [...this.players.keys()].filter((id) => !this.playerTables.has(id));
    return new Set([...waiting, ...this.crowdParticipants]).size;
  }

  #resolvePlayer(reference, collection) {
    if (reference && typeof reference === "object") reference = reference.id ?? reference.userId ?? reference.login;
    const value = String(reference ?? "").trim();
    if (!value) return null;
    if (collection.has(value)) return collection.get(value);
    const login = normalizeLogin(value);
    return [...collection.values()].find((player) => player.login === login) ?? null;
  }

  #resolveVoteTarget(reference, table) {
    const explicitNumber = reference && typeof reference === "object" ? reference.number : null;
    if (Number.isInteger(explicitNumber)) {
      return [...table.roster.values()].find(({ number }) => number === explicitNumber) ?? null;
    }
    if (typeof reference === "number" && Number.isInteger(reference)) {
      return [...table.roster.values()].find(({ number }) => number === reference) ?? null;
    }
    return this.#resolvePlayer(reference, table.roster);
  }

  #publicPlayer(player, score = this.scores.get(player?.id) ?? 0) { return publicPlayer(player, score); }

  #randomCode() {
    return Array.from({ length: 4 }, () => CLAIM_CHARACTERS[Math.min(
      CLAIM_CHARACTERS.length - 1,
      Math.floor(this.random() * CLAIM_CHARACTERS.length),
    )]).join("");
  }

  #randomItem(items) {
    const index = Math.min(items.length - 1, Math.floor(this.random() * items.length));
    return items[index];
  }

  #pruneClaims(now) {
    for (const [code, claim] of this.claims) {
      if (!claim.usedAt && now - claim.createdAt >= this.durations.claim) this.claims.delete(code);
    }
  }

  #publishCardsFor(playerId) {
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === playerId) this.#publishPrivateCard(sessionId);
    }
  }

  #now() { return this.clock.now(); }

  #phaseEndsAt() {
    const table = this.tables.get(this.featuredTableId);
    if (this.state === PHASES.LOBBY && this.lobbyOpenedAt !== null) {
      return this.lobbyOpenedAt + this.durations.lobby;
    }
    if (!table) return null;
    if (this.state === PHASES.ROUND) return table.endsAt;
    if (this.state === PHASES.VOTE) return table.voteEndsAt;
    if (this.state === PHASES.REVEAL) return table.revealEndsAt;
    return null;
  }

  #revealDuration() {
    const impostorCount = Math.max(1, ...[...this.tables.values()].map((table) => table.impostors.length));
    const reveal = impostorCount > 1 ? this.durations.revealTwo : this.durations.revealOne;
    return reveal + (this.isFinalRound ? this.durations.championHold : 0);
  }

  #setTimer(name, delay, callback) {
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(name);
      callback();
    }, delay);
    this.timers.set(name, timer);
  }

  #clearTimers() {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
  }

  #transition(nextState) {
    const previous = this.state;
    this.#clearTimers();
    this.state = nextState;
    this.#publish("state", { from: previous, to: nextState });
  }

  #publish(type, payload) {
    const event = { type, at: this.#now(), ...payload };
    this.emit(type, event);
    this.emit("event", event);
  }

  #publishPrivateCard(sessionId) {
    this.emit("card", { type: "card", at: this.#now(), sessionId, card: this.getCard(sessionId) });
  }
}

export default Game;
