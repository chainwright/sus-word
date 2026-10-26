const root = document.querySelector("#card-root");
const connection = document.querySelector("#connection");
let state = { linked: false, role: null };
let receivedAt = Date.now();
let reconnectDelay = 1_000;
let cardSocket = null;

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

function miniMate(player) {
  const card = node("article", "table-mate");
  const photo = node("div", "table-mate-photo");
  if (player?.avatar) {
    const image = node("img");
    image.src = player.avatar;
    image.alt = "";
    photo.append(image);
  } else {
    photo.textContent = (player?.displayName || player?.login || "?").slice(0, 2).toUpperCase();
  }
  card.append(photo, node("strong", "", `@${player?.login || "unknown"}`));
  return card;
}

function sendCardAction(payload) {
  if (cardSocket?.readyState !== WebSocket.OPEN) return false;
  cardSocket.send(JSON.stringify(payload));
  return true;
}

function playerSelect(className = "") {
  const select = node("select", className);
  const placeholder = node("option", "", "Pick a table-mate");
  placeholder.value = "";
  select.append(placeholder);
  for (const mate of state.tableMates || []) {
    if (mate.id === state.player?.id) continue;
    const option = node("option", "", `@${mate.login}`);
    option.value = mate.login;
    if (state.voteTargetId === mate.id) option.selected = true;
    select.append(option);
  }
  return select;
}

// The card re-renders on every state push; keep the chat draft and focus so typing is never wiped.
let chatDraft = "";
let chatFocused = false;

function appendTableTools(section) {
  section.classList.add("table-case");
  const status = node("section", `table-status ${state.onStream ? "featured" : "side"}`);
  status.append(
    node("strong", "", `TABLE ${state.tableId} OF ${state.tableCount}`),
    node("span", "", state.onStream ? "ON STREAM · talk in Twitch chat" : "SIDE TABLE · talk here"),
  );
  section.prepend(status);

  const hints = node("section", "card-hints");
  hints.append(
    node("div", "", `CATEGORY\n${state.hints?.category || "🔒"}`),
    node("div", "", `STARTS WITH\n${state.hints?.letter || "🔒"}`),
  );
  section.append(hints);

  const mates = node("section", "table-mates");
  mates.append(node("h2", "panel-title", "YOUR TABLE"));
  const mateGrid = node("div", "table-mate-grid");
  mateGrid.append(...(state.tableMates || []).map(miniMate));
  mates.append(mateGrid);
  section.append(mates);

  const chat = node("section", "table-chat-panel");
  chat.append(node("h2", "panel-title", "TABLE CHAT"));
  const log = node("div", "table-chat-log");
  const messages = (state.messages || []).slice(-20);
  if (!messages.length) log.append(node("p", "chat-empty", "No evidence yet."));
  for (const message of messages) {
    const line = node("p", message.source === "voice" ? "voice-line" : "");
    line.append(
      node("strong", "", `@${message.player?.login || "unknown"}: `),
      document.createTextNode(`${message.source === "voice" ? "🎙 " : ""}${message.text}`),
    );
    log.append(line);
  }
  chat.append(log);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  if (state.onStream) {
    chat.append(node("p", "chat-locked", "🔒 This table is on stream. Talk in Twitch chat."));
  } else if (state.state === "ROUND") {
    const form = node("form", "table-chat-form");
    const input = node("input");
    input.maxLength = 200;
    input.placeholder = "Message your table…";
    input.autocomplete = "off";
    input.value = chatDraft;
    input.addEventListener("input", () => { chatDraft = input.value; });
    input.addEventListener("focus", () => { chatFocused = true; });
    input.addEventListener("blur", () => { chatFocused = false; });
    if (chatFocused) requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
    const send = node("button", "small-action", "SEND");
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || !sendCardAction({ type: "tableChat", text })) return;
      input.value = "";
      chatDraft = "";
    });
    chat.append(form);
  }
  // On a side table the chat is the game: right after your role and word, above hints and table-mates.
  if (state.onStream) section.append(chat);
  else hints.before(chat);

  if (state.state === "ROUND") {
    const accuse = node("form", "case-action-panel accuse-panel");
    accuse.append(node("h2", "panel-title", "ONE ACCUSATION"));
    const target = playerSelect();
    const word = node("input");
    word.placeholder = "Secret word";
    word.maxLength = 20;
    const button = node("button", "small-action ink-red", state.accusationUsed ? "SHOT USED" : "ACCUSE");
    button.type = "submit";
    button.disabled = state.accusationUsed;
    accuse.append(target, word, button);
    accuse.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!target.value || !word.value.trim()) return;
      if (state.onStream) navigator.clipboard?.writeText(`!accuse ${target.value} ${word.value.trim()}`);
      else sendCardAction({ type: "accuse", target: target.value, word: word.value.trim() });
    });
    if (state.onStream && !state.accusationUsed) accuse.append(node("small", "", "Tap ACCUSE to copy the Twitch command."));
    section.append(accuse);
  }

  if (state.state === "VOTE") {
    const vote = node("form", "case-action-panel vote-panel");
    vote.append(node("h2", "panel-title", "WHO IS SUS?"));
    const target = playerSelect();
    const button = node("button", "small-action ink-navy", state.voteTargetId ? "CHANGE VOTE" : "VOTE");
    button.type = "submit";
    vote.append(target, button);
    vote.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!target.value) return;
      if (state.onStream) navigator.clipboard?.writeText(`!vote ${target.value}`);
      else sendCardAction({ type: "vote", target: target.value });
    });
    if (state.onStream) vote.append(node("small", "", "Tap VOTE to copy the Twitch command."));
    section.append(vote);
  }

  if (state.state === "REVEAL" && state.result) {
    const mine = state.result.imposters?.find(({ impostor }) => impostor.id === state.player.id);
    const result = node("section", "card-result");
    result.append(node("h2", "panel-title", "TABLE RESULT"));
    result.append(node("strong", "result-stamp", mine ? mine.verdict : `+${state.roundPoints || 0} POINTS`));
    result.append(node("p", "", mine ? mine.caption : "The case is closed. Check the table results."));
    section.append(result);
  }

  section.append(node("p", "card-action-feedback", ""));
}

function renderLogin(message = "") {
  const section = paper("YOUR TWITCH NAME", "PRIVATE PLAYER CARD");
  section.append(node("p", "body-copy", "Enter the Twitch name you will use in chat. No Twitch login needed."));
  const form = node("form", "claim-form");
  const label = node("label", "", "Your Twitch name");
  const input = node("input");
  input.name = "login";
  input.autocomplete = "username";
  input.placeholder = "your_name";
  input.required = true;
  input.pattern = "[A-Za-z0-9_]{1,25}";
  label.append(input);
  const submit = node("button", "primary", "GET MY CLAIM CODE");
  submit.type = "submit";
  form.append(label, submit);
  if (message) form.append(node("div", "error", message));
  form.addEventListener("submit", startClaim);
  section.append(form);
  root.replaceChildren(section);
}

function renderClaim(claim) {
  const section = paper("LINK THIS CARD", `FOR @${claim.login}`);
  section.append(node("p", "claim-command", `Type !claim ${claim.code} in chat`));
  const code = node("div", "claim-code", claim.code);
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
  const section = paper("YOUR ASSIGNMENT", `ROUND ${state.roundNumber}`);
  const stamp = node("div", "role-stamp imposter-role-stamp", "IMPOSTER");
  section.prepend(stamp);
  section.append(avatar(state.player));
  const slip = node("div", "word-slip");
  slip.append(node("strong", "", state.word));
  section.append(slip, node("p", "mission", state.mission));
  const timer = node("time", "role-timer");
  timer.dataset.timer = "phase";
  section.append(timer);
  section.append(node("p", `delivery${state.delivered ? " done" : ""}`, state.delivered ? "✓ Delivered" : "Not delivered yet"));
  appendTableTools(section);
  root.replaceChildren(section);
  stamp.animate(
    [{ transform: "rotate(-7deg) scale(1.65)", opacity: 0 }, { transform: "rotate(-7deg) scale(1)", opacity: 1 }],
    { duration: 380, easing: "cubic-bezier(.2,.9,.2,1.2)", fill: "both" },
  );
  updateTimers();
}

function renderDetective() {
  const section = paper("CASE BRIEFING", `ROUND ${state.roundNumber}`);
  const stamp = node("div", "role-stamp detective-role-stamp", "DETECTIVE");
  section.prepend(stamp);
  section.append(avatar(state.player), node("div", "detective-badge", "🔎"));
  section.append(node("p", "mission", "Someone in chat is hiding a word. Watch closely."));
  const timer = node("time", "role-timer");
  timer.dataset.timer = "phase";
  section.append(timer);
  appendTableTools(section);
  root.replaceChildren(section);
  stamp.animate(
    [{ transform: "rotate(-5deg) scale(1.5)", opacity: 0 }, { transform: "rotate(-5deg) scale(1)", opacity: 1 }],
    { duration: 360, easing: "cubic-bezier(.2,.9,.2,1.2)", fill: "both" },
  );
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
  if (expiry) expiry.textContent = `Code valid: ${formatTime(Number(expiry.dataset.expiresAt) - Date.now())}`;
}

async function loadCard() {
  const response = await fetch("/api/card");
  render(await response.json());
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?view=card`);
  cardSocket = socket;
  socket.addEventListener("open", () => {
    connection.textContent = "LIVE";
    connection.classList.add("online");
    reconnectDelay = 1_000;
  });
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "card") render(payload.data);
    if (payload.type === "actionResult") {
      const feedback = document.querySelector(".card-action-feedback");
      if (feedback) {
        feedback.textContent = payload.data?.ok
          ? (payload.action === "accuse" && payload.data.correct ? "BUSTED ✓" : "Sent ✓")
          : String(payload.data?.reason || "not accepted").replaceAll("_", " ");
        feedback.classList.toggle("error", !payload.data?.ok);
      }
    }
  });
  socket.addEventListener("close", () => {
    if (cardSocket === socket) cardSocket = null;
    connection.textContent = "RECONNECTING";
    connection.classList.remove("online");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15_000, reconnectDelay * 1.7);
  });
}

function mockAvatar() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#8261a8"/><circle cx="80" cy="68" r="41" fill="#efbd91"/><path d="M37 67c4-39 21-54 44-54 29 0 44 26 39 60-13-18-27-27-41-28-12 12-24 20-42 22Z" fill="#302239"/><path d="M23 160c7-43 27-62 57-62s50 19 57 62" fill="#443650"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function mockCard(kind) {
  const player = { id: "p1", login: "pixel_mara", displayName: "pixel_mara", avatar: mockAvatar(), claimed: true };
  if (kind === "claim") {
    return { linked: false, role: null, pendingClaim: { login: "pixel_mara", code: "M7K2", expiresAt: Date.now() + 570_000 } };
  }
  const tableMates = [player, ...["tomtom_irl", "quietfox", "streamer"].map((login, index) => ({ id: `p${index + 2}`, login, displayName: login, avatar: "", claimed: true }))];
  const side = kind === "side";
  const featured = kind === "featured";
  return {
    linked: true,
    joined: true,
    state: "ROUND",
    roundNumber: 2,
    player,
    role: kind === "imposter" || side ? "IMPOSTER" : "DETECTIVE",
    word: kind === "imposter" || side ? "candle" : undefined,
    mission: "Get this word into chat naturally in a real sentence before time runs out.",
    delivered: false,
    remainingMs: 133_000,
    phaseEndsAt: Date.now() + 133_000,
    tableId: side ? 2 : 1,
    tableCount: side || featured ? 3 : 1,
    featuredTableId: 1,
    onStream: !side,
    chatLocked: !side,
    tableMates,
    hints: { category: "home", letter: side ? "c" : null },
    messages: [
      { id: "m1", player: tableMates[1], text: "the kitchen light flickered again", source: "chat" },
      { id: "m2", player: tableMates[2], text: "I suspect absolutely everyone", source: "chat" },
    ],
    canAccuse: true,
    canVote: false,
    accusationUsed: false,
  };
}

setInterval(updateTimers, 500);
const mock = new URLSearchParams(location.search).get("mock");
if (["claim", "imposter", "detective", "side", "featured"].includes(mock)) {
  connection.textContent = "PREVIEW";
  render(mockCard(mock));
} else {
  loadCard().finally(connect);
}
