import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import WebSocket from "ws";

import Game, { PHASES } from "./game.js";
import { createSusWordServer } from "./server.js";

const FAST_DURATIONS = Object.freeze({
  categoryHint: 30_000,
  letterHint: 50_000,
  round: 60_000,
  vote: 15_000,
});

const CORE_PROFILES = [
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

const AVATAR_COLORS = ["#51405f", "#7653a5", "#d56a3d", "#477b86", "#81613f", "#3f6881"];

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

function requestedPlayerCount(argv = process.argv) {
  const argument = argv.find((value) => value.startsWith("--players="));
  const separateIndex = argv.indexOf("--players");
  const value = argument?.split("=", 2)[1]
    ?? (separateIndex >= 0 ? argv[separateIndex + 1] : null)
    ?? 4;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? Math.max(3, Math.min(200, count)) : 4;
}

export function demoProfiles(count = 4) {
  const profiles = CORE_PROFILES.slice(0, Math.min(count, CORE_PROFILES.length));
  for (let index = profiles.length; index < count; index += 1) {
    const number = index + 1;
    profiles.push({
      id: `demo-${number}`,
      login: `viewer_${String(number).padStart(3, "0")}`,
      displayName: `Viewer ${number}`,
      avatar: avatarDataUri(AVATAR_COLORS[index % AVATAR_COLORS.length], `V${number}`),
      sessionId: `demo-session-${number}`,
    });
  }
  return profiles;
}

function claimCode(index) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = index;
  return Array.from({ length: 4 }, () => {
    const character = alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length);
    return character;
  }).reverse().join("");
}

function demoSessionId(player) {
  return player.sessionId || `demo-session-${String(player.id).replace(/^demo-/, "")}`;
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

function connectVoiceSocket(port) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?view=host`,
      { origin: `http://localhost:${port}` },
    );
    socket.once("open", () => resolveSocket(socket));
    socket.once("error", rejectSocket);
  });
}

async function populateLobby(game, profiles, fast) {
  const pause = profiles.length > 12 ? (fast ? 10 : 25) : fast ? 350 : 700;
  for (const profile of profiles) {
    await sleep(pause);
    game.join(profile);
    await sleep(pause);
    const claim = game.createClaim({ sessionId: profile.sessionId, login: profile.login });
    game.claim({ ...profile, code: claim.code, userId: profile.id });
  }
}

async function postMessage(game, service, player, text, sequence, voiceSocket, fast) {
  if (fast && player.login === "streamer") {
    voiceSocket.send(JSON.stringify({ type: "voice", text }));
    console.log(`[voice] ${player.login}: ${text}`);
    return null;
  }
  const tableId = game.playerTables.get(player.id);
  const result = tableId !== game.featuredTableId
    ? service.handleCardAction(demoSessionId(player), { type: "tableChat", text })
    : await service.handleChatMessage({
      userId: player.id,
      login: player.login,
      displayName: player.displayName,
      id: `demo-${game.roundNumber}-${sequence}`,
      text,
    });
  if (result.ok) console.log(`[chat] ${player.login}: ${text}`);
  return result;
}

async function playRoundChat(game, service, profiles, fast, voiceSocket) {
  const interval = fast ? 3_500 : 6_000;
  const decoyAt = game.durations.round * .3;
  const smuggleAt = game.durations.round * .55;
  const assignments = [...game.tables.values()].flatMap((table) => (
    table.impostors.map((assignment) => ({ table, assignment }))
  ));
  let decoySent = false;
  let smuggleSent = false;
  let accusationsSent = false;
  let sequence = 0;

  for (const { table, assignment } of assignments) {
    const impostor = profiles.find(({ id }) => id === assignment.playerId);
    console.log(`[demo] T${table.id}: @${impostor.login} has ${assignment.word.toUpperCase()}`);
  }
  while (game.phase === PHASES.ROUND) {
    await sleep(interval);
    if (game.phase !== PHASES.ROUND) break;
    const elapsed = Date.now() - game.currentRound.startedAt;
    sequence += 1;

    if (!decoySent && elapsed >= decoyAt) {
      for (const { table, assignment } of assignments) {
        const decoy = [...table.roster.values()].find(({ id }) => id !== assignment.playerId);
        sequence += 1;
        await postMessage(game, service, decoy, `I keep a ${assignment.word} near my desk for stormy nights`, sequence, voiceSocket, fast);
      }
      decoySent = true;
      continue;
    }
    if (!smuggleSent && elapsed >= smuggleAt) {
      for (const { assignment } of assignments) {
        const impostor = profiles.find(({ id }) => id === assignment.playerId);
        sequence += 1;
        await postMessage(game, service, impostor, `the weather turned so I moved my ${assignment.word} beside the monitor`, sequence, voiceSocket, fast);
      }
      smuggleSent = true;
      continue;
    }

    if (!accusationsSent && elapsed >= game.durations.round * .7) {
      for (const table of game.tables.values()) {
        const [assignment] = table.impostors;
        const impostor = table.roster.get(assignment.playerId);
        const detectives = [...table.roster.values()].filter(({ id }) => (
          !table.impostors.some(({ playerId }) => playerId === id)
        ));
        if (detectives[0]) {
          if (table.id === game.featuredTableId) {
            await service.handleChatMessage({
              userId: detectives[0].id,
              login: detectives[0].login,
              text: `!accuse ${impostor.login} ${assignment.word}`,
            });
          } else {
            service.handleCardAction(demoSessionId(detectives[0]), {
              type: "accuse", target: impostor.login, word: assignment.word,
            });
          }
          console.log(`[accuse] @${detectives[0].login} busted @${impostor.login}`);
        }
        if (detectives[1]) {
          const result = table.id === game.featuredTableId
            ? await service.handleChatMessage({
              userId: detectives[1].id,
              login: detectives[1].login,
              text: `!accuse ${impostor.login} banana`,
            })
            : service.handleCardAction(demoSessionId(detectives[1]), {
              type: "accuse", target: impostor.login, word: "banana",
            });
          console.log(`[accuse] @${detectives[1].login} missed (${result.correct ? "right" : "wrong"})`);
        }
      }
      accusationsSent = true;
      continue;
    }

    const player = profiles[(sequence - 1) % profiles.length];
    const text = CHAT_LINES[(sequence - 1) % CHAT_LINES.length];
    await postMessage(game, service, player, text, sequence, voiceSocket, fast);
  }
}

async function castVotes(game, service, fast) {
  const seated = [...game.tables.values()].reduce((sum, table) => sum + table.roster.size, 0);
  const pause = seated > 12 ? (fast ? 35 : 75) : fast ? 2_500 : 4_000;
  for (const table of game.tables.values()) {
    const impostorId = table.impostorId;
    const fallback = [...table.roster.values()].find(({ id }) => id !== impostorId);
    for (const player of table.roster.values()) {
      if (game.phase !== PHASES.VOTE) return;
      await sleep(pause);
      if (game.phase !== PHASES.VOTE) return;
      const target = table.roster.get(player.id === impostorId ? fallback.id : impostorId);
      if (table.id === game.featuredTableId) {
        await service.handleChatMessage({
          userId: player.id,
          login: player.login,
          text: `!vote ${target.login}`,
        });
      } else {
        service.handleCardAction(demoSessionId(player), { type: "vote", target: target.login });
      }
      console.log(`[vote] T${table.id}: @${player.login} voted for @${target.login}`);
    }
  }
}

export async function runDemo(options = {}) {
  const fast = options.fast ?? process.argv.includes("--fast");
  const playerCount = Number(options.players ?? requestedPlayerCount());
  const profiles = demoProfiles(playerCount);
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
  const roleRolls = [0, .999, .35, .999];
  let roleRoll = 0;
  let claimIndex = 0;
  const game = new Game({
    durations: fast ? FAST_DURATIONS : undefined,
    codeGenerator: () => claimCode(claimIndex++),
    random: fast ? () => roleRolls[roleRoll++ % roleRolls.length] : Math.random,
  });
  const service = createSusWordServer({
    game,
    port,
    env: { PORT: String(port), PUBLIC_URL: publicUrl, CHANNEL_LOGIN: "streamer" },
  });
  let running = true;
  let voiceSocket = null;

  async function stop() {
    if (!running) return;
    running = false;
    game.reset();
    voiceSocket?.close();
    await service.stop();
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const address = await service.start();
  voiceSocket = await connectVoiceSocket(address.port);
  console.log(`[demo] Open http://localhost:${address.port}/overlay in a 1920×1080 browser source.`);
  console.log(`[demo] ${fast ? "Fast rehearsal" : "Full timing"} mode. Press Ctrl+C to stop.`);
  console.log(`[demo] Simulating ${profiles.length} players.`);

  game.start();
  await populateLobby(game, profiles, fast);
  let round = 0;

  while (running) {
    await sleep(fast ? 2_000 : 4_000);
    if (!running) break;
    round += 1;
    console.log(`[demo] Starting round ${round}`);
    game.go({ word: "candle", category: "home" });
    await playRoundChat(game, service, profiles, fast, voiceSocket);
    await waitForPhase(game, PHASES.VOTE);
    await castVotes(game, service, fast);
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
