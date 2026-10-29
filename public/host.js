const stage = document.querySelector("#host-stage");
const timer = document.querySelector("#timer");
const timerHand = document.querySelector("#timer-hand");
const phaseLabel = document.querySelector("#phase-label");
const categoryCard = document.querySelector("#category-card");
const categoryHint = document.querySelector("#category-hint");
const letterCard = document.querySelector("#letter-card");
const letterHint = document.querySelector("#letter-hint");
const players = document.querySelector("#players");
const playerTotal = document.querySelector("#player-total");
const playerOverflow = document.querySelector("#player-overflow");
const seeAllPlayers = document.querySelector("#see-all-players");
const allPlayersPanel = document.querySelector("#all-players-panel");
const allPlayersList = document.querySelector("#all-players-list");
const chatFeed = document.querySelector("#chat-feed");
const cardUrl = document.querySelector("#card-url");
const actionResult = document.querySelector("#action-result");
const connection = document.querySelector("#connection");
const connectionLabel = document.querySelector("#connection-label");
const micToggle = document.querySelector("#mic-toggle");
const toggleState = document.querySelector("#toggle-state");
const micDot = document.querySelector("#mic-dot");
const vuNeedle = document.querySelector("#vu-needle");
const heardStrip = document.querySelector(".heard-strip");
const voiceInterim = document.querySelector("#voice-interim");
const voiceHelp = document.querySelector("#voice-help");
const voiceRosterWarning = document.querySelector("#voice-roster-warning");
const tableStrip = document.querySelector("#table-strip");
const hostPlays = document.querySelector("#host-plays");
const accuseLog = document.querySelector("#accuse-log");
const botPreview = document.querySelector("#bot-preview-text");
const actionButtons = [...document.querySelectorAll(".stamp-button[data-action]")];
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const hostParams = new URLSearchParams(location.search);
const mockMode = hostParams.get("mock") === "round";

let state = null;
let stateReceivedAt = Date.now();
let reconnectDelay = 1_000;
let hostSocket = null;
let recognition = null;
let micEnabled = false;
let restartTimer = null;
let micStream = null;
let meterContext = null;
let analyser = null;
let meterData = null;
let meterFrame = null;
let smoothedLevel = 0;
let effectContext = null;
let previousHints = { category: undefined, letter: undefined };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function fitStage() {
  const scale = Math.min(window.innerWidth / 1440, window.innerHeight / 900);
  stage.style.transform = `scale(${scale})`;
  stage.style.left = `${Math.max(0, (window.innerWidth - 1440 * scale) / 2)}px`;
  stage.style.top = `${Math.max(0, (window.innerHeight - 900 * scale) / 2)}px`;
}

function avatar(player) {
  const wrap = node("span", "avatar");
  if (player.avatar) {
    const image = node("img");
    image.src = player.avatar;
    image.alt = "";
    wrap.append(image);
  } else {
    wrap.textContent = (player.displayName || player.login || "??").slice(0, 2).toUpperCase();
  }
  return wrap;
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function remainingMs() {
  if (!state) return 0;
  if (Number.isFinite(state.remainingMs)) {
    return Math.max(0, state.remainingMs - (Date.now() - stateReceivedAt));
  }
  return Math.max(0, (state.phaseEndsAt || Date.now()) - Date.now());
}

function flipHint(card, value, previous) {
  if (previous !== undefined && previous !== value) {
    card.animate([
      { transform: `${getComputedStyle(card).transform} rotateX(0deg)` },
      { transform: `${getComputedStyle(card).transform} rotateX(88deg)`, offset: .48 },
      { transform: `${getComputedStyle(card).transform} rotateX(0deg)` },
    ], { duration: 650, easing: "cubic-bezier(.3,.8,.25,1)" });
  }
}

function renderHints(nextState) {
  const next = {
    category: nextState.round?.hints?.category || "🔒",
    letter: nextState.round?.hints?.letter || "🔒",
  };
  flipHint(categoryCard, next.category, previousHints.category);
  flipHint(letterCard, next.letter, previousHints.letter);
  categoryHint.textContent = next.category;
  letterHint.textContent = next.letter;
  previousHints = next;
}

function renderPlayers(nextState) {
  const visible = nextState.players.slice(0, 8);
  players.classList.toggle("compact", visible.length > 4);
  const rows = visible.map((player, index) => {
    const row = node("article", "player");
    const pin = node("span", "player-pin");
    const count = nextState.round?.messageCounts?.[player.id] ?? player.messageCount ?? 0;
    pin.style.background = ["#a88542", "#4c5057", "#8b3b34", "#566678"][index % 4];
    row.append(
      pin,
      avatar(player),
      node("b", "stable-number", String(player.number || index + 1)),
      node("span", "player-name", player.login),
      node("span", "message-badge", String(count)),
    );
    if (player.claimed) row.append(node("span", "claim-lock", "🔒"));
    return row;
  });
  players.replaceChildren(...rows);
  playerTotal.textContent = String(nextState.players.length);
  playerOverflow.textContent = nextState.players.length > visible.length
    ? `+${nextState.players.length - visible.length}` : "";
  const hasOverflow = nextState.players.length > visible.length;
  seeAllPlayers.hidden = !hasOverflow;
  if (!hasOverflow) {
    allPlayersPanel.hidden = true;
    seeAllPlayers.setAttribute("aria-expanded", "false");
    seeAllPlayers.textContent = "see all";
  }
  allPlayersList.replaceChildren(...nextState.players.map((player) => {
    const row = node("div", "full-player-row");
    const count = nextState.round?.messageCounts?.[player.id] ?? player.messageCount ?? 0;
    row.append(
      node("span", "", `#${player.number || "?"} @${player.login}`),
      node("span", "full-player-count", String(count)),
      node("span", "", player.claimed ? "🔒" : ""),
    );
    return row;
  }));
}

function nextBotMessage(nextState) {
  if (nextState.phase === "IDLE") return "Start opens the lobby and posts the card link.";
  if (nextState.phase === "LOBBY") return `🔔 ROUND ${(nextState.roundNumber || 0) + 1} · NEW ROLES! Check your card.`;
  if (nextState.phase === "ROUND") {
    if (!nextState.round?.hints?.category) return "🕵️ HINT: the word topic is revealed next.";
    if (!nextState.round?.hints?.letter) return "🕵️ HINT: the first letter is revealed next.";
    return "🗳️ VOTE NOW! Type a player's number in chat.";
  }
  if (nextState.phase === "VOTE") return "⏳ 10 seconds left to vote.";
  return "🕵️ The round reveal posts next.";
}

function renderChat(nextState) {
  const messages = nextState.round?.recentMessages
    || nextState.round?.latestMessages
    || [];
  if (!messages.length) {
    chatFeed.replaceChildren(node("p", "chat-empty", "Player messages will appear here."));
    return;
  }
  chatFeed.replaceChildren(...messages.slice(-6).map((message) => {
    const line = node("p", `chat-line${message.source === "voice" ? " voice" : ""}`);
    const name = node("strong", "", `${message.player?.login || "unknown"}: `);
    line.append(name, document.createTextNode(
      `${message.source === "voice" ? "🎙 " : ""}${message.text}`,
    ));
    return line;
  }));
}

function renderConnection(nextState) {
  const online = Boolean(nextState.twitchConnected);
  connection.classList.toggle("online", online);
  connection.classList.toggle("offline", !online);
  connectionLabel.textContent = online ? "LIVE ON TWITCH" : "OFFLINE";
}

function renderTables(nextState) {
  const tables = nextState.tables || [];
  if (!tables.length) {
    tableStrip.replaceChildren(node("span", "tables-empty", "Tables appear when a round begins."));
  } else {
    tableStrip.replaceChildren(...tables.map((table) => {
      const item = node("button", `table-chip${table.id === nextState.featuredTableId ? " featured" : ""}`);
      item.type = "button";
      item.disabled = table.id === nextState.featuredTableId;
      item.append(
        node("strong", "", `T${table.id}`),
        node("span", "", String(table.playerCount)),
        node("small", "", table.id === nextState.featuredTableId ? "ON AIR" : "FEATURE"),
      );
      item.addEventListener("click", () => runAction(`feature/${table.id}`, `Feature table ${table.id}`, item));
      return item;
    }));
  }
  hostPlays.checked = nextState.hostPlays !== false;

  const entries = nextState.accusations || [];
  accuseLog.replaceChildren(node("strong", "", "BUSTED / ACCUSE LOG"));
  if (!entries.length) accuseLog.append(node("span", "log-empty", "No accusations yet."));
  entries.slice(0, 4).forEach((entry) => {
    accuseLog.append(node(
      "span",
      entry.correct ? "log-hit" : "log-miss",
      entry.correct
        ? `✓ @${entry.accuser.login} busted @${entry.target?.login || "suspect"}`
        : `× @${entry.accuser.login} guessed wrong`,
    ));
  });
}

function updateActions() {
  if (!state) return;
  const phase = state.phase;
  const enabled = {
    start: phase === "IDLE",
    go: phase === "LOBBY" && state.claimedCount >= 3,
    vote: phase === "ROUND",
    next: phase === "REVEAL",
    end: phase !== "IDLE",
    final: phase === "LOBBY" && Boolean(state.canFinal),
  };
  for (const button of actionButtons) {
    button.disabled = !enabled[button.dataset.action];
  }
}

function render(nextState) {
  state = nextState;
  stateReceivedAt = Date.now();
  const label = state.champion
    ? `CHAMPION · @${state.champion.login}`
    : state.phase === "ROUND"
    ? `ROUND ${state.roundNumber || state.round?.number || 1}`
    : state.phase;
  phaseLabel.textContent = label;
  renderHints(state);
  renderPlayers(state);
  renderChat(state);
  renderConnection(state);
  renderTables(state);
  botPreview.textContent = nextBotMessage(state);
  cardUrl.textContent = state.cardUrl || "";
  cardUrl.href = state.cardUrl || "#";
  const broadcaster = state.players.find((player) => (
    player.login === state.channelLogin && player.claimed
  ));
  const joined = state.players.some((player) => player.login === state.channelLogin);
  voiceRosterWarning.hidden = Boolean(broadcaster) || !state.channelLogin || state.hostPlays === false;
  voiceRosterWarning.textContent = joined
    ? "You joined. Claim your card to be in the round."
    : "You are not in the game yet: type !join and claim your card";
  updateActions();
  updateTimer();
}

function updateTimer() {
  if (!state || !["LOBBY", "ROUND", "VOTE", "REVEAL"].includes(state.phase)) {
    timer.textContent = "--:--";
    timerHand.style.transform = "rotate(0deg)";
    return;
  }
  const remaining = remainingMs();
  const duration = Math.max(1, Number(state.phaseDurationMs) || remaining || 1);
  const elapsedFraction = Math.min(1, Math.max(0, 1 - remaining / duration));
  timer.textContent = formatTime(remaining);
  timerHand.style.transform = `rotate(${elapsedFraction * 360}deg)`;
}

function playThunk() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  effectContext ??= new AudioContext();
  const now = effectContext.currentTime;
  const oscillator = effectContext.createOscillator();
  const gain = effectContext.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(105, now);
  oscillator.frequency.exponentialRampToValueAtTime(42, now + .11);
  gain.gain.setValueAtTime(.0001, now);
  gain.gain.exponentialRampToValueAtTime(.2, now + .008);
  gain.gain.exponentialRampToValueAtTime(.0001, now + .14);
  oscillator.connect(gain).connect(effectContext.destination);
  oscillator.start(now);
  oscillator.stop(now + .15);
}

async function runAction(action, label, button) {
  // Mock mode is for screenshots only: buttons look live but do nothing.
  if (mockMode) return;
  button.disabled = true;
  actionResult.textContent = "Working…";
  actionResult.classList.remove("error");
  try {
    const response = await fetch(`/api/host/${action}`, { method: "POST" });
    const result = await response.json();
    actionResult.textContent = result.ok
      ? `${label} complete.`
      : `Could not ${label.toLowerCase()}: ${String(result.reason || "unknown error").replaceAll("_", " ")}.`;
    actionResult.classList.toggle("error", !result.ok);
  } catch {
    actionResult.textContent = "The server did not respond.";
    actionResult.classList.add("error");
  } finally {
    if (button.id === "reset") button.disabled = false;
    updateActions();
    setTimeout(() => {
      if (actionResult.textContent !== "Working…") actionResult.textContent = "";
    }, 2_600);
  }
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?view=host`);
  hostSocket = socket;
  socket.addEventListener("open", () => {
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
    connection.classList.remove("online");
    connectionLabel.textContent = "RECONNECTING";
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.7);
  });
}

function setMicState(label, className = "", interim = false) {
  voiceInterim.textContent = label;
  heardStrip.classList.toggle("interim", interim);
  micDot.className = `mic-dot ${className}`.trim();
}

function sendVoice(text) {
  if (hostSocket?.readyState !== WebSocket.OPEN) {
    voiceHelp.textContent = "Voice not sent: the host connection is offline.";
    return;
  }
  hostSocket.send(JSON.stringify({ type: "voice", text }));
  setMicState(`“${text}”`, "listening");
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

function drawMeter() {
  if (!micEnabled || !analyser || !meterData) return;
  analyser.getByteTimeDomainData(meterData);
  let sum = 0;
  for (const sample of meterData) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / meterData.length);
  const level = Math.min(1, rms * 7);
  smoothedLevel = smoothedLevel * .82 + level * .18;
  vuNeedle.style.transform = `rotate(${-20 + smoothedLevel * 55}deg)`;
  meterFrame = requestAnimationFrame(drawMeter);
}

async function startAudioMeter() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  meterContext = new AudioContext();
  analyser = meterContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = .72;
  meterData = new Uint8Array(analyser.fftSize);
  meterContext.createMediaStreamSource(micStream).connect(analyser);
  drawMeter();
}

function stopAudioMeter() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  meterContext?.close();
  meterContext = null;
  analyser = null;
  meterData = null;
  smoothedLevel = 0;
  vuNeedle.style.transform = "rotate(-20deg)";
}

function disableMic(message = "Mic is off.") {
  micEnabled = false;
  clearTimeout(restartTimer);
  restartTimer = null;
  micToggle.classList.remove("active");
  micToggle.setAttribute("aria-pressed", "false");
  micToggle.setAttribute("aria-label", "Turn streamer microphone on");
  toggleState.textContent = "OFF";
  recognition?.stop();
  stopAudioMeter();
  setMicState(message);
}

async function enableMic() {
  micEnabled = true;
  micToggle.classList.add("active");
  micToggle.setAttribute("aria-pressed", "true");
  micToggle.setAttribute("aria-label", "Turn streamer microphone off");
  toggleState.textContent = "ON";
  voiceHelp.textContent = "";
  setMicState("Listening…", "listening", true);
  try {
    await startAudioMeter();
    startRecognition();
  } catch {
    voiceHelp.textContent = "Microphone permission is required.";
    disableMic("Mic permission blocked.");
  }
}

function setupVoice() {
  if (!SpeechRecognition || !navigator.mediaDevices?.getUserMedia) {
    micToggle.disabled = true;
    voiceHelp.textContent = "Voice needs Google Chrome";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onstart = () => setMicState("Listening…", "listening", true);
  recognition.onspeechstart = () => { micDot.className = "mic-dot speaking"; };
  recognition.onspeechend = () => { micDot.className = "mic-dot listening"; };
  recognition.onresult = (event) => {
    const interim = [];
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript.trim();
      if (!text) continue;
      if (event.results[index].isFinal) sendVoice(text);
      else interim.push(text);
    }
    if (interim.length) setMicState(interim.join(" "), "speaking", true);
  };
  recognition.onerror = (event) => {
    if (event.error === "network" && micEnabled) {
      setMicState("Network interrupted. Retrying…", "error", true);
      recognition.abort();
      scheduleRecognitionRestart();
      return;
    }
    if (["not-allowed", "service-not-allowed"].includes(event.error)) {
      voiceHelp.textContent = "Microphone permission is required.";
      disableMic("Mic permission blocked.");
      return;
    }
    if (event.error === "no-speech") {
      setMicState("Listening…", "listening", true);
      return;
    }
    setMicState(`Mic error: ${event.error}`, "error", true);
  };
  recognition.onend = () => {
    if (micEnabled) scheduleRecognitionRestart();
  };
}

function mockAvatar(initials, background) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="${background}"/><circle cx="80" cy="48" r="27" fill="#efbf94"/><path d="M42 116c4-32 20-47 38-47s34 15 38 47" fill="#3d3048"/><text x="80" y="54" text-anchor="middle" font-size="18" font-family="sans-serif" fill="#34251f">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function mockState() {
  const count = Math.min(60, Math.max(4, Number(hostParams.get("players")) || 4));
  const featured = [
    ["pixel_mara", "PM", "#8062a8"],
    ["tomtom_irl", "TT", "#62a87c"],
    ["quietfox", "QF", "#d67842"],
    ["streamer", "ST", "#5287ae"],
  ];
  const demoPlayers = Array.from({ length: count }, (_, index) => {
    const login = featured[index]?.[0] || `detective_${String(index + 1).padStart(2, "0")}`;
    return {
      id: `p${index + 1}`,
      login,
      displayName: login,
      avatar: mockAvatar(featured[index]?.[1] || `D${(index + 1) % 10}`, featured[index]?.[2] || `hsl(${index * 43 % 360} 42% 55%)`),
      claimed: index % 6 !== 5,
      number: index + 1,
    };
  });
  const messages = [
    [demoPlayers[0], "The kitchen light just flickered again", "chat"],
    [demoPlayers[1], "I am making tea between rounds", "chat"],
    [demoPlayers[2], "That category hint helps a lot", "chat"],
    [demoPlayers[3], "The rain is kind of relaxing tonight", "voice"],
    [demoPlayers[0], "Okay now I suspect everybody", "chat"],
    [demoPlayers[1], "This is getting intense", "chat"],
  ].map(([player, text, source], index) => ({ id: `m${index}`, player, text, source }));
  const tableCount = Math.min(20, Math.max(1, Number(hostParams.get("tables")) || 1));
  return {
    state: "ROUND",
    phase: "ROUND",
    roundNumber: 2,
    claimedCount: demoPlayers.filter(({ claimed }) => claimed).length,
    players: demoPlayers,
    phaseEndsAt: Date.now() + 108_000,
    phaseDurationMs: 180_000,
    remainingMs: 108_000,
    cardUrl: `${location.origin}/card`,
    channelLogin: "streamer",
    twitchConnected: true,
    hostPlays: true,
    canFinal: false,
    featuredTableId: 1,
    tables: Array.from({ length: tableCount }, (_, index) => ({ id: index + 1, playerCount: 9 + (index % 4) })),
    accusations: [
      { correct: true, accuser: demoPlayers[2], target: demoPlayers[0] },
      { correct: false, accuser: demoPlayers[1], target: null },
    ],
    round: {
      number: 2,
      hints: { category: "home", letter: null },
      players: demoPlayers,
      messageCounts: Object.fromEntries(demoPlayers.map((player, index) => [player.id, (index * 7 + 3) % 19])),
      latestMessages: messages.slice(-3),
      recentMessages: messages,
    },
  };
}

for (const button of actionButtons) {
  button.addEventListener("click", () => {
    playThunk();
    button.animate(
      [{ transform: "translateY(0)" }, { transform: "translateY(8px)" }, { transform: "translateY(0)" }],
      { duration: 190, easing: "ease-out" },
    );
    runAction(button.dataset.action, button.textContent.trim().replace(/\s+/g, " "), button);
  });
}

document.querySelector("#reset").addEventListener("click", (event) => {
  if (!window.confirm("Reset the game and remove every player?")) return;
  playThunk();
  runAction("reset", "Reset", event.currentTarget);
});

document.querySelector("#copy-card").addEventListener("click", async (event) => {
  if (!state?.cardUrl) return;
  await navigator.clipboard.writeText(state.cardUrl);
  event.currentTarget.textContent = "✓";
  setTimeout(() => { event.currentTarget.textContent = "▣"; }, 1_400);
});

hostPlays.addEventListener("change", async () => {
  if (mockMode) return;
  hostPlays.disabled = true;
  try {
    const response = await fetch("/api/host/host-plays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: hostPlays.checked }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.reason || "not accepted");
  } catch (error) {
    hostPlays.checked = !hostPlays.checked;
    actionResult.textContent = `Host plays: ${error.message}`;
    actionResult.classList.add("error");
  } finally {
    hostPlays.disabled = false;
  }
});

seeAllPlayers.addEventListener("click", () => {
  const opening = allPlayersPanel.hidden;
  allPlayersPanel.hidden = !opening;
  seeAllPlayers.setAttribute("aria-expanded", String(opening));
  seeAllPlayers.textContent = opening ? "close list" : "see all";
});

micToggle.addEventListener("click", () => {
  if (micEnabled) disableMic();
  else enableMic();
});

window.addEventListener("resize", fitStage);
setInterval(updateTimer, 250);
fitStage();

if (mockMode) {
  micToggle.disabled = true;
  setMicState("“the rain is kind of relaxing tonight”");
  render(mockState());
} else {
  setupVoice();
  connect();
}
