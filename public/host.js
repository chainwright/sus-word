const phase = document.querySelector("#phase");
const round = document.querySelector("#round");
const timer = document.querySelector("#timer");
const players = document.querySelector("#players");
const total = document.querySelector("#player-total");
const cardUrl = document.querySelector("#card-url");
const stateJson = document.querySelector("#state-json");
const actionResult = document.querySelector("#action-result");
const connection = document.querySelector("#connection");
const micToggle = document.querySelector("#mic-toggle");
const micDot = document.querySelector("#mic-dot");
const voiceInterim = document.querySelector("#voice-interim");
const voiceHelp = document.querySelector("#voice-help");
const voiceRosterWarning = document.querySelector("#voice-roster-warning");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let state = null;
let reconnectDelay = 1_000;
let hostSocket = null;
let recognition = null;
let micEnabled = false;
let restartTimer = null;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function avatar(player) {
  const wrap = node("span", "avatar");
  if (player.avatar) {
    const image = node("img");
    image.src = player.avatar;
    image.alt = "";
    wrap.append(image);
  } else {
    wrap.textContent = (player.displayName || player.login).slice(0, 2).toUpperCase();
  }
  return wrap;
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function render(nextState) {
  state = nextState;
  phase.textContent = state.phase;
  round.textContent = state.roundNumber || "—";
  const rows = state.players.map((player) => {
    const row = node("div", "player");
    row.append(avatar(player), node("span", "player-name", `@${player.login}`), node("span", "lock", player.claimed ? "🔒" : ""));
    return row;
  });
  players.replaceChildren(...rows);
  total.textContent = `(${state.players.length})`;
  cardUrl.textContent = state.cardUrl;
  cardUrl.href = state.cardUrl;
  stateJson.textContent = JSON.stringify(state, null, 2);
  const broadcaster = state.players.find((player) => (
    player.login === state.channelLogin && player.claimed
  ));
  voiceRosterWarning.hidden = Boolean(broadcaster);
  updateTimer();
}

function updateTimer() {
  if (!state?.phaseEndsAt) timer.textContent = "—";
  else timer.textContent = formatTime(state.phaseEndsAt - Date.now());
}

async function runAction(button) {
  button.disabled = true;
  actionResult.textContent = "Working…";
  actionResult.classList.remove("error");
  try {
    const response = await fetch(`/api/host/${button.dataset.action}`, { method: "POST" });
    const result = await response.json();
    actionResult.textContent = result.ok ? `${button.textContent} complete.` : `Could not ${button.textContent.toLowerCase()}: ${result.reason.replaceAll("_", " ")}.`;
    actionResult.classList.toggle("error", !result.ok);
  } catch {
    actionResult.textContent = "The server did not respond.";
    actionResult.classList.add("error");
  } finally {
    button.disabled = false;
  }
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?view=host`);
  hostSocket = socket;
  socket.addEventListener("open", () => {
    connection.textContent = "LIVE";
    connection.classList.add("online");
    reconnectDelay = 1_000;
  });
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") render(payload.data);
    if (payload.type === "voiceResult" && !payload.data.ok) {
      voiceHelp.textContent = payload.data.reason === "invalid_message"
        ? "Voice ignored: join the game before speaking."
        : "Voice chunk was not accepted.";
    }
  });
  socket.addEventListener("close", () => {
    if (hostSocket === socket) hostSocket = null;
    connection.textContent = "RECONNECTING";
    connection.classList.remove("online");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.7);
  });
}

function setMicState(label, className = "") {
  voiceInterim.textContent = label;
  micDot.className = `mic-dot ${className}`.trim();
}

function sendVoice(text) {
  if (hostSocket?.readyState !== WebSocket.OPEN) {
    voiceHelp.textContent = "Voice not sent: the host connection is offline.";
    return;
  }
  hostSocket.send(JSON.stringify({ type: "voice", text }));
  voiceInterim.textContent = `Sent: “${text}”`;
  voiceHelp.textContent = "";
}

function scheduleRecognitionRestart() {
  if (!micEnabled || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startRecognition();
  }, 500);
}

function startRecognition() {
  if (!micEnabled || !recognition) return;
  try {
    recognition.start();
  } catch {
    scheduleRecognitionRestart();
  }
}

function disableMic(message = "Mic is off.") {
  micEnabled = false;
  clearTimeout(restartTimer);
  restartTimer = null;
  micToggle.classList.remove("active");
  micToggle.setAttribute("aria-pressed", "false");
  micToggle.textContent = "🎙 Mic";
  recognition?.stop();
  setMicState(message);
}

function setupVoice() {
  if (!SpeechRecognition) {
    micToggle.disabled = true;
    voiceHelp.textContent = "Voice needs Google Chrome";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onstart = () => setMicState("Listening…", "listening");
  recognition.onspeechstart = () => micDot.className = "mic-dot speaking";
  recognition.onspeechend = () => micDot.className = "mic-dot listening";
  recognition.onresult = (event) => {
    const interim = [];
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript.trim();
      if (!text) continue;
      if (event.results[index].isFinal) sendVoice(text);
      else interim.push(text);
    }
    if (interim.length) voiceInterim.textContent = interim.join(" ");
  };
  recognition.onerror = (event) => {
    if (event.error === "network" && micEnabled) {
      setMicState("Network interrupted. Retrying…", "error");
      recognition.abort();
      scheduleRecognitionRestart();
      return;
    }
    if (["not-allowed", "service-not-allowed"].includes(event.error)) {
      voiceHelp.textContent = "Microphone permission is required.";
      disableMic("Mic permission blocked.");
      return;
    }
    // Silence is normal between sentences; onend restarts recognition.
    if (event.error === "no-speech") {
      setMicState("Listening… (no speech heard yet)", "listening");
      return;
    }
    setMicState(`Mic error: ${event.error}`, "error");
  };
  recognition.onend = () => {
    if (micEnabled) scheduleRecognitionRestart();
  };
}

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => runAction(button));
}

document.querySelector("#copy-card").addEventListener("click", async (event) => {
  if (!state?.cardUrl) return;
  await navigator.clipboard.writeText(state.cardUrl);
  event.currentTarget.textContent = "Copied ✓";
  setTimeout(() => { event.currentTarget.textContent = "Copy card URL"; }, 1_400);
});

micToggle.addEventListener("click", () => {
  if (micEnabled) {
    disableMic();
    return;
  }
  micEnabled = true;
  micToggle.classList.add("active");
  micToggle.setAttribute("aria-pressed", "true");
  micToggle.textContent = "■ Mic on";
  voiceHelp.textContent = "";
  startRecognition();
});

setInterval(updateTimer, 500);
setupVoice();
connect();
