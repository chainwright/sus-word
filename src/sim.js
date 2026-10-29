import "dotenv/config";

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { avatarDataUri } from "./demo.js";
import Game, { PHASES } from "./game.js";
import { createSusWordServer } from "./server.js";
import TwitchClient from "./twitch.js";

const REHEARSAL_DURATIONS = Object.freeze({
  lobby: 30 * 60_000,
});

const FAST_DURATIONS = Object.freeze({
  lobby: 30 * 60_000,
  categoryHint: 12_000,
  letterHint: 28_000,
  round: 36_000,
  vote: 8_000,
  voteGrace: 6_000,
  reveal: 4_000,
});

const SIM_NAMES = ["Mara", "TomTom", "Fox", "Juno", "Ollie", "Bea", "Kit", "Remy", "Sol", "Nico", "Ari", "Zee"];
const SIM_COLORS = ["#51405f", "#7653a5", "#d56a3d", "#477b86", "#81613f", "#3f6881"];

const TOPIC_LINES = Object.freeze({
  food: [
    "I forgot my tea until it went completely cold",
    "dinner before stream was definitely the right call",
    "now chat has me thinking about snacks again",
  ],
  home: [
    "the lamp beside my desk keeps flickering tonight",
    "I finally cleaned the shelf behind my monitor",
    "someone remind me to close the kitchen window",
  ],
  nature: [
    "the rain outside is louder than the game music",
    "it got dark so early here today",
    "the wind keeps rattling something on the balcony",
  ],
  entertainment: [
    "this soundtrack makes everything feel suspicious",
    "I still need a new show for after stream",
    "that last round had a perfect plot twist",
  ],
  animals: ["my cat has claimed the warmest spot on the desk", "a dog outside keeps reacting to every car"],
  travel: ["the bus home was unusually quiet tonight", "I still have not unpacked from my last trip"],
  technology: ["my phone battery always disappears during streams", "the keyboard lights just changed by themselves"],
  sports: ["that game last night was much closer than expected", "I should stretch after sitting here all evening"],
  work: ["my inbox somehow filled up again this afternoon", "today's last meeting could have been much shorter"],
  people: ["my neighbor waved through the window earlier", "everyone I know is awake unusually late tonight"],
  clothing: ["I found my missing sock behind the desk", "this sweater is doing all the work tonight"],
  places: ["the little cafe near me changed its hours again", "downtown was completely empty on the way home"],
  objects: ["something keeps rolling around under my chair", "my desk has collected too many tiny things"],
  feelings: ["the countdown makes everything feel more dramatic", "I am weirdly confident about this theory"],
  colors: ["the room lights look much warmer on camera", "the sky turned a strange shade before sunset"],
  actions: ["I keep getting up and forgetting what I needed", "someone is typing very carefully right now"],
  fantasy: ["this music sounds like a quest is about to start", "chat would absolutely investigate a haunted castle"],
  events: ["the weekend arrived much faster than expected", "I nearly forgot about tomorrow's plans"],
  default: [
    "that sounded much more suspicious than intended",
    "someone in chat is choosing every word carefully",
    "the timer always feels faster when I am typing",
    "I genuinely have no useful theory yet",
  ],
});

const SMUGGLE_LINES = [
  (word) => `I was looking for my ${word} before the stream started`,
  (word) => `somehow the ${word} ended up beside my monitor again`,
  (word) => `my neighbor mentioned a ${word} earlier and now I keep thinking about it`,
  (word) => `I nearly forgot the ${word} when I moved everything off my desk`,
];

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function pick(items, random) {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

function parseOption(name, fallback, argv = process.argv) {
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function createSeededRandom(seed = "sus-word") {
  let hash = 2166136261;
  for (const character of String(seed)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function simProfiles(count = 3) {
  return Array.from({ length: count }, (_, index) => {
    const base = SIM_NAMES[index % SIM_NAMES.length];
    const suffix = index >= SIM_NAMES.length ? String(Math.floor(index / SIM_NAMES.length) + 1) : "";
    return {
      id: `sim-${index + 1}`,
      login: `sim_${base.toLowerCase()}${suffix}`,
      displayName: `Sim ${base}${suffix}`,
      avatar: avatarDataUri(SIM_COLORS[index % SIM_COLORS.length], `S${(index % 9) + 1}`),
      sessionId: `sim-session-${index + 1}`,
      simulated: true,
    };
  });
}

function topicLine(category, random) {
  const key = String(category || "").toLowerCase();
  const lines = TOPIC_LINES[key] || TOPIC_LINES.default;
  return pick(lines, random);
}

function smuggleWindow(roundDuration) {
  if (roundDuration >= 140_000) return { earliest: 40_000, latest: 140_000 };
  return {
    earliest: Math.round(roundDuration * (40 / 180)),
    latest: Math.round(roundDuration * (140 / 180)),
  };
}

export function createRoundPlan({ table, sims, roundDuration, voteDuration, voteGrace, random }) {
  const simulated = sims.filter(({ id }) => table.roster.has(id));
  const assignments = table.impostors.filter(({ playerId }) => simulated.some(({ id }) => id === playerId));
  const category = table.impostors[0]?.category;
  const interval = roundDuration < 60_000 ? 3_000 : 7_000;
  const messages = [];
  let cursor = interval * (.7 + random() * .5);
  while (cursor < roundDuration - 1_000 && simulated.length) {
    const player = pick(simulated, random);
    messages.push({
      atMs: Math.round(cursor),
      playerId: player.id,
      text: topicLine(category, random),
      smuggle: false,
    });
    cursor += interval * (.75 + random() * .65);
  }

  const window = smuggleWindow(roundDuration);
  for (const assignment of assignments) {
    const atMs = Math.round(window.earliest + random() * (window.latest - window.earliest));
    messages.push({
      atMs,
      playerId: assignment.playerId,
      text: pick(SMUGGLE_LINES, random)(assignment.word),
      smuggle: true,
      word: assignment.word,
    });
  }
  messages.sort((left, right) => left.atMs - right.atMs || left.playerId.localeCompare(right.playerId));

  const roster = [...table.roster.values()];
  const impostorIds = new Set(table.impostors.map(({ playerId }) => playerId));
  const votes = simulated.map((player, index) => {
    const others = roster.filter(({ id }) => id !== player.id);
    const knownImpostors = others.filter(({ id }) => impostorIds.has(id));
    const target = knownImpostors.length && random() < .62 ? pick(knownImpostors, random) : pick(others, random);
    const graceVote = index === simulated.length - 1;
    return {
      atMs: graceVote
        ? Math.round(voteDuration + Math.max(400, random() * Math.max(800, voteGrace - 400)))
        : Math.round(700 + random() * Math.min(5_000, voteDuration * .55)),
      playerId: player.id,
      targetNumber: target?.number,
      grace: graceVote,
    };
  }).filter(({ targetNumber }) => Number.isInteger(targetNumber));

  return { messages, votes };
}

export async function seatSimPlayers(game, service, profiles) {
  for (const profile of profiles) {
    await service.handleChatMessage({
      userId: profile.id,
      login: profile.login,
      displayName: profile.displayName,
      id: `sim-seen-${profile.id}`,
      text: "ready for rehearsal",
    });
    if (!service.checkChatName(profile.login).seen) throw new Error(`name check failed for ${profile.login}`);
    const claim = game.createClaim({ sessionId: profile.sessionId, login: profile.login });
    const linked = game.claim({ ...profile, code: claim.code, userId: profile.id });
    if (!linked.ok) throw new Error(`could not link ${profile.login}: ${linked.reason}`);
  }
  return profiles;
}

export function recordSimMessage(game, player, text, sequence = 0) {
  return game.recordMessage({
    userId: player.id,
    login: player.login,
    displayName: player.displayName,
    messageId: `sim-${game.roundNumber}-${sequence}-${player.id}`,
    text,
    transport: "direct",
  });
}

function planCurrentRound(game, sims, random) {
  return [...game.tables.values()].map((table) => ({
    table,
    plan: createRoundPlan({
      table,
      sims,
      roundDuration: game.durations.round,
      voteDuration: game.durations.vote,
      voteGrace: game.durations.voteGrace,
      random,
    }),
  }));
}

async function playRound(game, sims, plans, log) {
  const events = plans.flatMap(({ table, plan }) => plan.messages.map((message) => ({ ...message, tableId: table.id })))
    .sort((left, right) => left.atMs - right.atMs || left.playerId.localeCompare(right.playerId));
  const startedAt = game.currentRound?.startedAt ?? Date.now();
  let sequence = 0;
  for (const event of events) {
    const delay = event.atMs - (Date.now() - startedAt);
    if (delay > 0) await sleep(delay);
    if (game.phase !== PHASES.ROUND) break;
    const player = sims.find(({ id }) => id === event.playerId);
    if (!player || game.playerTables.get(player.id) !== event.tableId) continue;
    const result = recordSimMessage(game, player, event.text, sequence++);
    if (result.ok) log(`[sim] #${game.players.get(player.id)?.number} ${player.displayName}: ${event.text}${event.smuggle ? " [word hidden]" : ""}`);
  }
}

async function castVotes(game, sims, plans, log) {
  const votes = plans.flatMap(({ table, plan }) => plan.votes.map((vote) => ({ ...vote, tableId: table.id })));
  const startedAt = Date.now();
  await Promise.all(votes.map(async (vote) => {
    await sleep(Math.max(0, vote.atMs - (Date.now() - startedAt)));
    if (game.phase !== PHASES.VOTE || game.playerTables.get(vote.playerId) !== vote.tableId) return;
    const player = sims.find(({ id }) => id === vote.playerId);
    const result = game.vote({ userId: vote.playerId, login: player?.login }, { number: vote.targetNumber });
    if (result.ok) log(`[sim] ${player.displayName} voted ${vote.targetNumber}${vote.grace ? " during grace" : ""}`);
  }));
}

export async function runSim(options = {}) {
  const argv = options.argv ?? process.argv;
  const playerCount = boundedInteger(options.players ?? parseOption("players", 3, argv), 3, 1, 50);
  const roundLimitValue = options.rounds ?? parseOption("rounds", null, argv);
  const roundLimit = roundLimitValue === null ? Infinity : boundedInteger(roundLimitValue, Infinity, 1, 100);
  const fast = options.fast ?? argv.includes("--fast");
  const seed = options.seed ?? parseOption("seed", "sus-word", argv);
  const log = options.log ?? console.log;
  const random = options.random ?? createSeededRandom(seed);
  const sims = simProfiles(playerCount);
  const game = options.game ?? new Game({
    random,
    durations: fast ? FAST_DURATIONS : REHEARSAL_DURATIONS,
  });
  const twitch = options.twitch ?? new TwitchClient();
  const service = options.service ?? createSusWordServer({ game, twitch });

  await service.start();
  game.start();
  await seatSimPlayers(game, service, sims);
  log(`[sim] ${playerCount} simulated players ready · seed ${seed}. Start with !sus go in Twitch chat.`);

  let completedRounds = 0;
  let activePlans = [];
  let stopping = false;
  let stopAfterReveal = false;
  const onState = ({ to }) => {
    if (to === PHASES.ROUND) {
      activePlans = planCurrentRound(game, sims, random);
      playRound(game, sims, activePlans, log).catch((error) => log(`[sim] ${error.message}`));
    }
    if (to === PHASES.VOTE) {
      castVotes(game, sims, activePlans, log).catch((error) => log(`[sim] ${error.message}`));
    }
    if (to === PHASES.REVEAL) {
      completedRounds += 1;
      log(`[sim] round ${completedRounds} complete`);
      stopAfterReveal = completedRounds >= roundLimit;
    }
    if (to === PHASES.LOBBY && stopAfterReveal) {
      stop().catch((error) => log(`[sim] ${error.message}`));
    }
  };
  game.on("state", onState);

  async function stop() {
    if (stopping) return;
    stopping = true;
    game.off("state", onState);
    game.reset();
    await service.stop();
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { game, service, twitch, sims, seed, stop };
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runSim().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
