const root = document.querySelector("#card-root");
const connection = document.querySelector("#connection");
let state = { linked: false, role: null };
let receivedAt = Date.now();
let reconnectDelay = 1_000;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function paper(title, eyebrow) {
  const section = node("section", "case-paper");
  if (eyebrow) section.append(node("p", "eyebrow", eyebrow));
  section.append(node("h1", "case-title", title));
  return section;
}

function avatar(player) {
  const wrap = node("div", "identity");
  const card = node("div", "mini-polaroid");
  const photo = node("div", "mini-polaroid-photo");
  if (player?.avatar) {
    const image = node("img");
    image.src = player.avatar;
    image.alt = "";
    photo.append(image);
  } else {
    photo.textContent = (player?.displayName || player?.login || "?").slice(0, 2).toUpperCase();
  }
  card.append(photo, node("div", "mini-polaroid-name", `@${player?.login || "unknown"}`));
  wrap.append(card);
  return wrap;
}

function renderLogin(message = "") {
  const section = paper("GET YOUR CASE FILE", "PRIVATE PLAYER CARD");
  section.append(node("p", "body-copy", "Enter the Twitch name you will use in chat. No Twitch login needed."));
  const form = node("form", "claim-form");
  const label = node("label", "", "TWITCH NAME");
  const input = node("input");
  input.name = "login";
  input.autocomplete = "username";
  input.placeholder = "your_name";
  input.required = true;
  input.pattern = "[A-Za-z0-9_]{1,25}";
  label.append(input);
  const submit = node("button", "primary", "GET CLAIM CODE");
  submit.type = "submit";
  form.append(label, submit);
  if (message) form.append(node("div", "error", message));
  form.addEventListener("submit", startClaim);
  section.append(form);
  root.replaceChildren(section);
}

function renderClaim(claim) {
  const section = paper("LINK THIS CARD", `FOR @${claim.login}`);
  section.append(node("p", "body-copy", "Type this exact command in the Twitch chat:"));
  const code = node("div", "claim-code", `!claim ${claim.code}`);
  const copy = node("button", "copy-button", "COPY COMMAND");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`!claim ${claim.code}`);
      copy.textContent = "COPIED ✓";
      copy.classList.add("copied");
    } catch {
      copy.textContent = `COPY: !claim ${claim.code}`;
    }
  });
  const expiry = node("p", "claim-expiry");
  expiry.dataset.expiresAt = String(claim.expiresAt);
  section.append(code, copy, expiry, node("p", "body-copy", "Keep this page open. Your role appears here as soon as the name matches."));
  root.replaceChildren(section);
  updateTimers();
}

function renderWaiting() {
  const section = paper("CARD LINKED", `@${state.player?.login || "PLAYER"}`);
  section.append(avatar(state.player));
  const message = state.joined === false
    ? "You left the roster. Type !join in chat to rejoin the next case."
    : state.state === "LOBBY"
      ? "You’re in. The next case is assembling."
      : "The case file is sealed. Waiting for the next round.";
  section.append(node("p", "body-copy", message));
  const dots = node("div", "waiting-dots");
  dots.append(node("i"), node("i"), node("i"));
  section.append(dots);
  root.replaceChildren(section);
}

function renderImposter() {
  const section = paper("YOU ARE THE IMPOSTER", `ROUND ${state.roundNumber}`);
  section.prepend(node("div", "secret-stamp", "TOP SECRET"));
  section.append(avatar(state.player));
  const slip = node("div", "word-slip");
  slip.append(node("strong", "", state.word));
  section.append(slip, node("p", "mission", state.mission));
  const timer = node("time", "role-timer");
  timer.dataset.timer = "phase";
  section.append(timer);
  section.append(node("p", `delivery${state.delivered ? " done" : ""}`, state.delivered ? "✓ Delivered" : "Not delivered yet"));
  root.replaceChildren(section);
  updateTimers();
}

function renderDetective() {
  const section = paper("YOU ARE A DETECTIVE", `ROUND ${state.roundNumber}`);
  section.append(avatar(state.player), node("div", "detective-badge", "⌕"));
  section.append(node("p", "mission", "Someone is hiding a word. Watch the chat, trust your instincts, and vote when the case opens."));
  const timer = node("time", "role-timer");
  timer.dataset.timer = "phase";
  section.append(timer);
  root.replaceChildren(section);
  updateTimers();
}

function render(nextState) {
  state = nextState;
  receivedAt = Date.now();
  if (!state.linked) {
    if (state.pendingClaim) renderClaim(state.pendingClaim);
    else renderLogin();
  } else if (state.role === "IMPOSTER") {
    renderImposter();
  } else if (state.role === "DETECTIVE") {
    renderDetective();
  } else {
    renderWaiting();
  }
}

async function startClaim(event) {
  event.preventDefault();
  const submit = event.currentTarget.querySelector("button");
  submit.disabled = true;
  submit.textContent = "MAKING CODE…";
  const login = new FormData(event.currentTarget).get("login");
  try {
    const response = await fetch("/api/card/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.reason === "invalid_login" ? "Use a valid Twitch name." : "Could not make a code. Try again.");
    render({ linked: false, role: null, pendingClaim: result });
  } catch (error) {
    renderLogin(error.message);
  }
}

function remainingMs() {
  if (Number.isFinite(state.remainingMs)) {
    return Math.max(0, state.remainingMs - (Date.now() - receivedAt));
  }
  return Math.max(0, (state.phaseEndsAt || Date.now()) - Date.now());
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
}

function updateTimers() {
  const timer = document.querySelector("[data-timer='phase']");
  if (timer) timer.textContent = state.state === "ROUND" ? `◷ ${formatTime(remainingMs())}` : state.state;
  const expiry = document.querySelector("[data-expires-at]");
  if (expiry) expiry.textContent = `Code expires in ${formatTime(Number(expiry.dataset.expiresAt) - Date.now())}`;
}

async function loadCard() {
  const response = await fetch("/api/card");
  render(await response.json());
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?view=card`);
  socket.addEventListener("open", () => {
    connection.textContent = "LIVE";
    connection.classList.add("online");
    reconnectDelay = 1_000;
  });
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "card") render(payload.data);
  });
  socket.addEventListener("close", () => {
    connection.textContent = "RECONNECTING";
    connection.classList.remove("online");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.7);
  });
}

setInterval(updateTimers, 500);
loadCard().finally(connect);
