const $ = (selector) => document.querySelector(selector);
const stage = $("#stage");
const params = new URLSearchParams(location.search);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let state = null;
let receivedAt = Date.now();
let reconnectDelay = 1_000;
let previousCounts = {};
let previousHint = {};
let previousLobbyIds = new Set();
let lobbyFullUntil = 0;
let revealTimers = [];
let revealKey = "";
let lastVoteSecond = null;
let audioContext = null;

function audio() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

function tone(frequency, duration = .08, volume = .035, type = "sine") {
  const context = audio();
  if (context.state !== "running") return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, context.currentTime);
  gain.gain.setValueAtTime(volume, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration);
}

function thud() { tone(92, .18, .1, "triangle"); }
function tickSound() { tone(880, .045, .025); }
function rewindSound() { tone(74, 1.1, .018, "sawtooth"); }

function el(tag, className = "", text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function fit() {
  const scale = Math.min(innerWidth / 1280, innerHeight / 720);
  stage.style.transform = `translate(-50%,-50%) scale(${scale})`;
}

function remaining() {
  if (Number.isFinite(state?.remainingMs)) return Math.max(0, state.remainingMs - (Date.now() - receivedAt));
  if (Number.isFinite(state?.round?.remainingMs)) return Math.max(0, state.round.remainingMs - (Date.now() - receivedAt));
  return Math.max(0, (state?.phaseEndsAt || Date.now()) - Date.now());
}

function clock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function avatar(player) {
  const frame = el("span", "player-avatar");
  if (player?.avatar) {
    const image = el("img");
    image.src = player.avatar;
    image.alt = "";
    frame.append(image);
  } else frame.textContent = String(player?.login || "?").slice(0, 2).toUpperCase();
  return frame;
}

function stablePlayers(source = []) {
  return [...source].sort((a, b) => (a.number || 999) - (b.number || 999) || String(a.login).localeCompare(String(b.login))).slice(0, 12);
}

function voteLike(message) {
  return message?.isVote || message?.voteMessage || message?.kind === "vote" || /^\s*(?:!vote\s+|[!#]?\d+\s*$)/i.test(message?.text || "");
}

function playerRow(player, options = {}) {
  const row = el("article", `player-row${options.vote ? " vote-row" : ""}${options.talking ? " talking" : ""}`);
  row.dataset.playerId = player.id;
  row.append(el("b", "player-number", String(player.number || "?")), avatar(player));
  const name = el("strong", `player-name${String(player.login || "").length > 12 ? " long" : ""}`, player.login || "player");
  row.append(name);
  if (options.count !== undefined) {
    const badge = el("span", `message-count${options.bump ? " bump" : ""}`, String(options.count));
    row.append(badge);
  }
  if (options.vote) {
    const bar = el("i", "vote-bar");
    bar.style.width = `${options.bar || 0}%`;
    row.append(bar);
    if (options.votes) row.append(el("span", "vote-count", String(options.votes)));
  }
  if (options.busted) row.append(el("span", "busted-mini", `BUSTED by @${options.busted.accuser?.login || "detective"}`));
  return row;
}

function messageSlip(message, index = 0) {
  const slip = el("article", "message-slip");
  slip.style.setProperty("--tilt", `${[-1.1, .7, -.4][index % 3]}deg`);
  const voice = message.source === "voice";
  slip.append(el("strong", "", `${voice ? "🎙 " : ""}${message.player?.login || "player"}${voice ? " (said out loud)" : ""}: `));
  slip.append(document.createTextNode(message.text || ""));
  return slip;
}

function renderMessages(messages = []) {
  const tray = $("#evidence-tray");
  const safe = messages.filter((message) => !voteLike(message)).slice(-3);
  tray.replaceChildren(...safe.map(messageSlip));
  tray.hidden = safe.length === 0;
  if (!reduced.matches) [...tray.children].forEach((slip, index) => slip.animate(
    [{ transform: "translateY(-20px) rotate(0)", opacity: 0 }, { transform: `translateY(0) rotate(${[-1.1, .7, -.4][index]}deg)`, opacity: 1 }],
    { duration: 220, easing: "ease-out" },
  ));
}

function hideBase() {
  for (const selector of ["#idle-tag", "#how-panel", "#phase-strip", "#compact-lobby", "#vote-banner", "#camera-dim", "#board", "#evidence-tray", "#reveal-layer", "#new-roles"]) $(selector).hidden = true;
}

function renderHints(hints = {}) {
  for (const [key, selector] of [["category", "#hint-category"], ["letter", "#hint-letter"]]) {
    const target = $(selector);
    const next = hints[key] ? String(hints[key]).toUpperCase() : "🔒";
    target.textContent = next;
    if (previousHint[key] && previousHint[key] !== next && next !== "🔒" && !reduced.matches) {
      const card = target.closest(".hint");
      card.animate([{ transform: "rotateY(180deg)" }, { transform: "rotateY(0)" }], { duration: 400, easing: "ease-out" });
      setTimeout(() => card.animate([{ transform: "translateX(-2px)" }, { transform: "translateX(2px)" }, { transform: "none" }], { duration: 120 }), 400);
      setTimeout(thud, 400);
    }
    previousHint[key] = next;
  }
}

function renderLeaderboard(entries = [], prior = []) {
  const panel = $("#leaderboard");
  panel.replaceChildren(el("h3", "", "LEADERBOARD"));
  entries.slice(0, 3).forEach((entry, index) => {
    const player = entry.player || entry;
    const old = prior.findIndex((item) => (item.player || item).id === player.id);
    const row = el("div", "leader-row");
    const label = el("span", "", player.login || "player");
    if (old >= 0 && old !== index) label.append(el("i", "rank-arrow", ` ${old > index ? "▲" : "▼"}`));
    row.append(el("b", "", `${index + 1}.`), label, el("b", "", String(entry.score ?? player.score ?? 0)));
    panel.append(row);
    if (old >= 0 && old !== index && !reduced.matches) row.animate(
      [{ transform: `translateY(${(old - index) * 23}px)` }, { transform: "translateY(0)" }],
      { duration: 600, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  });
}

function renderBoardRoster(players, counts = {}, busted = []) {
  const grid = $("#player-grid");
  const rows = stablePlayers(players).map((player, index) => {
    const count = counts[player.id] || 0;
    const row = playerRow(player, { count, bump: count > (previousCounts[player.id] || 0), talking: count > (previousCounts[player.id] || 0), busted: busted.find((item) => item.impostor?.id === player.id) });
    if (!reduced.matches && state?.newRound) row.animate([{ transform: `rotate(${index % 2 ? 2 : -2}deg)` }, { transform: "rotate(0)" }], { duration: 400, delay: index * 30 });
    return row;
  });
  grid.replaceChildren(...rows);
  previousCounts = { ...counts };
}

function lobbyIsFull(next) {
  if (params.get("mock") === "lobby-first") return true;
  if (params.get("mock") === "lobby") return false;
  const ids = new Set((next.players || []).map(({ id }) => id));
  const joined = [...ids].some((id) => !previousLobbyIds.has(id)) && previousLobbyIds.size > 0;
  previousLobbyIds = ids;
  if (joined) lobbyFullUntil = Date.now() + 15_000;
  return (next.roundNumber || 0) <= 1 || Date.now() < lobbyFullUntil;
}

function renderLobby(next) {
  const full = lobbyIsFull(next);
  $("#board").hidden = false;
  $("#board-title").textContent = "PLAYERS";
  $("#board-meta").textContent = "12 max";
  $("#hints").hidden = true;
  $("#leaderboard").hidden = true;
  renderBoardRoster(next.players || [], {});
  const note = $("#board-note");
  note.replaceChildren(el("strong", "", "JOINING NOW?"), document.createTextNode("Type !join in chat, then open the card link it replies with. Takes 20 seconds."));
  if (full) {
    $("#how-panel").hidden = false;
    $("#how-ready").textContent = `Players with cards: ${next.claimedCount || 0} / 3 needed`;
    $("#how-clock").textContent = `Starting in ${clock(remaining())}`;
  } else {
    const compact = $("#compact-lobby");
    compact.hidden = false;
    compact.replaceChildren(document.createTextNode(`Next round in ${clock(remaining())} · `), el("strong", "", `${next.claimedCount || 0} players ready`), document.createTextNode(" · new? type !join"));
  }
}

function renderRound(next, newRound = false) {
  const round = next.round || {};
  $("#phase-strip").hidden = false;
  $("#strip-title").textContent = next.final ? "FINAL TABLE" : `ROUND ${next.roundNumber} · ${newRound ? "NEW ROLES" : "TALK"}`;
  $("#strip-rule").textContent = "Imposters hide a word in chat.\nDetectives hunt. Check your card.";
  $("#board").hidden = false;
  $("#board-title").textContent = next.final ? "FINAL TABLE" : `ROUND ${next.roundNumber}`;
  $("#board-meta").textContent = `${round.impostorCount || next.impostorCount || 1} IMPOSTER${(round.impostorCount || next.impostorCount || 1) === 1 ? "" : "S"}`;
  $("#hints").hidden = false;
  renderHints(round.hints || {});
  renderBoardRoster(round.players || next.players || [], round.messageCounts || {}, round.busted || []);
  const note = $("#board-note");
  note.replaceChildren(el("strong", "", "HOW TO VOTE (at 0:00)"), document.createTextNode("Type a player's number in chat, like 2, or tap them on your card. Glowing = talking now."));
  $("#leaderboard").hidden = false;
  renderLeaderboard(next.leaderboard || next.scores || []);
  renderMessages(round.latestMessages || round.recentMessages || round.messages || []);
  if (newRound) animateNewRound();
}

function renderVote(next) {
  const round = next.round || {};
  const players = stablePlayers(round.players || next.players || []);
  const tallies = new Map((round.tallies || []).map((entry) => [entry.player?.id || entry.playerId, entry.votes || 0]));
  const max = Math.max(1, ...tallies.values());
  $("#vote-banner").hidden = false;
  $("#board").hidden = false;
  $("#board-title").textContent = "WHO HID A WORD?";
  $("#board-meta").textContent = `${round.impostorCount || next.impostorCount || 1} to catch`;
  $("#hints").hidden = false;
  renderHints(round.hints || {});
  $("#player-grid").replaceChildren(...players.map((player) => playerRow(player, { vote: true, votes: tallies.get(player.id) || 0, bar: ((tallies.get(player.id) || 0) / max) * 100 })));
  $("#board-note").replaceChildren(el("strong", "", "VOTES ARE LIVE"), document.createTextNode("Bars fill as chat votes. You can change your vote until 0:00. Top votes are accused."));
  $("#leaderboard").hidden = true;
  renderMessages(round.latestMessages || round.recentMessages || []);
  if (!reduced.matches) $("#vote-banner").animate([{ transform: "translateY(-100%)" }, { transform: "translateY(7px)" }, { transform: "translateY(0)" }], { duration: 350, easing: "cubic-bezier(.2,.8,.2,1)" });
}

function clearReveal() {
  revealTimers.forEach(clearTimeout);
  revealTimers = [];
  $("#reveal-layer").replaceChildren();
}

function later(fn, ms) {
  const id = setTimeout(fn, reduced.matches ? Math.min(200, ms) : ms);
  revealTimers.push(id);
}

function highlightedEvidence(result) {
  const line = el("div", "evidence-line");
  const evidence = result.evidence;
  if (!evidence) {
    line.append(el("strong", "crossed", result.word || "SECRET WORD"), document.createTextNode(" · THE WORD NEVER MADE IT OUT"));
    return { line, mark: null };
  }
  const voice = evidence.source === "voice";
  line.append(document.createTextNode(`${voice ? "🎙 " : ""}${evidence.player?.login || result.impostor?.login}: “`));
  line.append(document.createTextNode(evidence.text.slice(0, evidence.index)));
  const mark = el("mark", "", evidence.text.slice(evidence.index, evidence.index + evidence.length));
  line.append(mark, document.createTextNode(`${evidence.text.slice(evidence.index + evidence.length)}”`));
  return { line, mark };
}

function finalCase(result) {
  const card = el("article", "case-card");
  const head = el("header", "case-head");
  head.append(avatar(result.impostor), el("strong", "", `@${result.impostor?.login || "imposter"}`));
  const word = el("span", "case-word");
  word.append(document.createTextNode("WORD: "), el("mark", "", String(result.word || "unknown").toUpperCase()));
  head.append(word);
  const { line } = highlightedEvidence(result);
  card.append(head, line, el("p", "reveal-caption", result.caption || (result.evidence ? "Hidden in plain sight." : "THE WORD NEVER MADE IT OUT")));
  const verdict = result.verdict || (result.evidence ? "GOT AWAY" : "WORD NEVER LANDED");
  const displayVerdict = verdict === "CAUGHT" ? "BUSTED" : verdict;
  card.append(el("b", `verdict${verdict === "GOT AWAY" ? " away" : verdict.includes("NEVER") ? " miss" : ""}`, `${displayVerdict}${verdict === "GOT AWAY" ? " +3" : ""}`));
  return card;
}

function showRevealEnd(next, results) {
  const layer = $("#reveal-layer");
  layer.replaceChildren(el("h1", "reveal-title", `ROUND ${next.roundNumber} · THE REVEAL: ${results.length} IMPOSTER${results.length === 1 ? "" : "S"}`));
  const cases = el("section", `reveal-cases${results.length > 1 ? " two" : ""}`);
  results.forEach((result) => cases.append(finalCase(result)));
  layer.append(cases);
  $("#board").hidden = false;
  $("#board-title").textContent = "FINAL VOTES";
  $("#board-meta").textContent = "";
  $("#hints").hidden = true;
  const round = next.round || {};
  const tallies = new Map((round.tallies || next.round?.reveal?.tallies || []).map((entry) => [entry.player?.id || entry.playerId, entry.votes || 0]));
  const max = Math.max(1, ...tallies.values());
  $("#player-grid").replaceChildren(...stablePlayers(round.players || next.players || []).map((player) => playerRow(player, { vote: true, votes: tallies.get(player.id) || 0, bar: ((tallies.get(player.id) || 0) / max) * 100 })));
  $("#board-note").replaceChildren();
  $("#leaderboard").hidden = false;
  renderLeaderboard(next.round?.reveal?.leaderboard || next.leaderboard || next.scores || [], next.scores || []);
  if (!params.has("mock") || params.get("play") === "1") later(() => cases.classList.add("shrunk"), 2_500);
}

function animateOneResult(next, result, index, done) {
  const layer = $("#reveal-layer");
  const start = index === 0 ? 0 : 9_000;
  later(() => {
    const title = el("h1", "reveal-title", index ? "THE SECOND IMPOSTER…" : "THE REVEAL");
    layer.replaceChildren(title);
    if (!reduced.matches) title.animate(
      [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
      { duration: 600, easing: "steps(14,end)", fill: "both" },
    );
    later(() => {
      if (!result.evidence) {
        const card = finalCase(result);
        layer.append(card);
        card.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "scale(1)" }], { duration: 400 });
        later(done, 1_300);
        return;
      }
      const rewind = el("section", "rewind");
      rewindSound();
      const counter = el("time", "rewind-counter", result.messages?.at(-1)?.elapsed || "3:00");
      const tape = el("div", "rewind-tape");
      [...(result.messages || [])].reverse().filter((message) => !voteLike(message)).forEach((message, messageIndex) => tape.append(messageSlip(message, messageIndex)));
      rewind.append(counter, tape);
      layer.append(rewind);
      const rewindMs = index ? 2_000 : 2_300;
      tape.animate([{ transform: "translateY(-75%)", filter: "blur(4px)" }, { transform: "translateY(0)", filter: "blur(0)" }], { duration: rewindMs, easing: "cubic-bezier(.05,.7,.18,1)", fill: "both" });
      const from = result.messages?.at(-1)?.elapsedMs || 180_000;
      const to = result.evidence.elapsedMs || 0;
      const begun = performance.now();
      const tick = (now) => {
        const progress = Math.min(1, (now - begun) / rewindMs);
        counter.textContent = clock(from - (from - to) * progress);
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      later(() => {
      rewind.remove();
      const card = finalCase(result);
      const caption = card.querySelector(".reveal-caption");
      const stamp = card.querySelector(".verdict");
      stamp.style.opacity = "0";
      caption.style.opacity = "0";
      const readerCount = result.readerCount ?? 0;
      caption.replaceChildren(document.createTextNode(`${result.elapsed || result.evidence.elapsed || "1:12"} into the round · `), el("strong", "read-count", "0 people read it"), document.createTextNode(result.caught ? " · someone noticed" : " · nobody noticed"));
      layer.append(card);
      card.animate([{ transform: "scale(1)", boxShadow: "none" }, { transform: "scale(1.35)", boxShadow: "0 24px 38px #000b" }], { duration: 400, fill: "both" });
      later(() => card.querySelector(".evidence-line mark")?.animate([{ backgroundSize: "0 70%" }, { backgroundSize: "100% 70%" }], { duration: 500, fill: "both" }), 500);
      later(() => {
        const count = card.querySelector(".read-count");
        caption.style.opacity = "1";
        const started = performance.now();
        const roll = (now) => {
          const progress = Math.min(1, (now - started) / 600);
          count.textContent = `${Math.round(readerCount * progress)} people read it`;
          if (progress < 1) requestAnimationFrame(roll);
        };
        requestAnimationFrame(roll);
      }, 1_100);
      later(() => {
        const row = $(`.player-row[data-player-id='${CSS.escape(result.impostor?.id || "")}']`);
        row?.classList.add("reveal-board-pulse");
      }, 2_000);
      later(() => {
        stamp.style.opacity = "1";
        thud();
        stamp.animate(result.verdict === "GOT AWAY"
          ? [{ clipPath: "circle(0 at 50% 50%)", opacity: .2 }, { clipPath: "circle(80% at 50% 50%)", opacity: 1 }]
          : [{ transform: "rotate(-14deg) scale(2.2)", opacity: 0 }, { transform: "rotate(-8deg) scale(1)", opacity: 1 }],
        { duration: result.verdict === "GOT AWAY" ? 400 : 160, fill: "both" });
        if (result.verdict !== "GOT AWAY" && !reduced.matches) {
          stage.animate([{ translate: "0" }, { translate: "3px -2px" }, { translate: "-3px 2px" }, { translate: "0" }], { duration: 120 });
          const flash = el("div", "red-flash"); layer.append(flash); setTimeout(() => flash.remove(), 80);
        } else if (result.verdict === "GOT AWAY") {
          const points = el("b", "float-points", "+3"); layer.append(points);
          points.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: "translate(410px,-250px)", opacity: 0 }], { duration: 700, fill: "forwards" });
        }
      }, 2_800);
      later(done, 4_000);
      }, rewindMs);
    }, 1_200);
  }, start);
}

function renderReveal(next) {
  $("#camera-dim").hidden = false;
  $("#reveal-layer").hidden = false;
  const reveal = next.round?.reveal;
  const results = reveal?.imposters?.length ? reveal.imposters : [reveal].filter(Boolean);
  $("#board").hidden = false;
  $("#board-title").textContent = "FINAL VOTES";
  $("#board-meta").textContent = "";
  $("#hints").hidden = true;
  const tallies = new Map((next.round?.tallies || reveal?.tallies || []).map((entry) => [entry.player?.id || entry.playerId, entry.votes || 0]));
  const leader = Math.max(1, ...tallies.values());
  $("#player-grid").replaceChildren(...stablePlayers(next.round?.players || next.players || []).map((player) => playerRow(player, { vote: true, votes: tallies.get(player.id) || 0, bar: ((tallies.get(player.id) || 0) / leader) * 100 })));
  $("#board-note").replaceChildren();
  $("#leaderboard").hidden = false;
  renderLeaderboard(next.scores || next.leaderboard || []);
  const play = params.get("play") === "1" || !params.has("mock");
  if (!play) return showRevealEnd(next, results);
  const finish = () => showRevealEnd(next, results);
  if (results.length === 1) animateOneResult(next, results[0], 0, finish);
  else {
    animateOneResult(next, results[0], 0, () => {});
    animateOneResult(next, results[1], 1, finish);
  }
  if (params.get("play") === "1") later(() => { clearReveal(); renderReveal(next); }, results.length > 1 ? 19_000 : 11_000);
}

function animateNewRound() {
  const bar = $("#new-roles");
  bar.hidden = false;
  if (reduced.matches) return later(() => { bar.hidden = true; }, 3_000);
  bar.animate([{ transform: "translateY(-100%)" }, { transform: "translateY(0)" }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1.2)", fill: "both" });
  $("#strip-title").animate([{ transform: "rotateX(90deg)" }, { transform: "rotateX(0)" }], { duration: 300 });
  later(() => bar.animate([{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }], { duration: 250, fill: "forwards" }).finished.then(() => { bar.hidden = true; }), 3_000);
}

function render(next) {
  state = next;
  receivedAt = Date.now();
  const phase = next.phase || next.state || "IDLE";
  hideBase();
  if (phase !== "REVEAL") { clearReveal(); revealKey = ""; }
  if (phase === "IDLE") $("#idle-tag").hidden = false;
  else if (phase === "LOBBY") renderLobby(next);
  else if (phase === "ROUND") renderRound(next, params.get("mock") === "newround" || next.newRound);
  else if (phase === "VOTE") renderVote(next);
  else if (phase === "REVEAL") {
    const key = `${next.roundNumber}:${next.round?.reveal?.imposters?.length || 1}`;
    if (key !== revealKey) { revealKey = key; clearReveal(); renderReveal(next); }
  }
  updateClocks();
}

function updateClocks() {
  if (!state) return;
  const ms = remaining();
  $("#strip-timer").textContent = `⏱ ${clock(ms)}`;
  const vote = $("#vote-time");
  const second = Math.ceil(ms / 1_000);
  vote.textContent = clock(ms);
  if (second !== lastVoteSecond) {
    vote.classList.remove("flip"); void vote.offsetWidth; vote.classList.add("flip");
    $("#vote-banner").classList.toggle("last-five", second > 0 && second <= 5);
    if (second > 0 && second <= 10) tickSound();
    lastVoteSecond = second;
  }
  $("#votes-locked").classList.toggle("show", ms <= 0);
  if (!$("#how-panel").hidden) $("#how-clock").textContent = `Starting in ${clock(ms)}`;
}

function mockAvatar(index) {
  const hue = (index * 47 + 18) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="hsl(${hue} 52% 64%)"/><circle cx="40" cy="34" r="18" fill="#edbd96"/><path d="M20 34Q22 8 40 10Q62 11 60 38Q48 22 21 35" fill="hsl(${hue} 35% 25%)"/><path d="M12 80Q17 54 40 54Q65 54 69 80" fill="#39435c"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const names = ["drovosek7777", "cydshop", "romabuilds", "pixel_mara", "quietfox", "tomtom_irl", "nightbyte", "akira_k", "lumi", "bigsalad", "jo_plays", "marrow"];
function mockState(kind) {
  const count = kind === "lobby-first" || kind === "round12" || ["vote", "reveal", "reveal2", "reveal-miss", "newround"].includes(kind) ? 12 : 7;
  const players = Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, number: index + 1, login: names[index] || `player_${index + 1}`, displayName: names[index], avatar: mockAvatar(index), claimed: true, score: 12 - index }));
  const messages = [
    { id: "m1", player: players[4] || players[0], text: "anyone else eating dinner rn", elapsedMs: 31_000, elapsed: "0:31" },
    { id: "m2", player: players[1], text: "just made tea, need a blanket tonight", elapsedMs: 51_000, elapsed: "0:51" },
    { id: "m3", player: players[7] || players[2], text: "what's everyone watching?", elapsedMs: 64_000, elapsed: "1:04" },
    { id: "m4", player: players[3], text: "lemon cake is underrated", elapsedMs: 108_000, elapsed: "1:48", index: 0, length: 5 },
  ];
  const base = { state: kind.startsWith("lobby") ? "LOBBY" : kind === "vote" ? "VOTE" : kind.startsWith("reveal") ? "REVEAL" : "ROUND", roundNumber: kind === "lobby-first" ? 1 : 3, players, claimedCount: Math.max(3, count), phaseEndsAt: Date.now() + (kind === "vote" ? 19_000 : 72_000), remainingMs: kind === "vote" ? 19_000 : 72_000, scores: players.map((player) => ({ player, score: player.score })) };
  base.phase = base.state;
  if (base.state === "LOBBY") return base;
  const messageCounts = Object.fromEntries(players.map((player, index) => [player.id, [7, 5, 3, 4, 2, 6, 1, 3, 1, 2, 1, 0][index] || 0]));
  const tallies = players.map((player, index) => ({ player, votes: [0, 5, 0, 3, 1, 0, 0, 0, 0, 1, 0, 0][index] || 0 }));
  base.round = { players, remainingMs: base.remainingMs, impostorCount: kind === "reveal2" ? 2 : 1, hints: { category: "FOOD · HOME", letter: kind === "vote" ? "L · B" : null }, messageCounts, latestMessages: messages.slice(0, 3), recentMessages: messages, tallies };
  if (base.state === "REVEAL") {
    const first = { impostor: players[3], word: "lemon", evidence: kind === "reveal-miss" ? null : messages[3], messages, elapsed: "1:48", readerCount: 9, caught: true, verdict: kind === "reveal-miss" ? "WORD NEVER LANDED" : "CAUGHT", caption: kind === "reveal-miss" ? "THE WORD NEVER MADE IT OUT" : "1:48 into the round · 9 people read it · someone noticed" };
    const secondEvidence = { ...messages[1], index: 22, length: 7 };
    const second = { impostor: players[1], word: "blanket", evidence: secondEvidence, messages, elapsed: "0:51", readerCount: 1, caught: false, verdict: "GOT AWAY", caption: "0:51 into the round · 1 person read it · nobody noticed" };
    base.round.reveal = { ...first, imposters: kind === "reveal2" ? [first, second] : undefined, leaderboard: base.scores.slice(0, 5), tallies };
  }
  if (kind === "newround") base.newRound = true;
  return base;
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?view=overlay`);
  socket.addEventListener("open", () => { reconnectDelay = 1_000; $("#connection-badge").hidden = true; });
  socket.addEventListener("message", (event) => { const payload = JSON.parse(event.data); if (payload.type === "state") render(payload.data); });
  socket.addEventListener("close", () => { $("#connection-badge").hidden = false; setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(15_000, reconnectDelay * 1.7); });
}

fit();
addEventListener("resize", fit);
addEventListener("pointerdown", () => audio().resume(), { once: true });
setInterval(updateClocks, 250);
const mock = params.get("mock");
if (["lobby-first", "lobby", "round", "round12", "vote", "reveal", "reveal2", "reveal-miss", "newround"].includes(mock)) render(mockState(mock));
else connect();
