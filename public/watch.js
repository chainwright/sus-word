import { revealMarkerPlan } from "/watch-state.js";

const overlayFrame = document.querySelector("#overlay-frame");
const cardFrame = document.querySelector("#card-frame");
const streamFrame = document.querySelector("#stream-frame");
const phoneShell = document.querySelector("#phone-shell");
const chatLines = document.querySelector("#chat-lines");
const switcher = document.querySelector("#player-switcher");
const followLabel = document.querySelector("#follow-label");
const phaseLabel = document.querySelector("#phase-label");
const connectionLabel = document.querySelector("#connection-label");
let activePlayer = 1;
let socket = null;
let reconnectDelay = 1_000;
let revealedImpostors = new Set();
let revealMarkerTimer = null;
let markerRound = null;

function scaleFrame(container, frame, nativeWidth, nativeHeight) {
  const scale = Math.min(container.clientWidth / nativeWidth, container.clientHeight / nativeHeight);
  frame.style.transform = `scale(${scale})`;
}

function fitFrames() {
  scaleFrame(streamFrame, overlayFrame, 1280, 720);
  scaleFrame(phoneShell, cardFrame, 390, 844);
}

new ResizeObserver(fitFrames).observe(streamFrame);
new ResizeObserver(fitFrames).observe(phoneShell);
addEventListener("load", fitFrames);

function voteLike(message) {
  return message?.isVote || message?.voteMessage || /^\s*(?:!vote\s+|[!#]?\d+\s*$)/i.test(message?.text || "");
}

function messageKey(message) {
  return message?.id || `${message?.player?.id || "viewer"}:${message?.elapsedMs || 0}:${message?.text || ""}`;
}

function visibleMessages(state) {
  const round = state?.round;
  const reveal = round?.reveal;
  const source = round?.recentMessages?.length
    ? round.recentMessages
    : reveal?.messages || reveal?.imposters?.flatMap((result) => result.messages || []) || [];
  const unique = new Map();
  for (const message of source) {
    if (!message || voteLike(message)) continue;
    unique.set(messageKey(message), message);
  }
  return [...unique.values()].slice(-7);
}

function renderChat(state) {
  const lines = visibleMessages(state).map((message) => {
    const line = document.createElement("p");
    line.className = `chat-line${message.source === "voice" ? " voice" : ""}`;
    const name = document.createElement("strong");
    name.textContent = `${message.player?.login || "player"}: `;
    line.append(name, document.createTextNode(message.text || ""));
    return line;
  });
  chatLines.replaceChildren(...lines);
}

function paintRevealedImpostors() {
  for (const button of switcher.querySelectorAll("button")) {
    button.classList.toggle("revealed-impostor", revealedImpostors.has(Number(button.dataset.player)));
  }
}

function updateRevealMarkers(state) {
  const phase = state?.phase ?? state?.state;
  if (phase === "ROUND" && markerRound !== state.roundNumber) {
    markerRound = state.roundNumber;
    revealedImpostors = new Set();
    clearTimeout(revealMarkerTimer);
    revealMarkerTimer = null;
    paintRevealedImpostors();
    return;
  }
  const plan = revealMarkerPlan(state);
  if (!plan) return;
  clearTimeout(revealMarkerTimer);
  revealMarkerTimer = setTimeout(() => {
    revealedImpostors = new Set(plan.numbers);
    paintRevealedImpostors();
  }, plan.delayMs);
}

function renderState(state) {
  renderChat(state);
  const phase = String(state?.phase || state?.state || "LIVE");
  const phaseName = state?.final ? "Final table" : `${phase[0]}${phase.slice(1).toLowerCase()}`;
  phaseLabel.textContent = `Phase: ${phaseName}`;
  connectionLabel.textContent = phase === "LOBBY"
    ? "Players are getting their new case files"
    : phase === "REVEAL" ? "The case is being revealed" : `Round ${state?.roundNumber || 1} is live`;
  updateRevealMarkers(state);
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const next = new WebSocket(`${protocol}//${location.host}/ws?view=overlay`);
  socket = next;
  next.addEventListener("open", () => {
    reconnectDelay = 1_000;
    connectionLabel.textContent = "Connected to the live round";
  });
  next.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") renderState(payload.data);
  });
  next.addEventListener("close", () => {
    if (socket !== next) return;
    connectionLabel.textContent = "Reconnecting to the round…";
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.7);
  });
}

switcher.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-player]");
  if (!button) return;
  activePlayer = Number(button.dataset.player);
  for (const candidate of switcher.querySelectorAll("button")) {
    candidate.setAttribute("aria-pressed", String(candidate === button));
  }
  followLabel.textContent = `Follow player ${activePlayer}`;
  cardFrame.src = `/card?demo=${activePlayer}`;
});

connect();
