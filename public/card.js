import {
  cardRenderSignature,
  cardScreen,
  hiddenImpostorCount,
  impostorStatus,
  showRoleTips,
  vibrateIfActivated,
  voteProgress,
} from "./card-view.js";

const root = document.querySelector("#card-root");
const connection = document.querySelector("#connection");
const soundToggle = document.querySelector("#sound-toggle");
const signalBorder = document.querySelector("#signal-border");
const toast = document.querySelector("#toast");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let state = { linked: false, role: null };
let receivedAt = Date.now();
let reconnectDelay = 1_000;
let cardSocket = null;
let audioContext = null;
let wakeLock = null;
let signaledRound = null;
let nameCheckTimer = null;
let toastTimer = null;
let muted = localStorage.getItem("sus-word-muted") === "true";
let chatDraft = "";
let chatFocused = false;
let detailsOpen = false;
let accuseDraft = { target: "", word: "" };
let interactiveRound = null;
let lastRenderSignature = null;

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatClock(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function remainingMs() {
  if (Number.isFinite(state.remainingMs)) return Math.max(0, state.remainingMs - (Date.now() - receivedAt));
  return Math.max(0, (state.phaseEndsAt || Date.now()) - Date.now());
}

function playerPhoto(player, className = "player-photo") {
  const photo = node("div", className);
  if (player?.avatar) {
    const image = node("img");
    image.src = player.avatar;
    image.alt = `@${player.login || "player"}`;
    photo.append(image);
  } else {
    photo.textContent = (player?.displayName || player?.login || "?").slice(0, 2).toUpperCase();
  }
  return photo;
}

function topBar(label, timerKind = "phase") {
  const bar = node("header", "card-topbar");
  bar.append(node("strong", "card-phase", label));
  const tools = node("span", "card-top-tools");
  const timer = node("time", "card-timer");
  timer.dataset.timer = timerKind;
  timer.setAttribute("aria-live", "polite");
  tools.append(timer, soundToggle);
  bar.append(tools);
  return bar;
}

function paperSheet(className = "") {
  return node("section", `paper-sheet ${className}`.trim());
}

function tableLabel() {
  if ((state.tableCount || 1) <= 1) return null;
  const label = node("div", `table-label ${state.onStream ? "on-stream" : "side-table"}`);
  label.append(
    node("strong", "", `TABLE ${state.tableId || 1} OF ${state.tableCount || 1}`),
    node("span", "", state.onStream ? "ON STREAM · TALK IN TWITCH CHAT" : "SIDE TABLE · TALK HERE"),
  );
  return label;
}

function hintCards() {
  const hints = node("section", "role-hints");
  const category = node("div", "hint-card");
  category.append(node("small", "", "WORD TOPIC"), node("strong", "", state.hints?.category?.toUpperCase() || "🔒 AT 1:30"));
  const letter = node("div", "hint-card");
  letter.append(node("small", "", "FIRST LETTER"), node("strong", "", state.hints?.letter?.toUpperCase() || "🔒 AT 0:30"));
  hints.append(category, letter);
  return hints;
}

function showToast(message, error = true) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `show${error ? " error" : " success"}`;
  toastTimer = setTimeout(() => { toast.className = ""; }, 3_800);
}

function actionError(reason) {
  const messages = {
    self_vote: "You cannot vote for yourself.",
    unknown_target: "That player is not at your table.",
    not_seated: "You are not seated this round. You play next round.",
    featured_table_locked: "Talk in Twitch chat while your table is on stream.",
    rate_limited: "Slow down—try again in a moment.",
    vote_closed: "Voting is closed.",
    already_busted: "That player is already BUSTED. Vote for someone still hidden.",
    invalid_state: "That action is not open right now.",
    accusation_used: "Your one accusation is already used.",
  };
  return messages[reason] || String(reason || "That was not accepted.").replaceAll("_", " ");
}

function sendCardAction(payload) {
  if (cardSocket?.readyState !== WebSocket.OPEN) {
    showToast("Reconnecting—try again in a moment.");
    return false;
  }
  cardSocket.send(JSON.stringify(payload));
  return true;
}

async function checkName(login, status) {
  const normalized = String(login || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,25}$/.test(normalized)) {
    status.textContent = normalized ? "Use the exact Twitch login: letters, numbers, or _." : "Type your Twitch name to check it.";
    status.className = "name-check neutral";
    return null;
  }
  status.textContent = "Checking this chat…";
  status.className = "name-check neutral";
  try {
    const response = await fetch("/api/card/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: normalized }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error("check_failed");
    status.textContent = result.message;
    status.className = `name-check ${result.seen ? "seen" : "unseen"}`;
    return result;
  } catch {
    status.textContent = "Could not check chat yet. You can still get a code.";
    status.className = "name-check unseen";
    return null;
  }
}

function renderLogin(options = {}) {
  const page = node("div", "join-page");
  page.append(topBar("SUS WORD · JOIN", "lobby"));
  const sheet = paperSheet("join-sheet");
  sheet.append(node("p", "step-label", "STEP 1 OF 2"), node("h1", "join-title", "Your Twitch name"));
  sheet.append(node("p", "join-copy", "Type it exactly as it shows in chat. Not a nickname, not your real name."));
  const form = node("form", "join-form");
  const input = node("input");
  input.name = "login";
  input.autocomplete = "username";
  input.placeholder = "your_name";
  input.value = options.login || "";
  input.required = true;
  input.pattern = "[A-Za-z0-9_]{1,25}";
  input.setAttribute("aria-label", "Your Twitch name");
  const status = node("p", "name-check neutral", "Type your Twitch name to check it.");
  status.setAttribute("aria-live", "polite");
  if (options.nameCheck) {
    status.textContent = options.nameCheck.message;
    status.className = `name-check ${options.nameCheck.seen ? "seen" : "unseen"}`;
  }
  input.addEventListener("input", () => {
    clearTimeout(nameCheckTimer);
    nameCheckTimer = setTimeout(() => checkName(input.value, status), 350);
  });
  const submit = node("button", "primary-action", "GET MY CODE");
  submit.type = "submit";
  form.append(input, status, submit);
  if (options.message) form.append(node("p", "form-error", options.message));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await unlockAudio();
    requestWakeLock();
    submit.disabled = true;
    submit.textContent = "CHECKING NAME…";
    await checkName(input.value, status);
    submit.textContent = "MAKING CODE…";
    try {
      const response = await fetch("/api/card/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: input.value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.reason === "invalid_login" ? "Use a valid Twitch name." : "Could not make a code. Try again.");
      render({ linked: false, role: null, pendingClaim: result });
    } catch (error) {
      renderLogin({ login: input.value, message: error.message });
    }
  });
  sheet.append(form);
  page.append(sheet);
  root.replaceChildren(page);
  if (options.login && !options.nameCheck) checkName(options.login, status);
}

function renderClaim(claim) {
  claim = claim ?? {};
  const page = node("div", "join-page claim-page");
  page.append(topBar("SUS WORD · JOIN", "lobby"));
  const sheet = paperSheet("join-sheet");
  sheet.append(node("p", "step-label", "STEP 2 OF 2"), node("h1", "join-title", "Send this in chat"));
  const code = node("div", "claim-code", claim.code);
  const command = `!join ${claim.code}`;
  const copy = node("button", "copy-command", `COPY “${command}”`);
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = "COPIED ✓";
      copy.classList.add("copied");
    } catch {
      copy.textContent = command;
    }
  });
  const steps = node("ol", "claim-steps");
  steps.append(node("li", "", `Paste it in Twitch chat from @${claim.login}`), node("li", "", "Come back here. Your role appears when the round starts."));
  sheet.append(code, copy, steps);
  if (claim.error) sheet.append(node("p", "wrong-account", claim.error));
  const change = node("button", "change-name", "Change name");
  change.type = "button";
  change.addEventListener("click", () => renderLogin({ login: claim.login }));
  const note = node("div", "change-note");
  note.append(document.createTextNode("Wrong name? "), change, document.createTextNode(" A code from another account will not work."));
  const expiry = node("p", "claim-expiry");
  expiry.dataset.expiresAt = String(claim.expiresAt);
  sheet.append(note, expiry);
  page.append(sheet);
  root.replaceChildren(page);
  updateTimers();
}

function renderWaiting() {
  const page = node("div", "waiting-page");
  page.append(topBar("SUS WORD · READY", "lobby"));
  const sheet = paperSheet("waiting-sheet");
  sheet.append(node("p", "step-label", `@${state.player?.login || "player"}`), node("h1", "join-title", "You’re in."));
  const message = state.joined === false
    ? "You are not in the roster. Type !join and claim your card to play next round."
    : "Keep this page open; your role appears here when the round starts.";
  sheet.append(node("p", "waiting-copy", message), node("div", "waiting-mark", "✓ CARD LINKED"));
  page.append(sheet);
  root.replaceChildren(page);
}

function roleTips(role) {
  const panel = node("section", `tips-panel ${role.toLowerCase()}-tips`);
  panel.append(node("h2", "", role === "IMPOSTER" ? "How to win as the Imposter" : "How to catch the Imposter"));
  const list = node("ul");
  const tips = role === "IMPOSTER" ? [
    "Get chat talking: bring up a topic where your word fits naturally.",
    "Put the word in the middle of a sentence, not first or last.",
    "Ask other players questions. The one asking looks less suspicious.",
  ] : [
    "Chat as usual and ask questions. The Imposter needs a topic for their word.",
    "Watch who changes the topic or uses oddly specific words.",
    "Use the topic hint first, then the first letter to narrow it down.",
  ];
  list.append(...tips.map((tip) => node("li", "", tip)));
  const example = node("p", "role-example", role === "IMPOSTER"
    ? "Example: “I take my tea with lemon and honey, you?”"
    : "Example: topic FOOD, letter L, someone says “tea with lemon”. Got them.");
  panel.append(list, example);
  return panel;
}

function appendRoundTools(page) {
  page.append(hintCards());
  if (!state.onStream) page.append(sideTableChat());
  const details = node("details", "table-details");
  details.open = detailsOpen;
  details.addEventListener("toggle", () => { detailsOpen = details.open; });
  details.append(node("summary", "", `Table ${state.tableId} players and accusation`));
  const mates = node("div", "mini-mates");
  for (const mate of (state.tableMates || []).filter(Boolean)) {
    const item = node("div", "mini-mate");
    item.append(playerPhoto(mate, "mini-mate-photo"), node("span", "", `${mate.number || "?"} · ${mate.login}`));
    mates.append(item);
  }
  details.append(mates);
  if (state.state === "ROUND") details.append(accusePanel());
  page.append(details);
}

function sideTableChat() {
  const panel = node("section", "side-chat");
  panel.append(node("h2", "", "TABLE CHAT"));
  const log = node("div", "side-chat-log");
  for (const message of (state.messages || []).filter(Boolean).slice(-20)) {
    const line = node("p", message.source === "voice" ? "voice-line" : "");
    line.append(node("strong", "", `@${message.player?.login || "unknown"}: `), document.createTextNode(`${message.source === "voice" ? "🎙 " : ""}${message.text}`));
    log.append(line);
  }
  if (!log.children.length) log.append(node("p", "chat-empty", "No evidence yet."));
  panel.append(log);
  const form = node("form", "side-chat-form");
  const input = node("input");
  input.maxLength = 200;
  input.placeholder = "Message your table…";
  input.value = chatDraft;
  input.addEventListener("input", () => { chatDraft = input.value; });
  input.addEventListener("focus", () => { chatFocused = true; });
  input.addEventListener("blur", () => { chatFocused = false; });
  if (chatFocused) requestAnimationFrame(() => input.focus());
  const send = node("button", "small-action", "SEND");
  send.type = "submit";
  form.append(input, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !sendCardAction({ type: "tableChat", text })) return;
    chatDraft = "";
    input.value = "";
  });
  panel.append(form);
  return panel;
}

function accusePanel() {
  const form = node("form", "accuse-panel");
  form.append(node("h3", "", "OPTIONAL PRO MOVE · ONE ACCUSATION"));
  const select = node("select");
  select.append(node("option", "", "Pick a suspect"));
  for (const mate of (state.tableMates || []).filter(Boolean)) {
    if (mate.id === state.player?.id) continue;
    const option = node("option", "", `${mate.number || "?"} · @${mate.login}`);
    option.value = mate.login;
    select.append(option);
  }
  select.value = accuseDraft.target;
  select.addEventListener("change", () => { accuseDraft.target = select.value; });
  const word = node("input");
  word.placeholder = "Secret word";
  word.maxLength = 20;
  word.value = accuseDraft.word;
  word.addEventListener("input", () => { accuseDraft.word = word.value; });
  const button = node("button", "small-action danger", state.accusationUsed ? "SHOT USED" : "ACCUSE");
  button.disabled = state.accusationUsed;
  form.append(select, word, button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!select.value || !word.value.trim()) return;
    if (state.onStream) {
      navigator.clipboard?.writeText(`!accuse ${select.value} ${word.value.trim()}`);
      showToast("Accusation command copied. Paste it in Twitch chat.", false);
    } else sendCardAction({ type: "accuse", target: select.value, word: word.value.trim() });
  });
  return form;
}

function renderRole(role, signal) {
  const page = node("div", "role-page");
  page.append(topBar(`SUS WORD · ROUND ${state.roundNumber}`));
  if (signal) page.append(node("div", "new-round-banner", "🔔 NEW ROUND: CHECK YOUR ROLE"));
  const table = tableLabel();
  if (table) page.append(table);
  const sheet = paperSheet(`role-sheet ${role === "IMPOSTER" ? "imposter-sheet" : "detective-sheet"}`);
  sheet.setAttribute("aria-live", "polite");
  sheet.append(node("p", "step-label", "YOUR ROLE THIS ROUND"));
  const stamp = node("div", `role-stamp ${role.toLowerCase()}-stamp`, `${role === "IMPOSTER" ? "🤫" : "🔎"} ${role}`);
  sheet.append(stamp);
  let highlight = null;
  if (role === "IMPOSTER") {
    sheet.append(node("p", "secret-label", "YOUR SECRET WORD THIS ROUND"));
    highlight = node("strong", "secret-word", state.word || "SECRET");
    const status = impostorStatus(state);
    sheet.append(highlight, node("div", `delivery-chip${status.className ? ` ${status.className}` : ""}`, status.status),
      node("p", "role-job", status.job));
    if (state.impostorCount > 1) sheet.append(node("p", "two-imposters", "2 Imposters this round; the other one has a different word."));
  } else {
    sheet.append(node("p", "role-job", state.impostorCount > 1
      ? "Someone (or two) is hiding a word: catch them."
      : "Someone in chat is hiding a word. Watch closely."));
    if (state.impostorCount > 1) sheet.append(node("p", "two-imposters", "2 Imposters this round: catch both."));
  }
  if (showRoleTips(state, role)) sheet.append(roleTips(role));
  page.append(sheet);
  appendRoundTools(page);
  root.replaceChildren(page);
  updateTimers();
  if (signal) runNewRoundSignal(sheet, stamp, highlight);
}

function renderVote() {
  const page = node("div", "vote-page");
  const banner = node("header", "vote-banner");
  banner.append(node("h1", "", "🗳️ VOTE NOW!"));
  const timer = node("time", "vote-count");
  timer.dataset.timer = "vote";
  timer.setAttribute("aria-live", "polite");
  const progress = node("div", "vote-progress");
  progress.append(node("i"));
  banner.append(timer, progress);
  const hiddenCount = hiddenImpostorCount(state);
  page.append(banner, node("p", "vote-instruction", hiddenCount > 1
    ? `${hiddenCount} Imposters still hidden · top ${hiddenCount} are accused`
    : "1 Imposter still hidden · top vote accused"));
  const grid = node("section", "vote-grid");
  const bustedIds = new Set(state.bustedImpostorIds || []);
  const mates = [...(state.tableMates || [])].filter(Boolean)
    .sort((left, right) => (left.number || 0) - (right.number || 0));
  for (const mate of mates) {
    const own = mate.id === state.player?.id;
    const busted = bustedIds.has(mate.id);
    const selected = mate.id === state.voteTargetId;
    const button = node("button", `vote-player${own ? " own" : ""}${busted ? " busted" : ""}${selected ? " selected" : ""}`);
    button.type = "button";
    button.disabled = own || busted;
    button.dataset.playerId = mate.id;
    button.append(node("span", "vote-number", String(mate.number || "?")), playerPhoto(mate, "vote-avatar"), node("strong", "vote-name", mate.login));
    if (own) button.append(node("span", "vote-you", "YOU"));
    if (busted) button.append(node("span", "vote-you", "BUSTED"));
    button.append(node("span", "vote-marker", selected ? "✓ YOUR VOTE" : ""));
    button.addEventListener("click", () => {
      if (!sendCardAction({ type: "vote", number: mate.number })) return;
      state.voteTargetId = mate.id;
      for (const tile of grid.querySelectorAll(".vote-player")) {
        const active = tile.dataset.playerId === mate.id;
        tile.classList.toggle("selected", active);
        tile.querySelector(".vote-marker").textContent = active ? "✓ YOUR VOTE" : "";
      }
    });
    grid.append(button);
  }
  page.append(grid, node("p", "vote-footer", "Or type the number in chat. !vote name still works too."));
  root.replaceChildren(page);
  if (!reducedMotion.matches) banner.animate(
    [{ transform: "translateY(-100%)" }, { transform: "translateY(8px)" }, { transform: "translateY(0)" }],
    { duration: 350, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" },
  );
  updateTimers();
}

function renderRevealHold() {
  const page = node("div", "hold-page");
  page.append(topBar(`ROUND ${state.roundNumber} · REVEAL`, "hold"));
  const sheet = paperSheet("hold-sheet");
  sheet.setAttribute("aria-live", "polite");
  sheet.append(node("div", "watch-eye", "👀"), node("h1", "", "Watch the stream"), node("p", "", "The reveal is on. Your result will appear here after it plays."));
  page.append(sheet);
  root.replaceChildren(page);
  updateTimers();
}

function renderResult() {
  const page = node("div", "result-page");
  page.append(topBar(`ROUND ${state.roundNumber} · RESULT`, "lobby"));
  const sheet = paperSheet("result-sheet");
  sheet.setAttribute("aria-live", "polite");
  sheet.append(node("p", "step-label", `YOU WERE ${state.role === "IMPOSTER" ? "AN IMPOSTER" : "A DETECTIVE"}`));
  const resultImposters = (state.result?.imposters || []).filter(Boolean);
  const mine = resultImposters.find(({ impostor }) => impostor?.id === state.player?.id);
  const headline = mine
    ? (mine.verdict === "GOT AWAY" ? "YOU GOT AWAY!" : mine.verdict === "WORD NEVER LANDED" ? "WORD NEVER LANDED" : "YOU WERE CAUGHT")
    : state.voteWasRight ? "YOU CAUGHT ONE!" : "CASE CLOSED";
  sheet.append(node("div", `result-headline ${state.voteWasRight || mine?.verdict === "GOT AWAY" ? "good" : ""}`, headline));
  const rows = node("div", "result-rows");
  const voteText = state.voteTarget
    ? `#${state.voteTarget.number || "?"} @${state.voteTarget.login} ${state.voteWasRight ? "✓ Imposter" : "✕ Detective"}`
    : "No vote";
  resultRow(rows, "Your vote", voteText);
  for (const imposter of resultImposters) resultRow(rows, `@${imposter.impostor?.login || "imposter"}`, `${String(imposter.word || "word").toUpperCase()} · ${imposter.verdict || "CASE CLOSED"}`);
  resultRow(rows, "Points this round", `${state.roundPoints >= 0 ? "+" : ""}${state.roundPoints}`, "score");
  resultRow(rows, "Total · rank", `${state.totalScore} pts · #${state.rank || "–"} of ${state.playerCount || "–"}`);
  sheet.append(rows, node("p", "next-round-note", "Next round deals new roles. Keep this page open; it updates on its own."));
  page.append(sheet);
  root.replaceChildren(page);
  updateTimers();
}

function renderChampion() {
  const champion = state.result?.champion || state.champion;
  const isChampion = champion?.id === state.player?.id;
  const page = node("div", "champion-page");
  page.append(topBar("FINAL TABLE", "lobby"));
  const sheet = paperSheet("champion-sheet");
  sheet.setAttribute("aria-live", "polite");
  sheet.append(node("p", "step-label", "THE CASE IS CLOSED"), playerPhoto(champion, "champion-photo"));
  sheet.append(node("h1", "champion-name", `@${champion?.login || "champion"}`));
  sheet.append(node("div", "champion-stamp", "CHAMPION"));
  sheet.append(node("p", "champion-copy", isChampion
    ? `You won with ${state.totalScore || champion?.score || 0} points.`
    : `Final standing: #${state.rank || "–"} of ${state.playerCount || "–"} · ${state.totalScore || 0} points.`));
  page.append(sheet);
  root.replaceChildren(page);
  updateTimers();
}

function renderSessionOver() {
  const page = node("div", "waiting-page session-over-page");
  page.append(topBar("SESSION OVER", "lobby"));
  const sheet = paperSheet("waiting-sheet session-over-sheet");
  sheet.append(node("p", "step-label", "THE CASE IS CLOSED"), node("h1", "join-title", "Session over"));
  sheet.append(node("p", "waiting-copy", "Thanks for playing. Keep this card link for the next case."));
  page.append(sheet);
  root.replaceChildren(page);
}

function resultRow(container, label, value, valueClass = "") {
  const row = node("div", "result-row");
  row.append(node("span", "", label), node("strong", valueClass, value));
  container.append(row);
}

function render(nextState) {
  nextState = nextState ?? { linked: false, role: null };
  const nextSignature = cardRenderSignature(nextState);
  const nextRound = nextState.roundNumber ?? null;
  if (interactiveRound !== null && nextRound !== interactiveRound) {
    detailsOpen = false;
    accuseDraft = { target: "", word: "" };
  }
  interactiveRound = nextRound;
  state = nextState;
  receivedAt = Date.now();
  if (nextSignature === lastRenderSignature) {
    updateTimers();
    return;
  }
  lastRenderSignature = nextSignature;
  const screen = cardScreen(state);
  const signal = ["imposter", "detective"].includes(screen) && state.state === "ROUND" && state.roundNumber !== signaledRound;
  if (signal) signaledRound = state.roundNumber;
  if (screen === "join-name") renderLogin({ nameCheck: state.nameCheck });
  else if (screen === "join-code" || screen === "join-wrong") renderClaim(state.pendingClaim);
  else if (screen === "imposter") renderRole("IMPOSTER", signal);
  else if (screen === "detective") renderRole("DETECTIVE", signal);
  else if (screen === "vote") renderVote();
  else if (screen === "reveal-hold") renderRevealHold();
  else if (screen === "result" && (state.result?.champion || state.champion)) renderChampion();
  else if (screen === "result") renderResult();
  else if (screen === "session-over") renderSessionOver();
  else renderWaiting();
}

async function unlockAudio() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
}

function playChime() {
  if (muted || !audioContext || audioContext.state !== "running") return;
  const start = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(.12, start + .015);
  gain.gain.exponentialRampToValueAtTime(.0001, start + .36);
  gain.connect(audioContext.destination);
  for (const [frequency, delay] of [[660, 0], [990, .09]]) {
    const oscillator = audioContext.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(start + delay);
    oscillator.stop(start + .38);
  }
}

function runNewRoundSignal(sheet, stamp, highlight) {
  playChime();
  vibrateIfActivated(navigator);
  const banner = root.querySelector(".new-round-banner");
  setTimeout(() => banner?.remove(), reducedMotion.matches ? 400 : 3_000);
  if (reducedMotion.matches) {
    sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    return;
  }
  const cover = node("div", "sealed-cover");
  cover.append(node("span", "", "TOP SECRET"));
  root.append(cover);
  cover.animate([
    { transform: "rotateY(0)", opacity: 1, offset: 0 },
    { transform: "rotateY(0)", opacity: 1, offset: .55 },
    { transform: "rotateY(90deg)", opacity: 0, offset: 1 },
  ], { duration: 1_100, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }).finished.finally(() => cover.remove());
  sheet.animate([{ transform: "rotateY(-90deg)", opacity: 0 }, { transform: "rotateY(0)", opacity: 1 }],
    { delay: 600, duration: 500, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
  stamp.animate([{ transform: "rotate(-2deg) scale(1.6)", opacity: 0 }, { transform: "rotate(-2deg) scale(1)", opacity: 1 }],
    { delay: 1_100, duration: 160, easing: "cubic-bezier(.2,.9,.2,1.2)", fill: "both" });
  stamp.animate([{ translate: "0 0" }, { translate: "-2px 1px" }, { translate: "2px -1px" }, { translate: "0 0" }],
    { delay: 1_260, duration: 100 });
  highlight?.animate([{ backgroundSize: "0% 42%" }, { backgroundSize: "100% 42%" }],
    { delay: 1_300, duration: 450, easing: "ease-out", fill: "both" });
  signalBorder.animate([
    { opacity: 1, offset: 0 }, { opacity: 0, offset: .3 },
    { opacity: 0, offset: .7 }, { opacity: 1, offset: .71 }, { opacity: 0, offset: 1 },
  ], { duration: 500, easing: "linear" });
}

async function requestWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== "visible" || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

function updateTimers() {
  const remaining = remainingMs();
  for (const timer of document.querySelectorAll("[data-timer='phase']")) timer.textContent = `⏱ ${formatClock(remaining)}`;
  for (const timer of document.querySelectorAll("[data-timer='vote']")) timer.textContent = formatClock(remaining);
  for (const timer of document.querySelectorAll("[data-timer='lobby']")) timer.textContent = state.state === "LOBBY" ? `LOBBY ${formatClock(remaining)}` : "PRIVATE";
  for (const timer of document.querySelectorAll("[data-timer='hold']")) timer.textContent = "ON STREAM";
  const bar = document.querySelector(".vote-progress i");
  if (bar) bar.style.transform = `scaleX(${voteProgress(state, Date.now() - receivedAt)})`;
  const expiry = document.querySelector("[data-expires-at]");
  if (expiry) expiry.textContent = `Code valid for ${formatClock(Number(expiry.dataset.expiresAt) - Date.now())}`;
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
      if (payload.data?.ok) showToast(payload.action === "accuse" && payload.data.correct ? "BUSTED ✓" : "Saved ✓", false);
      else showToast(actionError(payload.data?.reason));
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

function mockAvatar(color = "#8261a8", label = "SW") {
  const safe = label.slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${color}"/><circle cx="60" cy="49" r="27" fill="#efbd91"/><path d="M25 120c5-32 17-46 35-46s30 14 35 46" fill="#33283e"/><text x="60" y="111" text-anchor="middle" fill="white" font-size="16">${safe}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function mockPlayers() {
  const names = ["pixel_mara", "cydshop", "romabuilds", "quietfox", "tomtom_irl", "nightbyte", "akira_k", "lumi", "bigsalad", "jo_plays", "marrow", "drovosek7777"];
  const colors = ["#a079d3", "#6cc08b", "#78a9dc", "#e58b5a", "#d77b9b", "#7fc6c4", "#c9a27b", "#9bbb6a", "#e07a7a", "#8fa0d8", "#d4b483", "#e7c45c"];
  return names.map((login, index) => ({ id: `p${index + 1}`, login, displayName: login, number: index + 1, avatar: mockAvatar(colors[index], login) }));
}

function mockCard(kind) {
  const tableMates = mockPlayers();
  const player = tableMates[0];
  if (kind === "join") return {
    linked: false,
    role: null,
    state: "LOBBY",
    remainingMs: 42_000,
    nameCheck: { seen: true, message: "✓ @pixel_mara is in chat" },
  };
  if (["join-wrong", "claim"].includes(kind)) return {
    linked: false,
    role: null,
    pendingClaim: {
      login: "pixel_mara",
      code: "QMYP",
      expiresAt: Date.now() + 570_000,
      ...(kind === "join-wrong" ? { error: "@quietfox this code was made for @pixel_mara. Open the card and type your own Twitch name" } : {}),
    },
  };
  const base = {
    linked: true, joined: true, state: "ROUND", roundNumber: 3, player, role: "DETECTIVE",
    remainingMs: 133_000, phaseDurationMs: 180_000, phaseEndsAt: Date.now() + 133_000,
    tableId: 1, tableCount: 1, featuredTableId: 1, onStream: true, tableMates,
    hints: { category: "food", letter: null }, messages: [], canAccuse: true, accusationUsed: false,
    impostorCount: ["imposter-2", "detective", "vote"].includes(kind) ? 2 : 1,
    remainingImpostorCount: ["imposter-2", "detective", "vote"].includes(kind) ? 2 : 1,
  };
  if (["imposter", "imposter-2", "delivered", "busted", "side"].includes(kind)) Object.assign(base, {
    role: "IMPOSTER", word: "lemon", delivered: kind === "delivered", deliveredAt: kind === "delivered" ? "0:47" : null,
  });
  if (kind === "busted") Object.assign(base, {
    delivered: true, deliveredAt: "0:47", busted: true, bustedBy: tableMates[1],
  });
  if (kind === "side") Object.assign(base, { tableId: 2, tableCount: 3, onStream: false });
  if (kind === "vote") Object.assign(base, { state: "VOTE", remainingMs: 19_000, phaseDurationMs: 30_000, voteTargetId: "p2" });
  if (kind === "reveal-hold") Object.assign(base, { state: "REVEAL", role: null, revealHold: true, resultAvailableAt: Date.now() + 26_000 });
  if (kind === "result") Object.assign(base, {
    state: "LOBBY", role: "DETECTIVE", showResult: true, voteTarget: tableMates[1], voteWasRight: true,
    roundPoints: 1, totalScore: 4, rank: 2, playerCount: 12,
    result: { imposters: [
      { impostor: tableMates[1], word: "lemon", verdict: "CAUGHT" },
      { impostor: tableMates[4], word: "blanket", verdict: "GOT AWAY" },
    ] },
  });
  if (kind === "champion") Object.assign(base, {
    state: "LOBBY", role: "DETECTIVE", showResult: true, voteTarget: tableMates[1], voteWasRight: true,
    roundPoints: 3, totalScore: 14, rank: 1, playerCount: 12,
    result: { champion: player, imposters: [{ impostor: tableMates[1], word: "lemon", verdict: "CAUGHT" }] },
  });
  return base;
}

soundToggle.textContent = muted ? "🔇" : "🔊";
soundToggle.addEventListener("click", async () => {
  muted = !muted;
  localStorage.setItem("sus-word-muted", String(muted));
  soundToggle.textContent = muted ? "🔇" : "🔊";
  soundToggle.setAttribute("aria-label", muted ? "Unmute new-round chime" : "Mute new-round chime");
  if (!muted) await unlockAudio();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.linked) requestWakeLock();
});

setInterval(updateTimers, 250);
const mock = new URLSearchParams(location.search).get("mock");
const mockKinds = ["join", "join-wrong", "claim", "imposter", "imposter-2", "delivered", "busted", "detective", "vote", "reveal-hold", "result", "champion", "side", "featured"];
if (mockKinds.includes(mock)) {
  connection.textContent = "PREVIEW";
  render(mockCard(mock));
} else {
  loadCard().finally(connect);
}
