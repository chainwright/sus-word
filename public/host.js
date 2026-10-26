const phase = document.querySelector("#phase");
const round = document.querySelector("#round");
const timer = document.querySelector("#timer");
const players = document.querySelector("#players");
const total = document.querySelector("#player-total");
const cardUrl = document.querySelector("#card-url");
const stateJson = document.querySelector("#state-json");
const actionResult = document.querySelector("#action-result");
const connection = document.querySelector("#connection");
let state = null;
let reconnectDelay = 1_000;

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
  socket.addEventListener("open", () => {
    connection.textContent = "LIVE";
    connection.classList.add("online");
    reconnectDelay = 1_000;
  });
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") render(payload.data);
  });
  socket.addEventListener("close", () => {
    connection.textContent = "RECONNECTING";
    connection.classList.remove("online");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.7);
  });
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

setInterval(updateTimer, 500);
connect();
