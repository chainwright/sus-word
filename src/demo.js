import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Game, { PHASES } from "./game.js";
import { createSusWordServer } from "./server.js";

const FAST_DURATIONS = Object.freeze({
  categoryHint: 30_000,
  letterHint: 50_000,
  round: 60_000,
  vote: 15_000,
});

const PROFILES = [
  ["pixel_mara", "Pixel Mara", "#51405f", "PM"],
  ["tomtom_irl", "TomTom", "#7653a5", "TT"],
  ["quietfox", "Quiet Fox", "#d56a3d", "QF"],
  ["streamer", "Streamer", "#477b86", "ST"],
].map(([login, displayName, color, initials], index) => ({
  id: `demo-${index + 1}`,
  login,
  displayName,
  avatar: avatarDataUri(color, initials),
  sessionId: `demo-session-${index + 1}`,
}));

const CHAT_LINES = [
  "did anyone else hear that thunder just now",
  "my stream lights always flicker when the weather turns",
  "I finally remembered to make dinner before going live",
  "the rain against the window is actually kind of relaxing",
  "this soundtrack makes every tiny task feel dramatic",
  "my cat has claimed the warmest spot on the desk",
  "I should probably charge my phone before the power dips",
  "the cozy setup is doing a lot of work tonight",
  "someone remind me to close the kitchen window later",
  "I cannot believe that last round ended like that",
  "tea was absolutely the correct choice for this weather",
  "the room got very quiet all of a sudden",
];

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export function avatarDataUri(color, initials) {
  const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : "#665374";
  const safeInitials = String(initials).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">',
    `<rect width="160" height="160" rx="18" fill="${safeColor}"/>`,
    '<circle cx="80" cy="61" r="31" fill="#f0c9a8"/>',
    '<path d="M30 150c5-38 25-56 50-56s45 18 50 56" fill="#282133"/>',
    `<text x="80" y="142" fill="#fff7e7" font-family="Arial,sans-serif" font-size="25" font-weight="700" text-anchor="middle">${safeInitials}</text>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function waitForPhase(game, phase) {
  if (game.phase === phase) return Promise.resolve();
  return new Promise((resolvePhase) => {
    function onState({ to }) {
      if (to !== phase) return;
      game.off("state", onState);
      resolvePhase();
    }
    game.on("state", onState);
  });
}

async function populateLobby(game, fast) {
  const pause = fast ? 350 : 700;
  for (const profile of PROFILES) {
    await sleep(pause);
    game.join(profile);
    await sleep(pause);
    const claim = game.createClaim({ sessionId: profile.sessionId, login: profile.login });
    game.claim({ ...profile, code: claim.code, userId: profile.id });
  }
}

function postMessage(game, player, text, sequence) {
  const result = game.recordMessage({
    userId: player.id,
    messageId: `demo-${game.roundNumber}-${sequence}`,
    text,
  });
  if (result.ok) console.log(`[chat] ${player.login}: ${text}`);
  return result;
}

async function playRoundChat(game, fast) {
  const interval = fast ? 3_500 : 6_000;
  const decoyAt = game.durations.round * .3;
  const smuggleAt = game.durations.round * .55;
  const impostor = PROFILES.find(({ id }) => id === game.currentRound.impostorId);
  const decoyPlayer = PROFILES.find(({ id }) => id !== impostor.id);
  const word = game.currentRound.word;
  let decoySent = false;
  let smuggleSent = false;
  let sequence = 0;

  console.log(`[demo] @${impostor.login} has the word ${word.toUpperCase()}`);
  while (game.phase === PHASES.ROUND) {
    await sleep(interval);
    if (game.phase !== PHASES.ROUND) break;
    const elapsed = Date.now() - game.currentRound.startedAt;
    sequence += 1;

    if (!decoySent && elapsed >= decoyAt) {
      postMessage(
        game,
        decoyPlayer,
        `I keep a ${word} near my desk for stormy nights`,
        sequence,
      );
      decoySent = true;
      continue;
    }
    if (!smuggleSent && elapsed >= smuggleAt) {
      postMessage(
        game,
        impostor,
        `the power blinked again so I lit a ${word} beside my monitor`,
        sequence,
      );
      smuggleSent = true;
      continue;
    }

    const player = PROFILES[(sequence - 1) % PROFILES.length];
    const text = CHAT_LINES[(sequence - 1) % CHAT_LINES.length];
    postMessage(game, player, text, sequence);
  }
}

async function castVotes(game, fast) {
  const pause = fast ? 2_500 : 4_000;
  const impostorId = game.currentRound.impostorId;
  const fallback = PROFILES.find(({ id }) => id !== impostorId);
  for (const player of PROFILES) {
    if (game.phase !== PHASES.VOTE) break;
    await sleep(pause);
    if (game.phase !== PHASES.VOTE) break;
    const targetId = player.id === impostorId ? fallback.id : impostorId;
    const target = PROFILES.find(({ id }) => id === targetId);
    game.vote(player.id, targetId);
    console.log(`[vote] @${player.login} voted for @${target.login}`);
  }
}

export async function runDemo(options = {}) {
  const fast = options.fast ?? process.argv.includes("--fast");
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
  const game = new Game({ durations: fast ? FAST_DURATIONS : undefined });
  const service = createSusWordServer({
    game,
    port,
    env: { PORT: String(port), PUBLIC_URL: publicUrl },
  });
  let running = true;

  async function stop() {
    if (!running) return;
    running = false;
    game.reset();
    await service.stop();
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await service.start();
  console.log(`[demo] Open http://localhost:${port}/overlay in a 1920×1080 browser source.`);
  console.log(`[demo] ${fast ? "Fast rehearsal" : "Full timing"} mode. Press Ctrl+C to stop.`);

  game.start();
  await populateLobby(game, fast);
  let round = 0;

  while (running) {
    await sleep(fast ? 2_000 : 4_000);
    if (!running) break;
    round += 1;
    console.log(`[demo] Starting round ${round}`);
    game.go({ word: "candle", category: "home" });
    await playRoundChat(game, fast);
    await waitForPhase(game, PHASES.VOTE);
    await castVotes(game, fast);
    await waitForPhase(game, PHASES.REVEAL);
    console.log(`[demo] ${game.lastReveal.botMessage}`);
    await waitForPhase(game, PHASES.LOBBY);
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runDemo().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
