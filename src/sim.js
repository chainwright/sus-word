import "dotenv/config";

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { avatarDataUri } from "./demo.js";
import Game, { PHASES } from "./game.js";
import { createSusWordServer } from "./server.js";
import TwitchClient from "./twitch.js";

// Mixed rehearsal: the real Twitch channel and bot, plus simulated players who
// exist only inside the game. Their lines show on the overlay, never in Twitch
// chat, and their names start with "Sim" so viewers can tell them apart.

// The lobby waits for the host's !sus go instead of starting on its own.
const QUICK_DURATIONS = Object.freeze({
  lobby: 30 * 60_000,
  categoryHint: 35_000,
  letterHint: 55_000,
  round: 75_000,
  vote: 20_000,
});

const SIM_NAMES = ["Mara", "TomTom", "Fox", "Juno", "Ollie", "Bea", "Kit", "Remy", "Sol"];
const SIM_COLORS = ["#51405f", "#7653a5", "#d56a3d", "#477b86", "#81613f", "#3f6881"];

const SIM_LINES = [
  "ok who is being suspiciously quiet",
  "I swear the timer moves faster every round",
  "my tea went cold while I was reading chat",
  "that last message felt a little too casual",
  "I'm just here to watch, definitely not hiding anything",
  "the rain finally stopped over here",
  "this music is way too dramatic for a word game",
  "someone is typing very carefully tonight",
];

const SMUGGLE_LINES = [
  (word) => `the weather turned so I moved my ${word} beside the monitor`,
  (word) => `funny, I was just thinking about a ${word} before the stream`,
  (word) => `my neighbor keeps leaving a ${word} by the door, no idea why`,
];

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function pick(items, random = Math.random) {
  return items[Math.floor(random() * items.length)];
}

function argValue(name, argv = process.argv) {
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.split("=", 2)[1];
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}

export function simProfiles(count = 3) {
  return Array.from({ length: count }, (_, index) => {
    const name = SIM_NAMES[index % SIM_NAMES.length];
    const suffix = index >= SIM_NAMES.length ? String(index + 1) : "";
    return {
      id: `sim-${index + 1}`,
      login: `sim_${name.toLowerCase()}${suffix}`,
      displayName: `Sim ${name}${suffix}`,
      avatar: avatarDataUri(SIM_COLORS[index % SIM_COLORS.length], `S${index + 1}`),
      sessionId: `sim-session-${index + 1}`,
    };
  });
}

function featuredTable(game) {
  return game.tables.get(game.featuredTableId);
}

function simsAtTable(table, sims) {
  return sims.filter(({ id }) => table?.roster.has(id));
}

async function say(service, game, player, text) {
  return service.handleChatMessage({
    userId: player.id,
    login: player.login,
    displayName: player.displayName,
    id: `sim-${game.roundNumber}-${Date.now()}-${player.id}`,
    text,
  });
}

async function playRound(game, service, sims, log) {
  const table = featuredTable(game);
  const seated = simsAtTable(table, sims);
  const simImpostors = table.impostors
    .map((assignment) => ({ assignment, player: seated.find(({ id }) => id === assignment.playerId) }))
    .filter(({ player }) => player);
  const smuggleAt = game.durations.round * (.4 + Math.random() * .2);
  const smuggled = new Set();
  let line = 0;

  for (const { assignment, player } of simImpostors) {
    log(`[sim] @${player.login} is the Imposter with ${assignment.word.toUpperCase()}`);
  }
  while (game.phase === PHASES.ROUND) {
    await sleep(5_000 + Math.random() * 4_000);
    if (game.phase !== PHASES.ROUND) break;
    const elapsed = Date.now() - game.currentRound.startedAt;
    const due = simImpostors.find(({ player }) => !smuggled.has(player.id) && elapsed >= smuggleAt);
    if (due) {
      smuggled.add(due.player.id);
      await say(service, game, due.player, pick(SMUGGLE_LINES)(due.assignment.word));
      log(`[sim] @${due.player.login} smuggled the word`);
      continue;
    }
    const speaker = pick(seated);
    if (!speaker) continue;
    await say(service, game, speaker, SIM_LINES[line++ % SIM_LINES.length]);
  }
}

async function castVotes(game, service, sims, log) {
  const table = featuredTable(game);
  const seated = simsAtTable(table, sims);
  const impostorIds = new Set(table.impostors.map(({ playerId }) => playerId));
  for (const player of seated) {
    await sleep(2_000 + Math.random() * 4_000);
    if (game.phase !== PHASES.VOTE) return;
    const others = [...table.roster.values()].filter(({ id }) => id !== player.id);
    const suspects = others.filter(({ id }) => impostorIds.has(id));
    const target = suspects.length && Math.random() < .6 ? pick(suspects) : pick(others);
    await say(service, game, player, `!vote ${target.login}`);
    log(`[sim] @${player.login} voted for @${target.login}`);
  }
}

export async function runSim(options = {}) {
  const count = Math.max(1, Math.min(11, Number(options.sims ?? argValue("sim") ?? 3)));
  const quick = options.quick ?? process.argv.includes("--quick");
  const log = options.log ?? ((message) => console.log(message));
  const sims = simProfiles(count);
  const game = new Game({ durations: quick ? QUICK_DURATIONS : undefined });
  const twitch = new TwitchClient();
  const service = createSusWordServer({ game, twitch });

  await service.start();
  game.start();
  for (const profile of sims) {
    game.join(profile);
    const claim = game.createClaim({ sessionId: profile.sessionId, login: profile.login });
    game.claim({ ...profile, code: claim.code, userId: profile.id });
  }
  log(`[sim] ${count} simulated players seated. Lines you type here go to Twitch chat as ${twitch.bot?.login ?? "the bot"}.`);

  game.on("state", ({ to }) => {
    if (to === PHASES.ROUND) playRound(game, service, sims, log).catch((error) => log(`[sim] ${error.message}`));
    if (to === PHASES.VOTE) castVotes(game, service, sims, log).catch((error) => log(`[sim] ${error.message}`));
    if (to === PHASES.REVEAL && game.lastReveal) log(`[sim] ${game.lastReveal.botMessage}`);
  });

  const input = createInterface({ input: process.stdin });
  input.on("line", (text) => {
    if (!text.trim()) return;
    twitch.sendChat(text).catch((error) => log(`[chat] ${error.message}`));
  });

  async function stop() {
    input.close();
    game.reset();
    await service.stop();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { game, service, twitch, sims, stop };
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runSim().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
