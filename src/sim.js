import "dotenv/config";

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { avatarDataUri, CHAT_BASE_LINES } from "./demo.js";
import Game, { PHASES } from "./game.js";
import { createSusWordServer } from "./server.js";
import TwitchClient from "./twitch.js";
import { findWord } from "./words.js";

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

const SIM_CHAT_LINES = [
  ...CHAT_BASE_LINES,
  "I put the kettle on and forgot about it again",
  "the hallway light just turned itself off",
  "my desk drawer has started sticking again",
  "I should probably move that stack before it falls",
  "the neighbor upstairs picked a dramatic time to vacuum",
  "my screen looks much brighter after sunset",
  "I can hear the wind moving the trees outside",
  "the blanket on this chair was a good decision",
  "I lost track of which mug is still warm",
  "the room always sounds different when it rains",
  "I just noticed how crooked that picture is",
  "my keyboard is louder than I remember",
  "I should have opened the window earlier",
  "someone nearby is cooking something amazing",
  "the clock in the kitchen is definitely five minutes fast",
  "I finally cleared enough space for my notebook",
  "the quiet between songs feels oddly suspicious",
  "my sleeves keep catching on the edge of the desk",
  "I can never find a pen when I actually need one",
  "the clouds rolled in incredibly fast tonight",
  "I heard the mail slot and nearly jumped",
  "this chair has one very specific comfortable position",
  "the light from the monitor is doing all the work now",
  "I need a better place to keep all these cables",
  "the floorboard by the door creaks every single time",
  "my tea survived longer than usual before going cold",
  "I keep mistaking the reflection for movement",
  "the music got quiet at exactly the wrong moment",
  "I forgot there was still laundry in the other room",
  "the last bit of daylight disappeared so quickly",
  "I found a snack I forgot I bought",
  "my notes make much less sense than they did earlier",
  "the rain finally slowed down outside",
  "I moved one thing and somehow lost three others",
  "the lamp shade is slightly crooked and now I cannot ignore it",
  "my phone just reminded me about something from yesterday",
  "the room feels warmer with the door closed",
  "I can hear a train somewhere in the distance",
  "the desk looks organized if I do not look too closely",
  "I picked the squeakiest possible spot on the floor",
  "the clouds are making it feel much later than it is",
  "I finally remembered where I left my headphones",
  "someone outside has been trying to start a car for ages",
  "the tiny plant by the monitor is somehow still thriving",
  "I should write this down before I forget it again",
  "the room went completely quiet for one second",
  "my water glass is just out of reach",
  "the window reflection makes the room look twice as big",
];

const REACTION_LINES = [
  "ha, same",
  "wait what",
  "honestly same",
  "that tracks",
  "fair enough",
  "I felt that",
  "no way",
  "okay that got me",
  "you are not wrong",
  "well now I am curious",
  "that sounds about right",
  "I was thinking that too",
  "oh no",
  "good point",
  "that is so real",
  "now I need to know",
  "I can see that",
  "wild timing",
];

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

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function mentionsWord(candidate, word) {
  const tokens = candidate.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  return tokens.includes(String(word).toLowerCase()) || findWord(candidate, word).hit;
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

export function createSimLinePlan(random = Math.random) {
  const normal = shuffled(SIM_CHAT_LINES, random);
  const topics = new Map(Object.entries(TOPIC_LINES).map(([category, lines]) => [category, shuffled(lines, random)]));
  const reactions = shuffled(REACTION_LINES, random);
  const used = new Set();

  function take(pool, rejected = () => false) {
    while (pool.length) {
      const line = pool.shift();
      if (used.has(line) || rejected(line)) continue;
      used.add(line);
      return line;
    }
    return null;
  }

  return {
    next(category, secretWords = []) {
      const key = String(category || "default").toLowerCase();
      const topicPool = topics.get(key) ?? topics.get("default");
      const rejected = (candidate) => secretWords.some((word) => mentionsWord(candidate, word));
      if (random() < .16) {
        const flavoured = take(topicPool, rejected);
        if (flavoured) return { text: flavoured, kind: "topic" };
      }
      const line = take(normal, rejected) ?? take(topicPool, rejected);
      return line ? { text: line, kind: "normal" } : null;
    },
    nextReaction(secretWords = []) {
      const words = secretWords.filter(Boolean);
      const line = take(reactions, (candidate) => words.some((word) => mentionsWord(candidate, word)));
      return line ? { text: line, kind: "reaction" } : null;
    },
  };
}

function smuggleWindow(roundDuration) {
  if (roundDuration >= 140_000) return { earliest: 40_000, latest: 140_000 };
  return {
    earliest: Math.round(roundDuration * (40 / 180)),
    latest: Math.round(roundDuration * (140 / 180)),
  };
}

export function createRoundPlan({ table, sims, roundDuration, voteDuration, voteGrace, random, linePlan = createSimLinePlan(random) }) {
  const simulated = sims.filter(({ id }) => table.roster.has(id));
  const assignments = table.impostors.filter(({ playerId }) => simulated.some(({ id }) => id === playerId));
  const category = table.impostors[0]?.category;
  const messages = [];
  const paceScale = Math.min(1, roundDuration / 180_000);
  for (const player of simulated) {
    const ownWord = assignments.find(({ playerId }) => playerId === player.id)?.word;
    let cursor = (6_000 + random() * 14_000) * paceScale;
    while (cursor < roundDuration - Math.max(1_000, 4_000 * paceScale)) {
      const line = linePlan.next(category, ownWord ? [ownWord] : []);
      if (!line) break;
      messages.push({
        atMs: Math.round(cursor),
        playerId: player.id,
        text: line.text,
        kind: line.kind,
        smuggle: false,
      });
      cursor += (20_000 + random() * 20_000) * paceScale;
    }
  }

  const window = smuggleWindow(roundDuration);
  for (const assignment of assignments) {
    const atMs = Math.round(window.earliest + random() * (window.latest - window.earliest));
    messages.push({
      atMs,
      playerId: assignment.playerId,
      text: pick(SMUGGLE_LINES, random)(assignment.word),
      kind: "smuggle",
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

function planCurrentRound(game, sims, random, linePlan) {
  return [...game.tables.values()].map((table) => ({
    table,
    plan: createRoundPlan({
      table,
      sims,
      roundDuration: game.durations.round,
      voteDuration: game.durations.vote,
      voteGrace: game.durations.voteGrace,
      random,
      linePlan,
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
  const linePlan = options.linePlan ?? createSimLinePlan(random);
  const sims = simProfiles(playerCount);
  const game = options.game ?? new Game({
    random,
    durations: fast ? FAST_DURATIONS : REHEARSAL_DURATIONS,
    autoStartLobby: false,
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
  let reactionSequence = 0;
  let reactionRound = 0;
  const reactionCountByTable = new Map();
  const reactionSims = new Set();
  const reactionTimers = new Set();
  const onState = ({ to }) => {
    if (to === PHASES.ROUND) {
      reactionRound = game.roundNumber;
      reactionCountByTable.clear();
      reactionSims.clear();
      activePlans = planCurrentRound(game, sims, random, linePlan);
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
  const onMessage = ({ tableId, message }) => {
    if (game.phase !== PHASES.ROUND || sims.some(({ id }) => id === message?.userId)) return;
    if (reactionRound !== game.roundNumber || (reactionCountByTable.get(tableId) ?? 0) >= 2 || random() >= .16) return;
    const candidates = sims.filter(({ id }) => game.playerTables.get(id) === tableId && !reactionSims.has(id));
    if (!candidates.length) return;
    const player = pick(candidates, random);
    const table = game.tables.get(tableId);
    const reaction = linePlan.nextReaction(table?.impostors.map(({ word }) => word) ?? []);
    if (!reaction) return;
    reactionCountByTable.set(tableId, (reactionCountByTable.get(tableId) ?? 0) + 1);
    reactionSims.add(player.id);
    const scheduledRound = game.roundNumber;
    const delay = fast ? 350 + random() * 650 : 1_500 + random() * 2_500;
    const timer = setTimeout(() => {
      reactionTimers.delete(timer);
      if (game.phase !== PHASES.ROUND || game.roundNumber !== scheduledRound || game.playerTables.get(player.id) !== tableId) return;
      const result = recordSimMessage(game, player, reaction.text, `reaction-${reactionSequence++}`);
      if (result.ok) log(`[sim] #${game.players.get(player.id)?.number} ${player.displayName}: ${reaction.text}`);
    }, delay);
    reactionTimers.add(timer);
  };
  game.on("state", onState);
  game.on("message", onMessage);

  async function stop() {
    if (stopping) return;
    stopping = true;
    game.off("state", onState);
    game.off("message", onMessage);
    for (const timer of reactionTimers) clearTimeout(timer);
    reactionTimers.clear();
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
