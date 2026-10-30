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
  sessionId: `demo-player-session-${String(index + 1).padStart(4, "0")}`,
}));

const AVATAR_COLORS = ["#51405f", "#7653a5", "#d56a3d", "#477b86", "#81613f", "#3f6881"];

export const CHAT_BASE_LINES = [
  "did anyone else hear that thunder just now",
  "my stream lights flickered twice a minute ago",
  "I finally remembered to eat before going live",
  "the rain against the window is actually relaxing",
  "this soundtrack makes every tiny task feel dramatic",
  "my cat claimed the warmest spot on the desk",
  "I should charge my phone before the power dips",
  "the cozy setup is doing a lot of work tonight",
  "someone remind me to close the kitchen window later",
  "I still cannot believe how the last round ended",
  "tea was absolutely the correct choice for this weather",
  "the room got very quiet all of a sudden",
  "I moved my drink away from the keyboard for once",
  "the lamp makes this room look much warmer on camera",
  "my headphones picked a strange time to feel uncomfortable",
  "I keep checking the window whenever the wind picks up",
  "the loading screen music is stuck in my head now",
  "I found the charger that was missing all afternoon",
  "my desk is somehow messier after I cleaned it",
  "the weather app really undersold this storm",
  "I can hear someone making snacks in the kitchen",
  "that transition was smoother than I expected",
  "I turned the volume down and immediately missed a sound",
  "the little clock on my desk is running fast again",
  "my chair only squeaks when the room gets quiet",
  "I forgot how early it gets dark this time of year",
  "the chat pace is perfect for a rainy night",
  "I nearly knocked over the stack beside my monitor",
  "the warm light makes the whole setup feel calmer",
  "my browser has far too many tabs open right now",
  "I heard the rain start before I saw it outside",
  "the next cup of tea is definitely happening soon",
  "my cat just looked directly at the camera again",
  "I finally found a comfortable volume for the music",
  "the window keeps rattling when the wind changes",
  "I need to tidy these cables after the stream",
];

const CHAT_FOLLOWUPS = [
  "Cozy timing",
  "Perfect weather for it",
  "Chat gets it",
];

export function createDemoChatPlan(random = Math.random) {
  const pool = CHAT_FOLLOWUPS.flatMap((followup) => (
    CHAT_BASE_LINES.map((line) => `${line}. ${followup}`)
  ));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  let cursor = 0;
  return {
    size: pool.length,
    next() {
      if (cursor >= pool.length) return null;
      const line = pool[cursor];
      cursor += 1;
      return line;
    },
  };
}

export function demoRoundSchedule(durationMs, random = Math.random) {
  const duration = Math.max(1, Number(durationMs) || 1);
  const smuggleAt = Math.round(duration * (.22 + random() * .56));
  return {
    decoyAt: Math.round(duration * (.18 + random() * .16)),
    smuggleAt,
    accuseAt: Math.round(Math.min(duration * .92, Math.max(
      duration * (.78 + random() * .1),
      smuggleAt + duration * .08,
    ))),
  };
}

const PLURAL_WORDS = new Set(["pants", "socks", "shoes", "boots", "shorts", "glasses", "scissors", "notes"]);

function articleFor(word) {
  if (word === "uniform") return "a";
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export function demoWordLines(entry) {
  const word = String(entry?.word ?? entry ?? "word").toLowerCase();
  const category = String(entry?.category ?? "");
  const noun = PLURAL_WORDS.has(word) ? word : `${articleFor(word)} ${word}`;
  const fantasyNoun = ["space", "treasure"].includes(word) ? word : noun;
  const templates = {
    feelings: [`I feel ${word} when the rain starts at night`, `the weather turned and I felt ${word} beside the window`],
    colors: [`that desk lamp looks ${word} when I dim it`, `the whole room looked ${word} when the weather turned`],
    actions: [`I always ${word} when thunder catches me off guard`, `the weather got dramatic enough to make me ${word}`],
    home: [`I noticed something about the ${word} earlier`, `I took another look at the ${word} before the stream`],
    food: [`I was thinking about ${word} while making dinner`, `we talked about adding ${word} to dinner`],
    animals: [`I saw ${noun} in a documentary last night`, `that ${word} clip from yesterday was adorable`],
    nature: [`I was just thinking about the ${word} earlier`, `we ended up talking about the ${word} before the stream`],
    travel: [`I was reading about ${noun} before the stream`, `the ${word} came up while we planned the trip`],
    technology: [`we were talking about the ${word} setup earlier`, `the ${word} gave me trouble before the stream`],
    entertainment: [`we were talking about the ${word} before the stream`, `the ${word} made last night much more fun`],
    sports: [`we were talking about ${word} before the stream`, `${word} came up during dinner last night`],
    work: [`we talked about ${word} at work today`, `the ${word} came up before my break`],
    people: [`I met ${noun} on the way home`, `the ${word} told a great story earlier`],
    clothing: [`I left my ${word} in the other room`, `my ${word} was still damp from the rain`],
    places: [`I stopped by the ${word} before the stream`, `the ${word} was surprisingly quiet today`],
    objects: [`I put the ${word} beside my desk`, `the ${word} was exactly where I left it`],
    fantasy: [`we talked about ${fantasyNoun} in the story`, `the story mentioned ${fantasyNoun} near the end`],
  }[category] || [`we talked about ${word} before the stream`, `the word ${word} came up earlier tonight`];
  return { decoy: templates[0], smuggle: templates[1] };
}

export function demoLobbyDuration(fast) {
  return fast ? 2_000 : 10_000;
}

export function demoIntermissionPlan(fast, sessionOver = false) {
  if (fast) return sessionOver
    ? { sessionOverMs: 50, nextSessionMs: 100, lobbyMs: 0 }
    : { sessionOverMs: 0, nextSessionMs: 0, lobbyMs: demoLobbyDuration(true) };
  return sessionOver
    ? { sessionOverMs: 2_000, nextSessionMs: 8_000, lobbyMs: 0 }
    : { sessionOverMs: 0, nextSessionMs: 0, lobbyMs: demoLobbyDuration(false) };
}

export function shouldStartDemoFinal(roundsPlayed, seating = []) {
  return Number(roundsPlayed) >= 3 && (seating || []).length > 1;
}

export function selectDemoVoteTarget(table, player, outcomes) {
  if (!table || !player) return null;
  const hidden = table.impostors.filter(({ busted }) => !busted);
  const impostorIds = new Set(table.impostors.map(({ playerId }) => playerId));
  const bustedIds = new Set(table.impostors.filter(({ busted }) => busted).map(({ playerId }) => playerId));
  const preferredImpostor = hidden.find(({ playerId }) => outcomes.get(playerId)?.catchByVote);
  const detectives = [...table.roster.values()].filter(({ id }) => (
    id !== player.id && !impostorIds.has(id) && !bustedIds.has(id)
  ));
  const hiddenTargets = hidden.map(({ playerId }) => table.roster.get(playerId)).filter((target) => target && target.id !== player.id);
  const preferred = preferredImpostor ? table.roster.get(preferredImpostor.playerId) : detectives[0];
  return preferred?.id === player.id ? hiddenTargets[0] ?? detectives[0] : preferred ?? hiddenTargets[0] ?? null;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export function requestedPlayerCount(argv = process.argv, configured = process.env.DEMO_PLAYERS) {
  const argument = argv.find((value) => value.startsWith("--players="));
  const separateIndex = argv.indexOf("--players");
  const configuredValue = String(configured ?? "").trim() || null;
  const value = argument?.split("=", 2)[1]
    ?? (separateIndex >= 0 ? argv[separateIndex + 1] : null)
    ?? configuredValue
    ?? 4;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? Math.max(3, Math.min(200, count)) : 4;
}

export function requestedSeed(argv = process.argv, configured = process.env.DEMO_SEED) {
  const argument = argv.find((value) => value.startsWith("--seed="));
  const separateIndex = argv.indexOf("--seed");
  const configuredValue = String(configured ?? "").trim() || null;
  return String(argument?.split("=", 2)[1]
    ?? (separateIndex >= 0 ? argv[separateIndex + 1] : null)
    ?? configuredValue
    ?? "sus-word-demo");
}

export function seededRandom(seed = "sus-word-demo") {
  let value = 2166136261;
  for (const character of String(seed)) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoPublicUrl(port = 3000, configured = "") {
  const publicUrl = String(configured || "").trim().replace(/\/+$/, "");
  return publicUrl || `http://localhost:${Number(port) || 3000}`;
}

export function demoTableCapacity(playerCount, publicUrl = "") {
  return publicUrl && Number(playerCount) >= 7 ? 6 : 12;
}

export function demoRoundOutcomes(game, random, missOffset = 0) {
  const outcomes = new Map();
  let index = 0;
  for (const table of game.tables.values()) {
    for (const assignment of table.impostors) {
      const missCycle = (game.roundNumber + table.id + index + missOffset) % 3;
      outcomes.set(assignment.playerId, {
        bust: missCycle !== 0,
        catchByVote: random() < .62,
      });
      index += 1;
    }
  }
  return outcomes;
}

export function demoWordPicker(random) {
  const used = new Set();
  return ({ words }) => {
    let choices = words.filter(({ word }) => !used.has(word));
    if (!choices.length) {
      used.clear();
      choices = words;
    }
    const picked = choices[Math.floor(random() * choices.length)];
    used.add(picked.word);
    return picked;
  };
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
      sessionId: `demo-player-session-${String(number).padStart(4, "0")}`,
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
  return player.sessionId
    || `demo-player-session-${String(player.id).replace(/^demo-/, "").padStart(4, "0")}`;
}

function linkDemoProfile(game, profile) {
  game.join(profile);
  const claim = game.createClaim({ sessionId: profile.sessionId, login: profile.login });
  return game.claim({ ...profile, code: claim.code, userId: profile.id });
}

export function resetDemoSession(game, profiles) {
  game.reset();
  for (const profile of profiles) linkDemoProfile(game, profile);
  game.start();
  return {
    players: game.players.size,
    profiles: game.profiles.size,
    sessions: game.sessions.size,
    claims: game.claims.size,
    timers: game.timers.size,
  };
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

async function populateLobby(game, profiles, fast, pauseScale = 1) {
  const pause = Math.max(0, (profiles.length > 12 ? (fast ? 10 : 25) : fast ? 350 : 700) * pauseScale);
  for (const profile of profiles) {
    await sleep(pause);
    game.join(profile);
    await sleep(pause);
    const claim = game.createClaim({ sessionId: profile.sessionId, login: profile.login });
    game.claim({ ...profile, code: claim.code, userId: profile.id });
  }
}

async function postMessage(game, service, player, text, sequence, voiceSocket, fast, logger = console) {
  if (fast && player.login === "streamer") {
    voiceSocket.send(JSON.stringify({ type: "voice", text }));
    logger.log?.(`[voice] ${player.login}: ${text}`);
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
  if (result.ok) logger.log?.(`[chat] ${player.login}: ${text}`);
  return result;
}

async function playRoundChat(game, service, profiles, fast, voiceSocket, outcomes, options = {}) {
  const pauseScale = Math.max(0, Number(options.pauseScale ?? 1));
  const interval = Math.max(1, (fast ? 3_500 : 6_000) * pauseScale);
  const schedule = options.schedule ?? demoRoundSchedule(game.durations.round, options.random);
  const linePlan = options.linePlan ?? createDemoChatPlan(options.random);
  const logger = options.logger ?? console;
  const assignments = [...game.tables.values()].flatMap((table) => (
    table.impostors.map((assignment) => ({ table, assignment }))
  ));
  let decoySent = false;
  let smuggleSent = false;
  let accusationsSent = false;
  let sequence = 0;

  for (const { table, assignment } of assignments) {
    const impostor = profiles.find(({ id }) => id === assignment.playerId);
    logger.log?.(`[demo] T${table.id}: @${impostor.login} has ${assignment.word.toUpperCase()}`);
  }
  while (game.phase === PHASES.ROUND) {
    await sleep(interval);
    if (game.phase !== PHASES.ROUND) break;
    const elapsed = Date.now() - game.currentRound.startedAt;
    sequence += 1;

    if (!decoySent && elapsed >= schedule.decoyAt) {
      for (const { table, assignment } of assignments) {
        const decoy = [...table.roster.values()].find(({ id }) => id !== assignment.playerId);
        sequence += 1;
        await postMessage(game, service, decoy, demoWordLines(assignment).decoy, sequence, voiceSocket, fast, logger);
      }
      decoySent = true;
      continue;
    }
    if (!smuggleSent && elapsed >= schedule.smuggleAt) {
      for (const { assignment } of assignments) {
        const impostor = profiles.find(({ id }) => id === assignment.playerId);
        sequence += 1;
        await postMessage(game, service, impostor, demoWordLines(assignment).smuggle, sequence, voiceSocket, fast, logger);
      }
      smuggleSent = true;
      continue;
    }

    if (!accusationsSent && elapsed >= schedule.accuseAt) {
      for (const table of game.tables.values()) {
        const [assignment] = table.impostors;
        const impostor = table.roster.get(assignment.playerId);
        const detectives = [...table.roster.values()].filter(({ id }) => (
          !table.impostors.some(({ playerId }) => playerId === id)
        ));
        const outcome = outcomes.get(assignment.playerId);
        if (detectives[0]) {
          const guessedWord = outcome.bust ? assignment.word : "banana";
          if (table.id === game.featuredTableId) {
            await service.handleChatMessage({
              userId: detectives[0].id,
              login: detectives[0].login,
              text: `!accuse ${impostor.login} ${guessedWord}`,
            });
          } else {
            service.handleCardAction(demoSessionId(detectives[0]), {
              type: "accuse", target: impostor.login, word: guessedWord,
            });
          }
          logger.log?.(`[accuse] @${detectives[0].login} ${outcome.bust ? "busted" : "missed"} @${impostor.login}`);
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
          logger.log?.(`[accuse] @${detectives[1].login} missed (${result.correct ? "right" : "wrong"})`);
        }
      }
      accusationsSent = true;
      continue;
    }

    const player = profiles[(sequence - 1) % profiles.length];
    const text = linePlan.next() ?? "chat is moving quickly tonight";
    await postMessage(game, service, player, text, sequence, voiceSocket, fast, logger);
  }
}

async function castVotes(game, service, fast, outcomes, pauseScale = 1, logger = console) {
  const seated = [...game.tables.values()].reduce((sum, table) => sum + table.roster.size, 0);
  const pause = Math.max(1, (seated > 12 ? (fast ? 35 : 75) : fast ? 2_500 : 4_000) * pauseScale);
  for (const table of game.tables.values()) {
    for (const player of table.roster.values()) {
      if (game.phase !== PHASES.VOTE) return;
      await sleep(pause);
      if (game.phase !== PHASES.VOTE) return;
      const target = selectDemoVoteTarget(table, player, outcomes);
      if (!target) continue;
      if (table.id === game.featuredTableId) {
        await service.handleChatMessage({
          userId: player.id,
          login: player.login,
          text: `!vote ${target.login}`,
        });
      } else {
        service.handleCardAction(demoSessionId(player), { type: "vote", target: target.login });
      }
      logger.log?.(`[vote] T${table.id}: @${player.login} voted for @${target.login}`);
    }
  }
}

export async function driveDemoRound(game, actions) {
  await actions.playChat();
  if (game.phase === PHASES.ROUND) await (actions.waitForPhase ?? waitForPhase)(game, PHASES.VOTE);
  if (game.phase === PHASES.VOTE) await actions.castVotes();
  if (game.phase !== PHASES.REVEAL) await (actions.waitForPhase ?? waitForPhase)(game, PHASES.REVEAL);
  return game.lastReveal;
}

export async function runDemo(options = {}) {
  const fast = options.fast ?? process.argv.includes("--fast");
  const playerCount = Number(options.players ?? requestedPlayerCount());
  const pauseScale = Math.max(0, Number(options.pauseScale ?? 1));
  const roundsPerSession = Math.max(1, Number(options.roundsPerSession ?? 3));
  const maxSessions = Number.isFinite(options.maxSessions) ? Math.max(1, Number(options.maxSessions)) : Infinity;
  const report = typeof options.onDemoEvent === "function" ? options.onDemoEvent : () => {};
  const logger = options.logger ?? console;
  const profiles = demoProfiles(playerCount);
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const publicUrlSetting = options.publicUrl ?? process.env.DEMO_PUBLIC_URL;
  const publicUrl = demoPublicUrl(port, publicUrlSetting);
  const seed = String(options.seed ?? requestedSeed());
  const gameRandom = seededRandom(`${seed}:game`);
  const behaviorRandom = seededRandom(`${seed}:behavior`);
  const missOffset = Math.floor(behaviorRandom() * 3);
  let claimIndex = 0;
  const baseDurations = fast
    ? { ...FAST_DURATIONS, lobby: demoLobbyDuration(true) }
    : { lobby: demoLobbyDuration(false) };
  const game = new Game({
    durations: { ...baseDurations, ...(options.durations || {}) },
    codeGenerator: () => claimCode(claimIndex++),
    random: gameRandom,
    wordPicker: demoWordPicker(gameRandom),
    // The demo owns the intermission so its FINAL decision cannot race the lobby timer.
    autoStartLobby: false,
    // Hosted showcases use two readable tables at ten players; normal rehearsals keep the 12-player rules cap.
    maxTableSize: options.maxTableSize ?? demoTableCapacity(playerCount, publicUrlSetting),
  });
  const service = createSusWordServer({
    game,
    port,
    env: { PORT: String(port), PUBLIC_URL: publicUrl, CHANNEL_LOGIN: "streamer", DEMO_MODE: "1" },
    logger,
  });
  let running = true;
  let stopped = false;
  let voiceSocket = null;

  async function stop() {
    if (stopped) return;
    stopped = true;
    running = false;
    game.reset();
    voiceSocket?.close();
    await service.stop();
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let completedSessions = 0;
  let sessionRounds = 0;
  let chatPlan = createDemoChatPlan(behaviorRandom);
  try {
    const address = await service.start();
    voiceSocket = await connectVoiceSocket(address.port);
    logger.log?.(`[demo] Watch a round: ${publicUrl}/watch`);
    logger.log?.(`[demo] ${fast ? "Fast rehearsal" : "Full timing"} mode.`);
    logger.log?.(`[demo] Simulating ${profiles.length} players with seed "${seed}".`);
    logger.log?.(`[demo] Follow player 1's card: ${publicUrl}/card?demo=1`);

    await populateLobby(game, profiles, fast, pauseScale);
    game.start();

    while (running) {
      const intermission = demoIntermissionPlan(fast, game.sessionOver);
      if (game.sessionOver) {
        completedSessions += 1;
        report({ type: "sessionOver", session: completedSessions, roundNumber: game.roundNumber });
        await sleep(intermission.sessionOverMs * pauseScale);
        if (!running) break;
        game.prepareNextSession(intermission.nextSessionMs * pauseScale);
        await sleep(intermission.nextSessionMs * pauseScale);
        if (!running) break;
        resetDemoSession(game, profiles);
        sessionRounds = 0;
        chatPlan = createDemoChatPlan(behaviorRandom);
        report({
          type: "sessionReset",
          session: completedSessions + 1,
          roundNumber: game.roundNumber,
          scores: [...game.scores.values()],
        });
        if (completedSessions >= maxSessions) break;
        continue;
      }

      if (game.phase === PHASES.LOBBY) {
        await sleep(intermission.lobbyMs * pauseScale);
        if (!running) break;
        if (sessionRounds >= roundsPerSession) {
          if (shouldStartDemoFinal(sessionRounds, game.lastRoundSeating)) game.final();
          else game.completeSession();
        } else game.go();
      }
      if (game.phase !== PHASES.ROUND) continue;

      const finalRound = game.isFinalRound;
      logger.log?.(`[demo] Starting ${finalRound ? "FINAL" : `round ${game.roundNumber}`}`);
      report({ type: "roundStart", final: finalRound, roundNumber: game.roundNumber, session: completedSessions + 1 });
      const outcomes = demoRoundOutcomes(game, behaviorRandom, missOffset);
      const schedule = demoRoundSchedule(game.durations.round, behaviorRandom);
      report({ type: "roundSchedule", final: finalRound, roundNumber: game.roundNumber, ...schedule });
      await driveDemoRound(game, {
        playChat: () => playRoundChat(game, service, profiles, fast, voiceSocket, outcomes, {
          linePlan: chatPlan,
          schedule,
          pauseScale,
          random: behaviorRandom,
          logger,
        }),
        castVotes: () => castVotes(game, service, fast, outcomes, pauseScale, logger),
      });
      logger.log?.(`[demo] ${game.lastReveal.botMessage}`);
      if (!finalRound) sessionRounds += 1;
      await waitForPhase(game, PHASES.LOBBY);
    }
    return { completedSessions, roundNumber: game.roundNumber, scores: [...game.scores.values()] };
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await stop();
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
