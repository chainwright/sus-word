import { EventEmitter } from "node:events";

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
  reveal: 20_000,
});

const CLAIM_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

function publicPlayer(player, score = 0) {
  if (!player) return null;
  return {
    id: player.id,
    login: player.login,
    displayName: player.displayName,
    avatar: player.avatar,
    claimed: Boolean(player.claimed),
    messageCount: player.messageCount ?? 0,
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
    };
  }

  return { id: input, login, ...details };
}

export class Game extends EventEmitter {
  constructor(options = {}) {
    super();
    const sourceClock = options.clock ?? SYSTEM_CLOCK;
    this.clock = {
      now: () => Number(
        typeof sourceClock.now === "function" ? sourceClock.now() : sourceClock.now,
      ),
      setTimeout: (callback, delay) => sourceClock.setTimeout(callback, delay),
      clearTimeout: (timer) => sourceClock.clearTimeout(timer),
    };
    this.random = options.random ?? Math.random;
    this.wordPicker = options.wordPicker ?? null;
    this.codeGenerator = options.codeGenerator ?? null;
    this.words = options.words ?? WORDS;
    this.durations = { ...DEFAULT_DURATIONS, ...options.durations };

    this.state = PHASES.IDLE;
    this.roundNumber = 0;
    this.players = new Map();
    this.profiles = new Map();
    this.scores = new Map();
    this.claims = new Map();
    this.sessions = new Map();
    this.votes = new Map();
    this.currentRound = null;
    this.lastReveal = null;
    this.lastImpostorId = null;
    this.lobbyOpenedAt = null;
    this.timers = new Map();
  }

  get phase() {
    return this.state;
  }

  start() {
    if (this.state !== PHASES.IDLE) {
      return { ok: false, reason: "invalid_state" };
    }
    this.#enterLobby();
    return { ok: true, state: this.state };
  }

  end() {
    if (this.state === PHASES.IDLE) {
      return { ok: false, reason: "invalid_state" };
    }
    this.currentRound = null;
    this.votes.clear();
    this.#transition(PHASES.IDLE);
    return { ok: true, state: this.state };
  }

  reset() {
    this.#clearTimers();
    this.players.clear();
    this.profiles.clear();
    this.scores.clear();
    this.claims.clear();
    this.sessions.clear();
    this.votes.clear();
    this.currentRound = null;
    this.lastReveal = null;
    this.lastImpostorId = null;
    this.lobbyOpenedAt = null;
    this.roundNumber = 0;
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
    const profile = {
      id,
      login: normalized,
      displayName: String(user.displayName ?? existing?.displayName ?? user.login ?? normalized),
      avatar: String(user.avatar ?? existing?.avatar ?? ""),
    };
    const claimed = Boolean(
      existing?.claimed
      || [...this.sessions.values()].some((session) => session.userId === id),
    );
    const player = {
      ...profile,
      claimed,
      joinedAt: existing?.joinedAt ?? this.#now(),
      messageCount: existing?.messageCount ?? 0,
    };

    this.players.set(id, player);
    this.profiles.set(id, { ...player });
    if (!this.scores.has(id)) this.scores.set(id, 0);
    this.#publish("player", {
      action: existing ? "update" : "join",
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
    if (this.state === PHASES.VOTE) this.#finishIfEveryoneVoted();
    return { ok: true, player: this.#publicPlayer(player) };
  }

  createClaim(sessionOrOptions, requestedLogin) {
    const options = sessionOrOptions && typeof sessionOrOptions === "object"
      ? sessionOrOptions
      : { sessionId: sessionOrOptions, login: requestedLogin };
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
        ? String(this.codeGenerator()).trim().toUpperCase()
        : this.#randomCode();
      if (/^[A-HJ-NP-Z2-9]{4}$/.test(code) && !this.claims.has(code)) break;
      code = null;
    }
    if (!code) return { ok: false, reason: "code_unavailable" };

    const claim = {
      code,
      sessionId,
      login,
      createdAt: now,
      expiresAt: now + this.durations.claim,
      usedAt: null,
      userId: null,
    };
    this.claims.set(code, claim);
    return { ok: true, code, login, expiresAt: claim.expiresAt };
  }

  claim(codeOrOptions, chatter, userId) {
    const options = codeOrOptions && typeof codeOrOptions === "object"
      ? codeOrOptions
      : typeof chatter === "object"
        ? { code: codeOrOptions, ...chatter }
        : { code: codeOrOptions, login: chatter, userId };
    const code = String(options.code ?? "").trim().toUpperCase();
    const claim = this.claims.get(code);
    if (!claim) return { ok: false, reason: "invalid_code" };
    if (claim.usedAt !== null) return { ok: false, reason: "code_used" };
    if (this.#now() - claim.createdAt >= this.durations.claim) {
      this.claims.delete(code);
      return { ok: false, reason: "code_expired" };
    }

    const login = normalizeLogin(
      options.login ?? options.chatterLogin ?? options.userLogin,
    );
    if (login !== claim.login) return { ok: false, reason: "name_mismatch" };

    const id = String(options.userId ?? options.id ?? "").trim();
    if (!id) return { ok: false, reason: "invalid_player" };
    const linkedSession = this.sessions.get(claim.sessionId);
    if (linkedSession && linkedSession.userId !== id) {
      return { ok: false, reason: "session_linked" };
    }

    const now = this.#now();
    claim.usedAt = now;
    claim.userId = id;
    this.sessions.set(claim.sessionId, { userId: id, linkedAt: now });
    const joined = this.join({
      id,
      login,
      displayName: options.displayName ?? options.userName ?? login,
      avatar: options.avatar ?? options.profileImageUrl ?? "",
    });
    const player = this.players.get(id);
    player.claimed = true;
    this.profiles.set(id, { ...player });
    this.#publish("claim", {
      player: this.#publicPlayer(player),
    });
    this.#maybeAutoStartLobby();
    return {
      ok: true,
      sessionId: claim.sessionId,
      joined: joined.joined,
      player: this.#publicPlayer(player),
    };
  }

  go(options = {}) {
    if (this.state !== PHASES.LOBBY) {
      return { ok: false, reason: "invalid_state" };
    }
    const claimed = [...this.players.values()].filter((player) => player.claimed);
    if (claimed.length < 3) return { ok: false, reason: "not_enough_claimed" };

    let candidates = claimed;
    if (claimed.length > 1 && this.lastImpostorId) {
      candidates = claimed.filter((player) => player.id !== this.lastImpostorId);
    }
    const impostor = this.#randomItem(candidates);
    const pickedWord = this.#pickWord(options);
    if (!pickedWord) return { ok: false, reason: "word_unavailable" };

    const now = this.#now();
    this.roundNumber += 1;
    this.lastImpostorId = impostor.id;
    this.votes.clear();
    const roster = new Map();
    for (const player of this.players.values()) {
      player.messageCount = 0;
      roster.set(player.id, { ...player, messageCount: 0 });
    }
    this.currentRound = {
      number: this.roundNumber,
      startedAt: now,
      endsAt: now + this.durations.round,
      endedAt: null,
      impostorId: impostor.id,
      word: pickedWord.word,
      category: pickedWord.category,
      roster,
      messages: [],
      messageCounts: new Map([...roster.keys()].map((id) => [id, 0])),
      hints: { category: false, letter: false },
      smuggle: null,
      decoys: [],
      reveal: null,
    };
    this.#transition(PHASES.ROUND);
    this.#setTimer("categoryHint", this.durations.categoryHint, () => {
      this.#showHint("category");
    });
    this.#setTimer("letterHint", this.durations.letterHint, () => {
      this.#showHint("letter");
    });
    this.#setTimer("round", this.durations.round, () => this.beginVote());
    this.#publish("round", {
      action: "start",
      roundNumber: this.roundNumber,
      duration: this.durations.round,
    });
    return { ok: true, roundNumber: this.roundNumber, state: this.state };
  }

  recordMessage(input, text) {
    if (this.state !== PHASES.ROUND || !this.currentRound) {
      return { ok: false, reason: "invalid_state" };
    }
    const options = input && typeof input === "object"
      ? input
      : { userId: input, text };
    const player = this.#resolvePlayer(
      options.userId ?? options.id ?? options.login,
      this.currentRound.roster,
    );
    const messageText = String(options.text ?? options.message ?? "");
    if (!player || !messageText) return { ok: false, reason: "invalid_message" };

    const now = this.#now();
    const message = {
      id: String(options.messageId ?? options.idempotencyKey
        ?? `${this.roundNumber}:${this.currentRound.messages.length + 1}`),
      userId: player.id,
      login: player.login,
      displayName: player.displayName,
      avatar: player.avatar,
      text: messageText,
      at: now,
      elapsedMs: Math.max(0, now - this.currentRound.startedAt),
      sequence: this.currentRound.messages.length,
    };
    this.currentRound.messages.push(message);
    const count = (this.currentRound.messageCounts.get(player.id) ?? 0) + 1;
    this.currentRound.messageCounts.set(player.id, count);
    const activePlayer = this.players.get(player.id);
    if (activePlayer) activePlayer.messageCount = count;

    const match = findWord(messageText, this.currentRound.word);
    let delivered = false;
    let decoy = false;
    if (match.hit && player.id === this.currentRound.impostorId) {
      if (!this.currentRound.smuggle) {
        this.currentRound.smuggle = { ...message, match };
        delivered = true;
        for (const [sessionId, session] of this.sessions) {
          if (session.userId === player.id) {
            this.#publishPrivateCard(sessionId);
          }
        }
      }
    } else if (match.hit) {
      this.currentRound.decoys.push({ ...message, match });
      decoy = true;
    }

    this.#publish("message", { message: { ...message }, messageCount: count });
    return { ok: true, message: { ...message }, delivered, decoy };
  }

  beginVote() {
    if (this.state !== PHASES.ROUND || !this.currentRound) {
      return { ok: false, reason: "invalid_state" };
    }
    this.currentRound.endedAt = this.#now();
    this.votes.clear();
    this.#transition(PHASES.VOTE);
    this.#setTimer("vote", this.durations.vote, () => this.finishVote());
    this.#publish("voteStart", {
      roundNumber: this.roundNumber,
      duration: this.durations.vote,
      message: "Vote! !vote name",
    });
    return { ok: true, state: this.state };
  }

  vote(voterReference, targetReference) {
    if (this.state !== PHASES.VOTE || !this.currentRound) {
      return { ok: false, reason: "invalid_state" };
    }
    const voter = this.#resolvePlayer(voterReference, this.players);
    if (!voter || !this.currentRound.roster.has(voter.id)) {
      return { ok: false, reason: "not_a_player" };
    }
    const target = this.#resolvePlayer(targetReference, this.currentRound.roster);
    if (!target) return { ok: false, reason: "unknown_target" };
    if (voter.id === target.id) return { ok: false, reason: "self_vote" };

    const previousTargetId = this.votes.get(voter.id) ?? null;
    this.votes.set(voter.id, target.id);
    const result = {
      ok: true,
      replaced: previousTargetId !== null,
      previousTargetId,
      voterId: voter.id,
      targetId: target.id,
      tallies: this.getTallies(),
    };
    this.#publish("vote", result);
    this.#finishIfEveryoneVoted();
    return { ...result, state: this.state };
  }

  finishVote() {
    if (this.state !== PHASES.VOTE || !this.currentRound) {
      return { ok: false, reason: "invalid_state" };
    }

    const reveal = this.#buildReveal();
    this.currentRound.reveal = reveal;
    this.lastReveal = reveal;
    this.#transition(PHASES.REVEAL);
    this.#publish("reveal", reveal);
    this.#setTimer("reveal", this.durations.reveal, () => this.nextRound());
    return { ok: true, state: this.state, reveal };
  }

  nextRound() {
    if (this.state !== PHASES.REVEAL) {
      return { ok: false, reason: "invalid_state" };
    }
    this.#enterLobby();
    return { ok: true, state: this.state };
  }

  getTallies() {
    if (!this.currentRound) return [];
    const counts = new Map(
      [...this.currentRound.roster.keys()].map((playerId) => [playerId, 0]),
    );
    for (const targetId of this.votes.values()) {
      counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
    }
    return [...this.currentRound.roster.values()].map((player) => ({
      player: this.#publicPlayer(player),
      votes: counts.get(player.id) ?? 0,
    }));
  }

  getCard(sessionId) {
    const session = this.sessions.get(String(sessionId ?? ""));
    if (!session) return { linked: false, role: null };
    const player = this.players.get(session.userId) ?? this.profiles.get(session.userId);
    if (!player) return { linked: true, joined: false, role: null };

    const base = {
      linked: true,
      joined: this.players.has(session.userId),
      player: this.#publicPlayer(player),
      state: this.state,
      roundNumber: this.roundNumber,
    };
    if (
      !this.currentRound
      || ![PHASES.ROUND, PHASES.VOTE, PHASES.REVEAL].includes(this.state)
      || !this.currentRound.roster.has(session.userId)
    ) {
      return { ...base, role: null };
    }
    if (session.userId !== this.currentRound.impostorId) {
      return {
        ...base,
        role: "DETECTIVE",
        mission: "Someone is hiding a word. Watch the chat.",
      };
    }
    return {
      ...base,
      role: "IMPOSTER",
      word: this.currentRound.word,
      category: this.currentRound.category,
      mission: "Get this word into chat naturally in a real sentence before time runs out.",
      delivered: Boolean(this.currentRound.smuggle),
    };
  }

  getPublicState() {
    const now = this.#now();
    const state = {
      state: this.state,
      phase: this.state,
      roundNumber: this.roundNumber,
      players: [...this.players.values()].map((player) => this.#publicPlayer(player)),
      claimedCount: [...this.players.values()].filter((player) => player.claimed).length,
      scores: this.#leaderboard(),
    };
    if (!this.currentRound) return state;

    const round = {
      number: this.currentRound.number,
      startedAt: this.currentRound.startedAt,
      remainingMs: this.state === PHASES.ROUND
        ? Math.max(0, this.currentRound.endsAt - now)
        : 0,
      hints: {
        category: this.currentRound.hints.category ? this.currentRound.category : null,
        letter: this.currentRound.hints.letter ? this.currentRound.word[0] : null,
      },
      delivered: this.state === PHASES.REVEAL
        ? Boolean(this.currentRound.smuggle)
        : undefined,
      messageCounts: Object.fromEntries(this.currentRound.messageCounts),
      tallies: this.state === PHASES.VOTE ? this.getTallies() : undefined,
    };
    if (this.state === PHASES.REVEAL) round.reveal = this.currentRound.reveal;
    return { ...state, round };
  }

  #enterLobby() {
    this.currentRound = null;
    this.votes.clear();
    this.lobbyOpenedAt = this.#now();
    this.#transition(PHASES.LOBBY);
    this.#armLobbyTimer();
  }

  #armLobbyTimer() {
    this.#setTimer("lobby", this.durations.lobby, () => {
      if (this.state !== PHASES.LOBBY) return;
      const result = this.go();
      if (!result.ok && this.state === PHASES.LOBBY) this.#armLobbyTimer();
    });
  }

  #pickWord(options) {
    const requested = typeof options === "string" ? { category: options } : options;
    if (requested.word) {
      const word = typeof requested.word === "string"
        ? requested.word.toLowerCase()
        : String(requested.word.word ?? "").toLowerCase();
      if (!/^[a-z]{4,9}$/.test(word)) return null;
      const catalogEntry = this.words.find((entry) => entry.word === word);
      return {
        word,
        category: requested.category
          ?? requested.word.category
          ?? catalogEntry?.category
          ?? "general",
      };
    }

    const category = requested.category
      ? String(requested.category).trim().toLowerCase()
      : null;
    const choices = category
      ? this.words.filter((entry) => entry.category.toLowerCase() === category)
      : this.words;
    const pool = choices.length ? choices : this.words;
    if (!pool.length) return null;
    if (this.wordPicker) {
      const picked = this.wordPicker({
        words: [...pool],
        category,
        roundNumber: this.roundNumber + 1,
        random: this.random,
      });
      if (typeof picked === "string") {
        const entry = pool.find(({ word }) => word === picked.toLowerCase());
        return entry ?? { word: picked.toLowerCase(), category: category ?? "general" };
      }
      if (picked?.word) return { word: picked.word.toLowerCase(), category: picked.category };
    }
    return this.#randomItem(pool);
  }

  #showHint(kind) {
    if (this.state !== PHASES.ROUND || !this.currentRound) return;
    if (this.currentRound.hints[kind]) return;
    this.currentRound.hints[kind] = true;
    const value = kind === "category"
      ? this.currentRound.category
      : this.currentRound.word[0];
    this.#publish("hint", {
      roundNumber: this.roundNumber,
      kind,
      value,
      message: kind === "category" ? `Category: ${value}` : `Starts with: ${value}`,
      at: this.#now(),
    });
  }

  #buildReveal() {
    const round = this.currentRound;
    const tallies = this.getTallies();
    const impostorVotes = tallies.find(({ player }) => player.id === round.impostorId)?.votes ?? 0;
    const highestVotes = Math.max(0, ...tallies.map(({ votes }) => votes));
    // The spec has no runoff, so a joint-high tally counts as caught.
    const caught = impostorVotes > 0 && impostorVotes === highestVotes;
    const scoreChanges = [];

    for (const player of round.roster.values()) {
      let delta = 0;
      if (
        caught
        && player.id !== round.impostorId
        && this.votes.get(player.id) === round.impostorId
      ) {
        delta = 1;
      } else if (player.id === round.impostorId && round.smuggle && !caught) {
        delta = 3;
      }
      const score = (this.scores.get(player.id) ?? 0) + delta;
      this.scores.set(player.id, score);
      scoreChanges.push({ player: this.#publicPlayer(player, score), delta, score });
    }

    const impostor = this.#publicPlayer(
      round.roster.get(round.impostorId),
      this.scores.get(round.impostorId) ?? 0,
    );
    const evidence = round.smuggle ? this.#revealMessage(round.smuggle) : null;
    const readers = round.smuggle
      ? [...new Set(
          round.messages
            .slice(round.smuggle.sequence + 1)
            .map((message) => message.userId)
            .filter((id) => id !== round.impostorId),
        )].map((id) => this.#publicPlayer(round.roster.get(id)))
      : [];
    const elapsed = round.smuggle ? formatElapsed(round.smuggle.elapsedMs) : null;
    const verdict = !round.smuggle
      ? "WORD NEVER LANDED"
      : caught ? "CAUGHT" : "GOT AWAY";
    const caption = round.smuggle
      ? `${elapsed} into the round. ${readers.length} ${readers.length === 1 ? "person" : "people"} read this. ${caught ? "Someone noticed." : "Nobody noticed."}`
      : "The word never made it out.";
    const sneakiness = round.smuggle
      ? `Hid '${round.word}' in plain sight. Cold.`
      : `Never found a clean opening for '${round.word}'.`;
    const impostorDelta = scoreChanges.find(({ player }) => player.id === round.impostorId)?.delta ?? 0;
    const botMessage = round.smuggle
      ? `🕵️ It was @${impostor.login}! Word: ${round.word.toUpperCase()}, smuggled at ${elapsed} ('${round.smuggle.text}'). ${verdict}. +${impostorDelta}`
      : `🕵️ It was @${impostor.login}! Word: ${round.word.toUpperCase()}. The word never made it out. ${verdict}. +0`;

    const accidentalDecoys = round.decoys.map((message) => {
      const decoy = this.#revealMessage(message);
      return { ...decoy, caption: `@${decoy.player.login} said it too, by accident.` };
    });

    return {
      roundNumber: round.number,
      impostor,
      word: round.word,
      category: round.category,
      smuggled: Boolean(round.smuggle),
      evidence,
      elapsed,
      readerCount: readers.length,
      readers,
      caption,
      messages: round.messages.map((message) => this.#publicMessage(message)),
      accidentalDecoys,
      votes: [...this.votes].map(([voterId, targetId]) => ({ voterId, targetId })),
      tallies,
      caught,
      verdict,
      outcome: !round.smuggle
        ? "word_never_landed"
        : caught ? "caught" : "got_away",
      scoreChanges,
      leaderboard: this.#leaderboard(5),
      sneakiness,
      botMessage,
    };
  }

  #revealMessage(message) {
    return {
      ...this.#publicMessage(message),
      index: message.match.index,
      length: message.match.length,
    };
  }

  #publicMessage(message) {
    return {
      id: message.id,
      player: this.#publicPlayer(this.currentRound.roster.get(message.userId)),
      text: message.text,
      at: message.at,
      elapsedMs: message.elapsedMs,
      elapsed: formatElapsed(message.elapsedMs),
    };
  }

  #leaderboard(limit = Infinity) {
    return [...this.scores.entries()]
      .map(([id, score]) => ({
        player: this.#publicPlayer(this.players.get(id) ?? this.profiles.get(id), score),
        score,
      }))
      .filter(({ player }) => player)
      .sort((left, right) => (
        right.score - left.score || left.player.login.localeCompare(right.player.login)
      ))
      .slice(0, limit);
  }

  #finishIfEveryoneVoted() {
    if (this.state !== PHASES.VOTE || !this.currentRound) return;
    const eligible = [...this.currentRound.roster.keys()]
      .filter((id) => this.players.has(id));
    if (eligible.length && eligible.every((id) => this.votes.has(id))) {
      this.finishVote();
    }
  }

  #maybeAutoStartLobby() {
    if (
      this.state === PHASES.LOBBY
      && this.lobbyOpenedAt !== null
      && this.#now() - this.lobbyOpenedAt >= this.durations.lobby
      && [...this.players.values()].filter((player) => player.claimed).length >= 3
    ) {
      this.go();
    }
  }

  #resolvePlayer(reference, collection) {
    if (reference && typeof reference === "object") {
      reference = reference.id ?? reference.userId ?? reference.login;
    }
    const value = String(reference ?? "").trim();
    if (!value) return null;
    if (collection.has(value)) return collection.get(value);
    const login = normalizeLogin(value);
    return [...collection.values()].find((player) => player.login === login) ?? null;
  }

  #publicPlayer(player, score = this.scores.get(player?.id) ?? 0) {
    return publicPlayer(player, score);
  }

  #randomCode() {
    return Array.from(
      { length: 4 },
      () => CLAIM_CHARACTERS[Math.min(
        CLAIM_CHARACTERS.length - 1,
        Math.floor(this.random() * CLAIM_CHARACTERS.length),
      )],
    ).join("");
  }

  #randomItem(items) {
    const index = Math.min(items.length - 1, Math.floor(this.random() * items.length));
    return items[index];
  }

  #pruneClaims(now) {
    for (const [code, claim] of this.claims) {
      if (!claim.usedAt && now - claim.createdAt >= this.durations.claim) {
        this.claims.delete(code);
      }
    }
  }

  #now() {
    return this.clock.now();
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
    this.emit("card", {
      type: "card",
      at: this.#now(),
      sessionId,
      card: this.getCard(sessionId),
    });
  }
}

export default Game;
