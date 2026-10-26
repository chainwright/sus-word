const stage = document.querySelector("#stage");
const idleTag = document.querySelector("#idle-tag");
const board = document.querySelector("#case-board");
const lobbyView = document.querySelector("#lobby-view");
const roundView = document.querySelector("#round-view");
const voteView = document.querySelector("#vote-view");
const revealView = document.querySelector("#reveal-view");
const evidenceTray = document.querySelector("#evidence-tray");
const connectionBadge = document.querySelector("#connection-badge");
const circumference = 2 * Math.PI * 101;

let currentState = null;
let receivedAt = Date.now();
let reconnectDelay = 1_000;
let previousCounts = {};
let previousTallies = {};
let previousMessages = [];
let revealKey = null;
let revealTimers = [];
let lastTickSecond = null;
let audioContext = null;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function fitStage() {
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `scale(${scale})`;
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function initials(player) {
  const name = player?.displayName || player?.login || "?";
  return name.slice(0, 2).toUpperCase();
}

function avatarPhoto(player) {
  const photo = node("div", "polaroid-photo");
  if (player?.avatar) {
    const image = node("img");
    image.src = player.avatar;
    image.alt = "";
    image.addEventListener("error", () => image.replaceWith(document.createTextNode(initials(player))));
    photo.append(image);
  } else {
    photo.textContent = initials(player);
  }
  return photo;
}

function polaroid(player, options = {}) {
  const card = node("article", `polaroid ${options.className || ""}`.trim());
  card.dataset.playerId = player.id;
  card.style.setProperty("--tilt", `${options.tilt ?? 0}deg`);
  card.append(avatarPhoto(player));
  card.append(node("div", "polaroid-name", options.atName ? `@${player.login}` : player.displayName || player.login));
  if (options.locked) card.append(node("span", "polaroid-lock", "🔒"));
  return card;
}

function paperMessage(message, className = "message-slip") {
  const slip = node("article", className);
  const author = node("strong", "", `${message.player?.displayName || message.player?.login || "unknown"}: `);
  const text = node("span", "", message.text || "");
  slip.append(author, text);
  return slip;
}

function setViews(phase) {
  const idle = phase === "IDLE";
  idleTag.hidden = !idle;
  board.hidden = idle || phase === "REVEAL";
  lobbyView.hidden = phase !== "LOBBY";
  roundView.hidden = phase !== "ROUND";
  voteView.hidden = phase !== "VOTE";
  evidenceTray.hidden = phase !== "ROUND";
  revealView.hidden = phase !== "REVEAL";
}

function renderLobby(state) {
  document.querySelector("#phase-title").textContent = "SUS WORD · LOBBY";
  document.querySelector("#round-label").textContent = state.roundNumber ? `AFTER ROUND ${state.roundNumber}` : "OPEN CASE";
  const roster = document.querySelector("#lobby-roster");
  roster.replaceChildren(...state.players.slice(0, 9).map((player, index) => (
    polaroid(player, { locked: player.claimed, tilt: [-2, 1, -1, 2][index % 4] })
  )));
  document.querySelector("#join-line").textContent = `Type !join · get your card at ${state.cardUrl || `${location.origin}/card`}`;
  document.querySelector("#claim-count").textContent = `Need 3 card holders · ${state.claimedCount}/3`;
}

function revealHint(selector, label, value) {
  const card = document.querySelector(selector);
  const strong = card.querySelector("strong");
  const prior = strong.dataset.value || "";
  const next = value || "?";
  card.querySelector("span").textContent = label;
  strong.textContent = next;
  strong.dataset.value = next;
  strong.classList.toggle("long", next.length > 7);
  if (value && prior !== next) {
    card.animate(
      [{ transform: "rotateX(0deg)" }, { transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }],
      { duration: 700, easing: "cubic-bezier(.3,.1,.2,1)" },
    );
  }
}

function renderRound(state) {
  document.querySelector("#phase-title").textContent = "SUS WORD";
  document.querySelector("#round-label").textContent = `ROUND ${state.roundNumber}`;
  revealHint("#category-hint", "CATEGORY", state.round?.hints?.category);
  revealHint("#letter-hint", "STARTS WITH", state.round?.hints?.letter);

  const players = document.querySelector("#round-players");
  const cards = state.players.slice(0, 8).map((player, index) => {
    const card = polaroid(player, { className: "round-player", tilt: [-2, 1, -1, 2][index % 4] });
    const count = state.round?.messageCounts?.[player.id] || 0;
    card.append(node("span", "round-player-count", String(count)));
    if (count > (previousCounts[player.id] || 0)) {
      card.animate(
        [
          { transform: `rotate(${[-2, 1, -1, 2][index % 4]}deg) scale(1)` },
          { transform: "rotate(-4deg) scale(1.11)" },
          { transform: "rotate(3deg) scale(1.05)" },
          { transform: `rotate(${[-2, 1, -1, 2][index % 4]}deg) scale(1)` },
        ],
        { duration: 520, easing: "ease-out" },
      );
    }
    return card;
  });
  players.replaceChildren(...cards);
  previousCounts = { ...(state.round?.messageCounts || {}) };

  const messages = state.round?.latestMessages || [];
  const priorIds = new Set(previousMessages.map(({ id }) => id));
  const slips = messages.map((message, index) => {
    const slip = paperMessage(message);
    slip.style.setProperty("--tilt", `${[-1.4, .8, -.4][index]}deg`);
    if (!priorIds.has(message.id)) {
      slip.animate(
        [{ transform: "translateY(160px) rotate(3deg)", opacity: 0 }, { transform: `translateY(0) rotate(${[-1.4, .8, -.4][index]}deg)`, opacity: 1 }],
        { duration: 520, easing: "cubic-bezier(.18,.8,.25,1)" },
      );
    }
    return slip;
  });
  evidenceTray.replaceChildren(...slips);
  previousMessages = messages;
}

function tallyMarks(count, previous) {
  const fragment = document.createDocumentFragment();
  for (let groupStart = 0; groupStart < count; groupStart += 5) {
    const group = node("span", "tally-group");
    const groupCount = Math.min(5, count - groupStart);
    for (let index = 0; index < groupCount; index += 1) {
      const stroke = node("i", `tally-stroke${index === 4 ? " fifth" : ""}`);
      if (groupStart + index >= previous) {
        stroke.animate(
          [{ transform: `${index === 4 ? "rotate(77deg)" : "rotate(4deg)"} scaleY(0)`, opacity: 0 }, { transform: index === 4 ? "rotate(77deg) scaleY(1)" : "rotate(4deg) scaleY(1)", opacity: 1 }],
          { duration: 280, delay: index * 55, easing: "ease-out", fill: "both" },
        );
      }
      group.append(stroke);
    }
    fragment.append(group);
  }
  return fragment;
}

function renderVote(state) {
  document.querySelector("#phase-title").textContent = "SUS WORD · VOTE";
  document.querySelector("#round-label").textContent = `ROUND ${state.roundNumber}`;
  const rows = (state.round?.tallies || []).map(({ player, votes }) => {
    const row = node("article", "vote-row");
    row.append(polaroid(player, { tilt: -1 }));
    const slip = node("div", "tally-slip paper-slip");
    slip.append(tallyMarks(votes, previousTallies[player.id] || 0));
    row.append(slip);
    return row;
  });
  document.querySelector("#vote-rows").replaceChildren(...rows);
  previousTallies = Object.fromEntries((state.round?.tallies || []).map(({ player, votes }) => [player.id, votes]));
}

function remainingMs() {
  if (!currentState) return 0;
  if (Number.isFinite(currentState.remainingMs)) {
    return Math.max(0, currentState.remainingMs - (Date.now() - receivedAt));
  }
  if (currentState.phaseEndsAt) return Math.max(0, currentState.phaseEndsAt - Date.now());
  return Math.max(0, (currentState.round?.remainingMs || 0) - (Date.now() - receivedAt));
}

function updateClocks() {
  if (!currentState) return;
  const remaining = remainingMs();
  if (currentState.phase === "ROUND") {
    document.querySelector("#round-timer").textContent = formatTime(remaining);
    document.querySelector("#timer-arc").style.strokeDashoffset = String(circumference * (1 - Math.min(1, remaining / 180_000)));
    const second = Math.ceil(remaining / 1_000);
    if (second <= 10 && second > 0 && second !== lastTickSecond) playTick();
    lastTickSecond = second;
  } else if (currentState.phase === "VOTE") {
    document.querySelector("#vote-timer").textContent = formatTime(remaining);
  }
}

function audio() {
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  if (!AudioEngine) return null;
  audioContext ||= new AudioEngine();
  return audioContext;
}

function playTick() {
  const context = audio();
  if (!context || context.state !== "running") return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 860;
  gain.gain.setValueAtTime(.035, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .045);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + .05);
}

function playThud() {
  const context = audio();
  if (!context || context.state !== "running") return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(105, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(42, context.currentTime + .15);
  gain.gain.setValueAtTime(.12, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .18);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + .2);
}

function playWhirr() {
  const context = audio();
  if (!context || context.state !== "running") return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sawtooth";
  oscillator.frequency.setValueAtTime(70, context.currentTime);
  oscillator.frequency.linearRampToValueAtTime(145, context.currentTime + .35);
  oscillator.frequency.linearRampToValueAtTime(55, context.currentTime + 1.1);
  gain.gain.setValueAtTime(.015, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + 1.15);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 1.2);
}

function highlightedMessage(evidence, className = "evidence-message") {
  const line = node("div", className);
  line.append(document.createTextNode(`@${evidence.player.login}: `));
  const before = evidence.text.slice(0, evidence.index);
  const match = evidence.text.slice(evidence.index, evidence.index + evidence.length);
  const after = evidence.text.slice(evidence.index + evidence.length);
  line.append(document.createTextNode(before));
  const mark = node("mark", "", match);
  line.append(mark, document.createTextNode(after));
  return { line, mark };
}

function schedule(callback, milliseconds) {
  const timer = setTimeout(callback, milliseconds);
  revealTimers.push(timer);
}

function clearReveal() {
  revealTimers.forEach(clearTimeout);
  revealTimers = [];
  revealView.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
  revealView.replaceChildren();
}

function showReveal(state) {
  const reveal = state.round.reveal;
  const speed = new URLSearchParams(location.search).has("mock") ? .18 : 1;
  clearReveal();

  const title = node("h1", "reveal-title reveal-paper", "THE IMPOSTER WAS…");
  const deck = node("div", "shuffle-deck");
  const roster = state.players.length ? state.players : [reveal.impostor];
  const cards = roster.slice(0, 5).map((player, index) => {
    const card = polaroid(player, { className: "shuffle-card", atName: true, tilt: (index - 2) * 2 });
    card.style.zIndex = String(index + 1);
    deck.append(card);
    return card;
  });
  revealView.append(title, deck);
  title.animate([{ opacity: 0, transform: "translateY(-20px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 550 * speed, fill: "both" });
  cards.forEach((card, index) => card.animate(
    [
      { transform: `translateX(0) rotate(${(index - 2) * 2}deg)` },
      { transform: `translateX(${index % 2 ? 155 : -155}px) rotate(${index % 2 ? 9 : -9}deg)` },
      { transform: `translateX(0) rotate(${(2 - index) * 2}deg)` },
    ],
    { duration: 650 * speed, iterations: Math.max(2, Math.round(3 / speed)), delay: index * 60 * speed, easing: "ease-in-out" },
  ));

  schedule(() => {
    deck.replaceChildren();
    const finalCard = polaroid(reveal.impostor, { className: "shuffle-card final", atName: true });
    deck.append(finalCard);
    finalCard.animate([{ transform: "rotateY(90deg) scale(.9)" }, { transform: "rotateY(0deg) scale(1)" }], { duration: 620 * speed, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
    const stamp = node("div", "imposter-stamp", "IMPOSTER");
    revealView.append(stamp);
    stamp.animate([{ transform: "rotate(-10deg) scale(1.6)", opacity: 0 }, { transform: "rotate(-10deg) scale(1)", opacity: 1 }], { duration: 320 * speed, delay: 420 * speed, easing: "cubic-bezier(.2,.9,.2,1.2)", fill: "both" });
    schedule(() => {
      playThud();
      stage.animate([{ transform: stage.style.transform }, { transform: `${stage.style.transform} translate(6px,-3px)` }, { transform: `${stage.style.transform} translate(-4px,2px)` }, { transform: stage.style.transform }], { duration: 180 });
    }, 430 * speed);
  }, 2_500 * speed);

  schedule(() => startRewind(reveal, speed), 5_000 * speed);
  schedule(() => showVerdict(reveal, speed), 11_000 * speed);
  schedule(() => showSneakiness(reveal, speed), 13_000 * speed);
  schedule(() => showLeaderboard(reveal, speed), 16_000 * speed);
}

function startRewind(reveal, speed) {
  playWhirr();
  const area = node("section", "rewind-area");
  const counter = node("time", "rewind-counter", reveal.messages.at(-1)?.elapsed || "3:00");
  const tape = node("div", "rewind-tape");
  const messages = [...reveal.messages].reverse();
  tape.append(...messages.map((message) => paperMessage(message, "rewind-message reveal-paper")));
  area.append(counter, tape);
  revealView.append(area);
  area.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 * speed, fill: "both" });
  tape.animate([{ transform: "translateY(-80%)", filter: "blur(2px)" }, { transform: "translateY(0)", filter: "blur(0)" }], { duration: 2_500 * speed, easing: "cubic-bezier(.05,.7,.18,1)", fill: "both" });
  const from = reveal.messages.at(-1)?.elapsedMs || 180_000;
  const to = reveal.evidence?.elapsedMs || 0;
  const started = performance.now();
  const duration = 2_350 * speed;
  function updateCounter(now) {
    const progress = Math.min(1, (now - started) / duration);
    counter.textContent = formatTime(from - (from - to) * progress);
    if (progress < 1) requestAnimationFrame(updateCounter);
  }
  requestAnimationFrame(updateCounter);
  schedule(() => {
    area.remove();
    showEvidence(reveal, speed);
  }, 2_550 * speed);
}

function showEvidence(reveal, speed) {
  const card = node("article", "evidence-card reveal-paper");
  if (reveal.evidence) {
    const { line, mark } = highlightedMessage(reveal.evidence);
    mark.style.background = "linear-gradient(var(--yellow), var(--yellow)) no-repeat 0 75% / 0% 58%";
    card.append(line);
    schedule(() => mark.animate(
      [{ backgroundSize: "0% 58%" }, { backgroundSize: "100% 58%" }],
      { duration: 800 * speed, easing: "ease-out", fill: "both" },
    ), 280 * speed);
  } else {
    const label = node("div", "evidence-message", "THE WORD NEVER MADE IT OUT");
    const crossed = node("div", "crossed-word", reveal.word);
    card.append(label, crossed);
  }
  card.append(node("p", "reveal-caption", reveal.caption));
  revealView.append(card);
  card.animate([{ transform: "scale(.7)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 650 * speed, easing: "cubic-bezier(.2,.85,.2,1.1)", fill: "both" });
}

function showVerdict(reveal, speed) {
  const panel = node("section", "verdict-panel");
  panel.append(node("h2", "verdict-title reveal-paper", "VERDICT"));
  const slip = node("div", "verdict-slip reveal-paper");
  const stamp = node("div", `verdict-stamp${reveal.verdict.length > 12 ? " long" : ""}`, reveal.verdict);
  const imposterChange = reveal.scoreChanges.find(({ player }) => player.id === reveal.impostor.id)?.delta || 0;
  slip.append(stamp, node("strong", "verdict-points", `+${imposterChange}`));
  panel.append(slip);
  revealView.append(panel);
  panel.animate([{ opacity: 0, transform: "translateX(80px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: 500 * speed, fill: "both" });
  stamp.animate([{ transform: "rotate(-9deg) scale(1.6)" }, { transform: "rotate(-9deg) scale(1)" }], { duration: 320 * speed, delay: 220 * speed, easing: "cubic-bezier(.2,.9,.2,1.2)", fill: "both" });
  schedule(playThud, 240 * speed);
}

function showSneakiness(reveal, speed) {
  const slip = node("blockquote", "sneakiness-slip reveal-paper", reveal.sneakiness);
  revealView.append(slip);
  slip.animate([{ opacity: 0, transform: "translateY(24px) rotate(-1deg)" }, { opacity: 1, transform: "translateY(0) rotate(-1deg)" }], { duration: 500 * speed, fill: "both" });
}

function showLeaderboard(reveal, speed) {
  const boardElement = node("section", "leaderboard reveal-paper");
  boardElement.append(node("h2", "", "LEADERBOARD"));
  for (const entry of reveal.leaderboard) {
    const row = node("div", "leader-row");
    const avatar = node("img", "mini-avatar");
    avatar.src = entry.player.avatar || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='46' height='46'%3E%3Crect width='46' height='46' fill='%236b5b85'/%3E%3C/svg%3E";
    avatar.alt = "";
    row.append(avatar, node("span", "", `@${entry.player.login}`), node("strong", "", String(entry.score)));
    boardElement.append(row);
  }
  revealView.append(boardElement);
  boardElement.animate([{ opacity: 0, transform: "translateY(35px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 550 * speed, fill: "both" });

  if (reveal.accidentalDecoys?.length) {
    const stack = node("aside", "decoy-stack");
    stack.append(node("h3", "", "ACCIDENTAL DECOYS"));
    reveal.accidentalDecoys.slice(0, 3).forEach((decoy, index) => {
      const slip = node("div", "decoy-slip reveal-paper");
      slip.style.setProperty("--tilt", `${index % 2 ? 1 : -1}deg`);
      slip.textContent = `${decoy.caption} “${decoy.text}”`;
      stack.append(slip);
    });
    revealView.append(stack);
    stack.animate([{ opacity: 0, transform: "translateX(-35px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: 550 * speed, fill: "both" });
  }
}

function render(state) {
  currentState = state;
  receivedAt = Date.now();
  const phase = state.phase || state.state;
  setViews(phase);
  if (phase !== "REVEAL" && revealKey !== null) {
    clearReveal();
    revealKey = null;
  }
  if (phase === "LOBBY") renderLobby(state);
  if (phase === "ROUND") renderRound(state);
  if (phase === "VOTE") renderVote(state);
  if (phase === "REVEAL" && state.round?.reveal) {
    const key = `${state.roundNumber}:${state.round.reveal.outcome}`;
    if (revealKey !== key) {
      revealKey = key;
      showReveal(state);
    }
  }
  updateClocks();
}

const demoPlayers = [
  { id: "p1", login: "pixel_mara", displayName: "pixel_mara", avatar: "", claimed: true, score: 6 },
  { id: "p2", login: "tomtom_irl", displayName: "tomtom_irl", avatar: "", claimed: true, score: 4 },
  { id: "p3", login: "quietfox", displayName: "quietfox", avatar: "", claimed: true, score: 2 },
  { id: "p4", login: "romabuilds", displayName: "romabuilds", avatar: "", claimed: true, score: 1 },
];

const demoMessages = [
  { id: "m1", player: demoPlayers[1], text: "who else is eating dinner rn", elapsedMs: 38_000, elapsed: "0:38" },
  { id: "m2", player: demoPlayers[2], text: "the lights in my room keep flickering", elapsedMs: 57_000, elapsed: "0:57" },
  { id: "m3", player: demoPlayers[0], text: "same, storm season is brutal", elapsedMs: 65_000, elapsed: "1:05" },
  { id: "m4", player: demoPlayers[0], text: "ugh the power went out so I lit a candle lol", elapsedMs: 72_000, elapsed: "1:12" },
  { id: "m5", player: demoPlayers[1], text: "that is such a cozy emergency plan", elapsedMs: 84_000, elapsed: "1:24" },
  { id: "m6", player: demoPlayers[2], text: "honestly I need one for my desk", elapsedMs: 93_000, elapsed: "1:33" },
];

function mockState(kind) {
  const base = { state: kind.toUpperCase(), phase: kind.toUpperCase(), roundNumber: 2, players: demoPlayers, claimedCount: 4, cardUrl: "susword.example/card", scores: demoPlayers.map((player) => ({ player, score: player.score })) };
  if (kind === "round") return { ...base, phaseEndsAt: Date.now() + 108_000, round: { remainingMs: 108_000, hints: { category: "home", letter: null }, messageCounts: { p1: 7, p2: 5, p3: 3, p4: 4 }, latestMessages: demoMessages.slice(0, 3) } };
  if (kind === "vote") return { ...base, phaseEndsAt: Date.now() + 21_000, round: { tallies: [{ player: demoPlayers[2], votes: 12 }, { player: demoPlayers[0], votes: 6 }, { player: demoPlayers[1], votes: 0 }, { player: demoPlayers[3], votes: 0 }] } };
  const evidence = { ...demoMessages[3], index: 34, length: 6 };
  return {
    ...base,
    phase: "REVEAL",
    state: "REVEAL",
    round: {
      reveal: {
        impostor: demoPlayers[0], word: "candle", evidence, smuggled: true, caption: "1:12 into the round. 2 people read this. Nobody noticed.", messages: demoMessages,
        accidentalDecoys: [{ ...demoMessages[1], caption: "@quietfox said it too, by accident." }], verdict: "GOT AWAY", outcome: "got_away", sneakiness: "Hid ‘candle’ inside a complaint about the power bill. Cold.",
        scoreChanges: demoPlayers.map((player, index) => ({ player, delta: index ? 0 : 3, score: player.score })), leaderboard: demoPlayers.map((player) => ({ player, score: player.score })),
      },
    },
  };
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?view=overlay`);
  socket.addEventListener("open", () => {
    reconnectDelay = 1_000;
    connectionBadge.hidden = true;
  });
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") render(payload.data);
  });
  socket.addEventListener("close", () => {
    connectionBadge.hidden = !currentState || currentState.phase === "IDLE";
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.7);
  });
}

addEventListener("resize", fitStage);
addEventListener("pointerdown", () => audio()?.resume(), { once: true });
fitStage();
setInterval(updateClocks, 250);

const mock = new URLSearchParams(location.search).get("mock");
if (["round", "vote", "reveal"].includes(mock)) render(mockState(mock));
else connect();
