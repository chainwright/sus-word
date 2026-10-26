import {
  selectLobbyPlayers,
  selectRoundPlayers,
  selectVoteSuspects,
} from "/display.js";

const stage = document.querySelector("#stage");
const idleTag = document.querySelector("#idle-tag");
const board = document.querySelector("#case-board");
const lobbyView = document.querySelector("#lobby-view");
const roundView = document.querySelector("#round-view");
const voteView = document.querySelector("#vote-view");
const revealView = document.querySelector("#reveal-view");
const evidenceTray = document.querySelector("#evidence-tray");
const connectionBadge = document.querySelector("#connection-badge");

let currentState = null;
let receivedAt = Date.now();
let reconnectDelay = 1_000;
let previousCounts = {};
let previousTallies = {};
let previousMessages = [];
let previousTopPlayerIds = [];
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
  const voice = message.source === "voice";
  if (voice) slip.classList.add("voice-message");
  const name = message.player?.displayName || message.player?.login || "unknown";
  const author = node("strong", "", `${voice ? "🎙 " : ""}${name}${voice ? " (said out loud)" : ""}: `);
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

function renderTableContext(state) {
  const plate = document.querySelector("#table-plate");
  const ticker = document.querySelector("#accusation-ticker");
  const count = state.tables?.length || state.round?.tableCount || 0;
  const tableId = state.featuredTableId || state.round?.tableId;
  plate.hidden = !tableId || state.phase === "LOBBY";
  plate.textContent = state.final
    ? `FINAL TABLE · ${state.round?.players?.length || state.players.length} players · on stream`
    : `TABLE ${tableId} of ${count || 1} · ${state.round?.players?.length || state.players.length} players · on stream`;
  const accusations = (state.round?.accusations || []).slice(-2);
  ticker.hidden = accusations.length === 0 || state.phase === "LOBBY";
  ticker.replaceChildren(...accusations.map((entry) => node(
    "span",
    entry.correct ? "ticker-hit" : "ticker-miss",
    entry.correct
      ? `✅ @${entry.accuser.login} busted @${entry.target?.login || "suspect"}`
      : `❌ @${entry.accuser.login} guessed wrong`,
  )));
}

function renderLobby(state) {
  document.querySelector("#phase-title").textContent = "SUS WORD";
  document.querySelector("#round-label").textContent = state.roundNumber ? `· LOBBY · AFTER ROUND ${state.roundNumber}` : "· LOBBY";
  const roster = document.querySelector("#lobby-roster");
  const visible = selectLobbyPlayers(state.players);
  roster.replaceChildren(...visible.map((player, index) => (
    polaroid(player, { locked: player.claimed, tilt: [-2, 1, -1, 2][index % 4] })
  )));
  const overflow = document.querySelector("#lobby-overflow");
  const hiddenCount = Math.max(0, state.players.length - visible.length);
  overflow.hidden = hiddenCount === 0;
  overflow.textContent = `+${hiddenCount} more joined`;
  document.querySelector("#join-line").textContent = `Type !join · get your card at ${state.cardUrl || `${location.origin}/card`}`;
  document.querySelector("#claim-count").textContent = state.claimedCount >= 3
    ? `${state.claimedCount} card holders · ready`
    : `Need 3 card holders · ${state.claimedCount}/3`;
}

function revealHint(selector, label, value) {
  const card = document.querySelector(selector);
  const strong = card.querySelector("strong");
  const prior = strong.dataset.value || "";
  const next = value || "🔒";
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
  document.querySelector("#round-label").textContent = state.final ? "FINAL TABLE" : `ROUND ${state.roundNumber}`;
  revealHint("#category-hint", "CATEGORY", state.round?.hints?.category);
  revealHint("#letter-hint", "STARTS WITH", state.round?.hints?.letter);

  const roster = state.round?.players || state.players;
  const visible = selectRoundPlayers(
    roster,
    state.round?.messageCounts,
    state.round?.messageRecency,
  );
  const priorTop = new Set(previousTopPlayerIds);
  const players = document.querySelector("#round-players");
  const priorPositions = new Map([...players.children].map((card) => [
    card.dataset.playerId,
    { left: card.offsetLeft, top: card.offsetTop },
  ]));
  players.classList.toggle("compact", visible.length > 4);
  const cards = visible.map((player, index) => {
    const tilt = [-2, 1, -1, 2][index % 4];
    const card = polaroid(player, { className: "round-player", tilt });
    const count = state.round?.messageCounts?.[player.id] || 0;
    card.append(node("span", "round-player-count", String(count)));
    card.dataset.entering = String(previousTopPlayerIds.length > 0 && !priorTop.has(player.id));
    card.dataset.bumped = String(count > (previousCounts[player.id] || 0));
    const bust = state.round?.busted?.find(({ impostor }) => impostor?.id === player.id);
    if (bust) {
      const mark = node("div", "live-busted-stamp");
      mark.append(node("strong", "", "BUSTED"), node("small", "", `by @${bust.accuser?.login || "detective"}`));
      card.append(mark);
    }
    return card;
  });
  players.replaceChildren(...cards);
  cards.forEach((card, index) => {
    const tilt = [-2, 1, -1, 2][index % 4];
    const prior = priorPositions.get(card.dataset.playerId);
    if (card.dataset.entering === "true") {
      card.animate(
        [
          { opacity: 0, transform: `translateY(14px) rotate(${tilt}deg) scale(.96)` },
          { opacity: 1, transform: `translateY(0) rotate(${tilt}deg) scale(1)` },
        ],
        { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    } else if (prior && (prior.left !== card.offsetLeft || prior.top !== card.offsetTop)) {
      card.animate(
        [
          { transform: `translate(${prior.left - card.offsetLeft}px, ${prior.top - card.offsetTop}px) rotate(${tilt}deg)` },
          { transform: `translate(0, 0) rotate(${tilt}deg)` },
        ],
        { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    } else if (card.dataset.bumped === "true") {
      card.animate(
        [
          { transform: `rotate(${tilt}deg) scale(1)` },
          { transform: "rotate(-4deg) scale(1.11)" },
          { transform: "rotate(3deg) scale(1.05)" },
          { transform: `rotate(${tilt}deg) scale(1)` },
        ],
        { duration: 520, easing: "ease-out" },
      );
    }
  });
  previousTopPlayerIds = visible.map(({ id }) => id);
  const overflow = document.querySelector("#round-overflow");
  const hiddenCount = Math.max(0, roster.length - visible.length);
  overflow.hidden = hiddenCount === 0;
  overflow.textContent = `+${hiddenCount} detectives`;
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
  document.querySelector("#phase-title").textContent = "SUS WORD";
  document.querySelector("#round-label").textContent = state.final ? "· VOTE · FINAL TABLE" : `· VOTE · ROUND ${state.roundNumber}`;
  const allTallies = state.round?.tallies || [];
  const visibleTallies = selectVoteSuspects(allTallies);
  const rows = visibleTallies.map(({ player, votes }) => {
    const row = node("article", "vote-row");
    row.append(polaroid(player, { tilt: -1 }));
    const slip = node("div", "tally-slip paper-slip");
    if (votes > 12) {
      const total = node("strong", "tally-total", `×${votes}`);
      slip.append(total);
      if (votes > (previousTallies[player.id] || 0)) {
        total.animate(
          [{ opacity: 0, transform: "rotate(-4deg) scale(.75)" }, { opacity: 1, transform: "rotate(-4deg) scale(1)" }],
          { duration: 320, easing: "cubic-bezier(.2,.9,.2,1.15)" },
        );
      }
    } else {
      slip.append(tallyMarks(votes, previousTallies[player.id] || 0));
    }
    row.append(slip);
    return row;
  });
  document.querySelector("#vote-rows").replaceChildren(...rows);
  const votesCast = allTallies.reduce((sum, { votes }) => sum + votes, 0);
  const playerCount = state.round?.players?.length || allTallies.length || state.players.length;
  document.querySelector("#vote-summary").textContent = `${votesCast} votes cast · ${playerCount} players`;
  previousTallies = Object.fromEntries(allTallies.map(({ player, votes }) => [player.id, votes]));
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
    const duration = Math.max(1, Number(currentState.phaseDurationMs) || 180_000);
    const progress = Math.min(1, Math.max(0, 1 - remaining / duration));
    document.querySelector("#round-timer-hand").style.transform = `rotate(${progress * 360}deg)`;
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
  const voice = evidence.source === "voice";
  if (voice) line.classList.add("voice-message");
  line.append(document.createTextNode(`${voice ? "🎙 " : ""}@${evidence.player.login}${voice ? " (said out loud)" : ""}: `));
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
  const tableReveal = state.round.reveal;
  const results = tableReveal.imposters?.length ? tableReveal.imposters : [tableReveal];
  const reveal = {
    ...results.at(-1),
    leaderboard: tableReveal.leaderboard,
    scoreChanges: tableReveal.scoreChanges,
    otherTables: tableReveal.otherTables || [],
    champion: tableReveal.champion || state.champion,
  };
  const speed = new URLSearchParams(location.search).has("mock") ? .18 : 1;
  clearReveal();

  if (results.length > 1) {
    const prior = node("aside", "prior-imposters");
    results.slice(0, -1).forEach((result, index) => {
      const caseCard = node("article", "prior-imposter reveal-paper");
      caseCard.append(avatarPhoto(result.impostor));
      caseCard.append(
        node("strong", "", `@${result.impostor.login}`),
        node("span", "", result.word.toUpperCase()),
        node("b", "", result.verdict),
      );
      caseCard.animate(
        [{ transform: "translateY(-100px) rotate(-8deg)", opacity: 0 }, { transform: `translateY(0) rotate(${index % 2 ? 2 : -2}deg)`, opacity: 1 }],
        { duration: 440 * speed, delay: index * 650 * speed, fill: "both" },
      );
      prior.append(caseCard);
    });
    revealView.append(prior);
  }

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
    finalCard.animate(
      [
        { transform: "translateY(-190px) rotateY(90deg) scale(.88)", opacity: 0 },
        { transform: "translateY(12px) rotateY(0deg) scale(1.03)", opacity: 1, offset: .82 },
        { transform: "translateY(0) rotateY(0deg) scale(1)", opacity: 1 },
      ],
      { duration: 620 * speed, easing: "cubic-bezier(.18,.82,.2,1)", fill: "both" },
    );
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
  slip.append(stamp);
  if (imposterChange) slip.append(node("strong", "verdict-points", `+${imposterChange}`));
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
  for (const entry of reveal.leaderboard.slice(0, 5)) {
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

  if (reveal.otherTables?.length) {
    const strip = node("aside", "other-table-results reveal-paper");
    strip.append(node("strong", "", "OTHER TABLES"));
    for (const table of reveal.otherTables) {
      const summary = table.results.map(({ verdict }) => verdict).join(" · ");
      strip.append(node("span", "", `T${table.id}  ${summary}`));
    }
    revealView.append(strip);
    strip.animate([{ transform: "translateY(100%)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], { duration: 520 * speed, fill: "both" });
  }

  if (reveal.champion) {
    const champion = node("div", "champion-stamp", `CHAMPION · @${reveal.champion.login}`);
    revealView.append(champion);
    champion.animate([{ transform: "rotate(-5deg) scale(1.7)", opacity: 0 }, { transform: "rotate(-5deg) scale(1)", opacity: 1 }], { duration: 360 * speed, delay: 600 * speed, fill: "both" });
    schedule(playThud, 620 * speed);
  }
}

function render(state) {
  currentState = state;
  receivedAt = Date.now();
  const phase = state.phase || state.state;
  if (phase !== "ROUND") previousTopPlayerIds = [];
  setViews(phase);
  renderTableContext(state);
  if (phase !== "REVEAL" && revealKey !== null) {
    clearReveal();
    revealKey = null;
  }
  if (phase === "LOBBY") renderLobby(state);
  if (phase === "ROUND") renderRound(state);
  if (phase === "VOTE") renderVote(state);
  if (phase === "REVEAL" && state.round?.reveal) {
    const key = `${state.roundNumber}:${(state.round.reveal.imposters || [state.round.reveal]).map(({ outcome }) => outcome).join("-")}`;
    if (revealKey !== key) {
      revealKey = key;
      showReveal(state);
    }
  }
  updateClocks();
}

function mockAvatar(initials, background, hair) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="${background}"/><circle cx="80" cy="69" r="40" fill="#efbd91"/><path d="M39 67c2-39 21-54 43-54 28 0 44 24 40 60-15-17-26-27-42-28-12 13-24 20-41 22Z" fill="${hair}"/><path d="M25 160c6-43 25-62 55-62s49 19 55 62" fill="#3e3347"/><text x="80" y="82" text-anchor="middle" font-size="22" font-family="sans-serif" fill="#3a2a23">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const previewParams = new URLSearchParams(location.search);
const previewPlayerCount = Math.min(60, Math.max(4, Number(previewParams.get("players")) || 4));
const previewTableCount = Math.min(20, Math.max(1, Number(previewParams.get("tables")) || 1));
const featuredPlayers = [
  ["pixel_mara", "PM", "#9a65ca", "#31213d"],
  ["tomtom_irl", "TT", "#6fbd8b", "#513126"],
  ["quietfox", "QF", "#db8450", "#b84d24"],
  ["romabuilds", "RB", "#72a9d2", "#a66b2e"],
];
const demoPlayers = Array.from({ length: previewPlayerCount }, (_, index) => {
  const featured = featuredPlayers[index];
  const login = featured?.[0] || `detective_${String(index + 1).padStart(2, "0")}`;
  const initials = featured?.[1] || `D${(index + 1) % 10}`;
  const background = featured?.[2] || `hsl(${(index * 47) % 360} 45% 58%)`;
  const hair = featured?.[3] || `hsl(${(index * 29 + 18) % 360} 34% 25%)`;
  return {
    id: `p${index + 1}`,
    login,
    displayName: login,
    avatar: mockAvatar(initials, background, hair),
    claimed: index % 6 !== 5,
    joinedAt: Date.now() - (previewPlayerCount - index) * 1_000,
    score: Math.max(0, 12 - Math.floor(index / 2)),
  };
});

const demoMessages = [
  { id: "m1", player: demoPlayers[1], text: "who else is eating dinner rn", elapsedMs: 38_000, elapsed: "0:38" },
  { id: "m2", player: demoPlayers[2], text: "the lights in my room keep flickering", elapsedMs: 57_000, elapsed: "0:57" },
  { id: "m3", player: demoPlayers[3], text: "storm season is brutal", source: "voice", elapsedMs: 65_000, elapsed: "1:05" },
  { id: "m4", player: demoPlayers[0], text: "ugh the power went out so I lit a candle lol", elapsedMs: 72_000, elapsed: "1:12" },
  { id: "m5", player: demoPlayers[1], text: "that is such a cozy emergency plan", elapsedMs: 84_000, elapsed: "1:24" },
  { id: "m6", player: demoPlayers[2], text: "honestly I need one for my desk", elapsedMs: 93_000, elapsed: "1:33" },
];

function mockState(kind) {
  const tables = Array.from({ length: previewTableCount }, (_, index) => ({ id: index + 1, playerCount: 10 + (index % 3) }));
  const base = { state: kind.toUpperCase(), phase: kind.toUpperCase(), roundNumber: 2, featuredTableId: 1, tables, players: demoPlayers, claimedCount: 4, cardUrl: "susword.example/card", scores: demoPlayers.map((player) => ({ player, score: player.score })) };
  const messageCounts = Object.fromEntries(demoPlayers.map((player, index) => [player.id, (index * 7 + 3) % 19]));
  const messageRecency = Object.fromEntries(demoPlayers.map((player, index) => [player.id, (index * 11) % previewPlayerCount]));
  const voteCounts = Array(previewPlayerCount).fill(0);
  let votesRemaining = previewPlayerCount;
  const preferred = previewPlayerCount >= 20 ? [17, 5, 3, 2, 1, 1, 1] : [Math.ceil(previewPlayerCount / 2), 2, 1];
  for (let index = 0; index < voteCounts.length && votesRemaining > 0; index += 1) {
    const votes = Math.min(votesRemaining, preferred[index] ?? 1);
    voteCounts[index] = votes;
    votesRemaining -= votes;
  }
  if (kind === "lobby") return { ...base, state: "LOBBY", phase: "LOBBY", roundNumber: 1, claimedCount: demoPlayers.filter(({ claimed }) => claimed).length };
  if (kind === "round") return { ...base, phaseEndsAt: Date.now() + 108_000, phaseDurationMs: 180_000, remainingMs: 108_000, round: { tableId: 1, tableCount: previewTableCount, players: demoPlayers, remainingMs: 108_000, hints: { category: "home", letter: null }, messageCounts, messageRecency, latestMessages: demoMessages.slice(0, 3), accusations: [{ correct: false, accuser: demoPlayers[2], at: 1 }, { correct: true, accuser: demoPlayers[1], target: demoPlayers[0], at: 2 }], busted: [{ impostor: demoPlayers[0], accuser: demoPlayers[1] }] } };
  if (kind === "vote") return { ...base, phaseEndsAt: Date.now() + 21_000, round: { players: demoPlayers, tallies: demoPlayers.map((player, index) => ({ player, votes: voteCounts[index] })) } };
  const evidence = { ...demoMessages[3], index: 34, length: 6 };
  return {
    ...base,
    phase: "REVEAL",
    state: "REVEAL",
    round: {
      reveal: {
        impostor: demoPlayers[0], word: "candle", evidence, smuggled: true, caption: "1:12 into the round. 2 people read this. Nobody noticed.", messages: demoMessages,
        accidentalDecoys: [{ ...demoMessages[1], caption: "@quietfox said it too, by accident." }], verdict: "GOT AWAY", outcome: "got_away", sneakiness: "Hid ‘candle’ inside a complaint about the power bill. Cold.",
        scoreChanges: demoPlayers.map((player, index) => ({ player, delta: index ? 0 : 3, score: player.score })), leaderboard: demoPlayers.slice(0, 5).map((player) => ({ player, score: player.score })),
        imposters: previewTableCount > 1 ? [
          { impostor: demoPlayers[1], word: "teapot", evidence: null, messages: demoMessages, accidentalDecoys: [], verdict: "CAUGHT", outcome: "caught", caption: "Someone noticed.", sneakiness: "Chat caught the first clue." },
          { impostor: demoPlayers[0], word: "candle", evidence, messages: demoMessages, accidentalDecoys: [{ ...demoMessages[1], caption: "@quietfox said it too, by accident." }], verdict: "GOT AWAY", outcome: "got_away", caption: "1:12 into the round. 2 people read this. Nobody noticed.", sneakiness: "Hid ‘candle’ in plain sight." },
        ] : undefined,
        otherTables: tables.slice(1).map((table, index) => ({ id: table.id, results: [{ impostor: demoPlayers[(index + 2) % demoPlayers.length], verdict: index % 2 ? "CAUGHT" : "GOT AWAY" }] })),
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

const mock = previewParams.get("mock");
if (["lobby", "round", "vote", "reveal"].includes(mock)) render(mockState(mock));
else connect();
