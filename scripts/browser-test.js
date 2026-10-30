import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";

import Game from "../src/game.js";
import { createSusWordServer } from "../src/server.js";

const OVERLAY_MOCKS = [
  "lobby-first", "lobby", "round", "round12", "vote",
  "reveal", "reveal2", "reveal-voice", "reveal-miss", "champion", "newround",
];
const CARD_MOCKS = [
  "join", "join-wrong", "claim", "imposter", "imposter-2", "delivered", "busted",
  "detective", "vote", "reveal-hold", "result", "champion", "side", "featured",
];

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Chrome was not found. Set CHROME_PATH to a Chrome or Chromium executable.");
  return found;
}

function launchChrome(executable, profile) {
  const child = spawn(executable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = new Promise((resolve, reject) => {
    let diagnostics = "";
    const timeout = setTimeout(() => reject(new Error(`Chrome did not expose DevTools within 10 seconds. ${diagnostics}`)), 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
      const match = diagnostics.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (${signal || code}). ${diagnostics}`));
    });
    child.once("error", reject);
  });
  return { child, endpoint };
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      const key = `${message.sessionId || "root"}:${message.method}`;
      for (const listener of this.listeners.get(key) || []) listener(message.params || {});
    });
  }

  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new DevTools(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, sessionId, listener) {
    const key = `${sessionId || "root"}:${method}`;
    const listeners = this.listeners.get(key) || [];
    listeners.push(listener);
    this.listeners.set(key, listeners);
  }

  once(method, sessionId, timeoutMs = 10_000) {
    const key = `${sessionId || "root"}:${method}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const listener = (params) => {
        clearTimeout(timeout);
        const listeners = this.listeners.get(key) || [];
        this.listeners.set(key, listeners.filter((candidate) => candidate !== listener));
        resolve(params);
      };
      const listeners = this.listeners.get(key) || [];
      listeners.push(listener);
      this.listeners.set(key, listeners);
    });
  }
}

async function evaluate(devtools, sessionId, expression) {
  const response = await devtools.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  return response.result?.value;
}

const OVERLAY_LAYOUT_CHECK = String.raw`(async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const visible = (element) => element && !element.hidden
    && getComputedStyle(element).display !== "none" && element.getClientRects().length > 0;
  const failures = [];
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: Math.round(rect.left * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
    };
  };
  const fail = (check, element, detail = "") => failures.push({
    check,
    element: element.id ? "#" + element.id : "." + [...element.classList].join("."),
    detail,
    box: box(element),
  });
  const board = document.querySelector("#board");
  if (!visible(board)) failures.push({ check: "visibility", element: "#board", detail: "board is not visible" });
  if (visible(board)) {
    const boardRect = board.getBoundingClientRect();
    const cells = board.querySelectorAll(".board-head,.hint,.player-row,.board-note:not([hidden]),.leaderboard");
    for (const cell of cells) {
      if (!visible(cell)) continue;
      const rect = cell.getBoundingClientRect();
      if (rect.left < boardRect.left - 1 || rect.right > boardRect.right + 1) fail("board-bounds", cell, "cell escapes the board");
      if (cell.scrollWidth > cell.clientWidth + 1) fail("horizontal-overflow", cell);
      if (cell.scrollHeight > cell.clientHeight + 1) fail("vertical-overflow", cell);
    }
    for (const name of board.querySelectorAll(".player-name")) {
      if (name.scrollWidth > name.clientWidth + 1) fail("player-name-clipped", name, name.textContent);
      if (name.scrollHeight > name.clientHeight + 1) fail("player-name-vertical-clipped", name, name.textContent);
      const voteLabel = name.closest(".vote-row")?.querySelector(".vote-count");
      if (visible(voteLabel)) {
        const nameRect = name.getBoundingClientRect();
        const voteRect = voteLabel.getBoundingClientRect();
        const overlaps = nameRect.left < voteRect.right && nameRect.right > voteRect.left
          && nameRect.top < voteRect.bottom && nameRect.bottom > voteRect.top;
        if (overlaps) fail("player-name-vote-overlap", name, name.textContent + " overlaps " + voteLabel.textContent);
      }
      const bustedLabel = name.closest(".player-row")?.querySelector(".busted-mini");
      if (visible(bustedLabel)) {
        const nameRect = name.getBoundingClientRect();
        const bustedRect = bustedLabel.getBoundingClientRect();
        const overlaps = nameRect.left < bustedRect.right && nameRect.right > bustedRect.left
          && nameRect.top < bustedRect.bottom && nameRect.bottom > bustedRect.top;
        if (overlaps) fail("player-name-busted-overlap", name, name.textContent + " overlaps " + bustedLabel.textContent);
      }
    }
  }
  for (const stamp of document.querySelectorAll(".verdict.miss")) {
    if (getComputedStyle(stamp).whiteSpace !== "nowrap") fail("miss-stamp-wrap", stamp);
    if (stamp.scrollWidth > stamp.clientWidth + 1) fail("miss-stamp-clipped", stamp);
  }
  for (const caption of document.querySelectorAll(".reveal-caption")) {
    if (!visible(caption)) continue;
    const card = caption.closest(".case-card");
    const captionRect = caption.getBoundingClientRect();
    const cardRect = card?.getBoundingClientRect();
    if (caption.scrollWidth > caption.clientWidth + 1 || caption.scrollHeight > caption.clientHeight + 1) {
      fail("reveal-caption-overflow", caption, caption.textContent);
    }
    if (cardRect && (captionRect.left < cardRect.left - 1 || captionRect.right > cardRect.right + 1
      || captionRect.top < cardRect.top - 1 || captionRect.bottom > cardRect.bottom + 1)) {
      fail("reveal-caption-card-overflow", caption, caption.textContent);
    }
    const verdict = card?.querySelector(".verdict");
    if (visible(verdict)) {
      const verdictRect = verdict.getBoundingClientRect();
      const overlaps = captionRect.left < verdictRect.right && captionRect.right > verdictRect.left
        && captionRect.top < verdictRect.bottom && captionRect.bottom > verdictRect.top;
      if (overlaps) fail("reveal-caption-verdict-overlap", caption, caption.textContent);
    }
  }
  if (new URLSearchParams(location.search).get("mock") === "champion") {
    const panel = document.querySelector(".champion-moment");
    const revealArea = document.querySelector("#camera-dim");
    if (!visible(panel)) failures.push({ check: "champion-moment-missing", element: ".champion-moment" });
    else if (visible(revealArea) && panel.getBoundingClientRect().width < revealArea.getBoundingClientRect().width * .9) {
      fail("champion-moment-too-narrow", panel, "champion card must fill the lower camera area");
    }
  }
  const query = new URLSearchParams(location.search);
  if (query.get("frame") === "preleaders") {
    const cards = [...document.querySelectorAll(".reveal-cases .case-card")].filter(visible);
    if (!cards.length) failures.push({
      check: "reveal-case-missing",
      element: ".reveal-cases .case-card",
      detail: "the pre-leader frame must keep its case card visible",
    });
    for (const card of cards) {
      if (!visible(card)) continue;
      if (card.closest(".reveal-cases")?.classList.contains("shrunk") || card.getBoundingClientRect().height < 100) {
        fail("reveal-case-collapsed", card, "case card must remain readable before the leaders panel");
      }
    }
  }
  if (query.get("frame") === "busted") {
    const labels = [...document.querySelectorAll(".player-row .busted-mini")].filter(visible);
    if (!labels.length) failures.push({
      check: "busted-state-missing",
      element: ".player-row .busted-mini",
      detail: "the caught-player state must remain visible in this phase",
    });
    for (const label of labels) {
      if (label.textContent.trim() !== "BUSTED") fail("busted-copy", label, label.textContent);
      if (parseFloat(getComputedStyle(label).fontSize) < 21) fail("busted-label-too-small", label);
      if (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1) {
        fail("busted-label-overflow", label);
      }
    }
  }
  if (Number(query.get("tables")) > 1) {
    const plate = document.querySelector("#table-plate");
    if (!visible(plate)) failures.push({
      check: "table-plate-missing",
      element: "#table-plate",
      detail: "a multi-table overlay must identify the featured table",
    });
  }
  return failures;
})()`;

const SETTLE_PAGE = String.raw`(async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`;

const CARD_LAYOUT_CHECK = String.raw`(async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const failures = [];
  for (const title of document.querySelectorAll(".card-phase")) {
    if (getComputedStyle(title).textOverflow === "ellipsis" || title.scrollWidth > title.clientWidth + 1) {
      failures.push({ check: "card-header-clipped", element: ".card-phase", detail: title.textContent });
    }
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    failures.push({ check: "card-horizontal-overflow", element: "html" });
  }
  if (new URLSearchParams(location.search).get("mock") === "busted"
    && document.querySelector(".imposter-tips")) {
    failures.push({ check: "busted-card-tips-visible", element: ".imposter-tips" });
  }
  return failures;
})()`;

const WATCH_LAYOUT_CHECK = String.raw`(async () => {
  await document.fonts.ready;
  const expectReveal = new URLSearchParams(location.search).get("expect") === "reveal";
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const overlayDocument = document.querySelector("#overlay-frame")?.contentDocument;
    const overlayReady = overlayDocument?.readyState === "complete";
    const cardReady = document.querySelector("#card-frame")?.contentDocument?.readyState === "complete";
    const hasChat = document.querySelectorAll(".chat-line").length > 0;
    const hasReveal = document.querySelectorAll(".revealed-impostor").length > 0;
    const phaseBanner = overlayDocument?.querySelector("#phase-strip");
    const phaseDisplay = phaseBanner && phaseBanner.ownerDocument.defaultView.getComputedStyle(phaseBanner).display;
    const hasPhaseBanner = phaseBanner && !phaseBanner.hidden && phaseDisplay !== "none";
    if (overlayReady && cardReady && hasChat && (expectReveal ? hasReveal : hasPhaseBanner)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const failures = [];
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    failures.push({ check: "watch-horizontal-overflow", element: "html" });
  }
  for (const element of document.querySelectorAll(".watch-header,.watch-layout,.stream-frame,.card-column")) {
    const rect = box(element);
    if (rect.left < -1 || rect.right > innerWidth + 1) {
      failures.push({ check: "watch-viewport-overflow", element: "." + [...element.classList].join("."), box: rect });
    }
  }
  for (const element of document.querySelectorAll(".watch-header,.watch-layout,.stream-column,.card-column,.card-heading,.player-switcher,.phone-shell")) {
    if (element.scrollWidth > element.clientWidth + 1) {
      failures.push({ check: "watch-cell-overflow", element: "." + [...element.classList].join("."), box: box(element) });
    }
  }
  const stream = document.querySelector("#stream-frame");
  const streamRect = box(stream);
  if (Math.abs(streamRect.width / streamRect.height - (16 / 9)) > .03) {
    failures.push({ check: "watch-stream-ratio", element: "#stream-frame", box: streamRect });
  }
  const room = document.querySelector(".room-backdrop");
  const roomStyle = getComputedStyle(room);
  const streamStyle = getComputedStyle(stream);
  if (roomStyle.backgroundImage === "none"
    || [roomStyle.backgroundColor, streamStyle.backgroundColor].some((color) => color === "rgb(255, 255, 255)")) {
    failures.push({ check: "watch-stream-blank-white", element: ".room-backdrop" });
  }
  if (!document.querySelector("#overlay-frame")?.contentDocument?.querySelector("#stage")) {
    failures.push({ check: "watch-overlay-missing", element: "#overlay-frame" });
  }
  const overlayFrame = document.querySelector("#overlay-frame");
  const phaseBanner = overlayFrame?.contentDocument?.querySelector("#phase-strip");
  const badge = document.querySelector(".live-pill");
  const phaseDisplay = phaseBanner && phaseBanner.ownerDocument.defaultView.getComputedStyle(phaseBanner).display;
  if (!expectReveal && (!phaseBanner || phaseBanner.hidden || phaseDisplay === "none")) {
    failures.push({ check: "watch-phase-banner-missing", element: "#overlay-frame #phase-strip" });
  } else if (phaseBanner && !phaseBanner.hidden && phaseDisplay !== "none") {
    const iframeRect = box(overlayFrame);
    const nativeRect = phaseBanner.getBoundingClientRect();
    const scaleX = iframeRect.width / overlayFrame.offsetWidth;
    const scaleY = iframeRect.height / overlayFrame.offsetHeight;
    const bannerRect = {
      left: iframeRect.left + nativeRect.left * scaleX,
      top: iframeRect.top + nativeRect.top * scaleY,
      right: iframeRect.left + nativeRect.right * scaleX,
      bottom: iframeRect.top + nativeRect.bottom * scaleY,
    };
    const badgeRect = box(badge);
    const overlaps = badgeRect.left < bannerRect.right && badgeRect.right > bannerRect.left
      && badgeRect.top < bannerRect.bottom && badgeRect.bottom > bannerRect.top;
    if (overlaps) failures.push({ check: "watch-live-badge-phase-overlap", element: ".live-pill", box: badgeRect });
  }
  if (!document.querySelector("#card-frame")?.contentDocument?.querySelector("#card-root")) {
    failures.push({ check: "watch-card-missing", element: "#card-frame" });
  }
  for (const [frameSelector, containerSelector] of [["#overlay-frame", "#stream-frame"], ["#card-frame", "#phone-shell"]]) {
    const frameRect = box(document.querySelector(frameSelector));
    const containerRect = box(document.querySelector(containerSelector));
    if (frameRect.right > containerRect.right + 1 || frameRect.bottom > containerRect.bottom + 1) {
      failures.push({ check: "watch-frame-overflow", element: frameSelector, box: frameRect });
    }
  }
  if (!document.querySelector(".chat-line")) {
    failures.push({ check: "watch-chat-missing", element: "#chat-lines" });
  }
  const revealed = document.querySelectorAll(".revealed-impostor").length;
  if (!expectReveal && revealed) failures.push({ check: "watch-role-leak", element: "#player-switcher" });
  if (expectReveal && !revealed) failures.push({ check: "watch-reveal-marker-missing", element: "#player-switcher" });
  return failures;
})()`;

function liveCardCheck(role, word = "") {
  return `(async () => {
    const deadline = Date.now() + 4000;
    const expectedRole = ${JSON.stringify(role)};
    const expectedWord = ${JSON.stringify(word.toUpperCase())};
    while (Date.now() < deadline) {
      const stamp = document.querySelector(".role-stamp");
      const secret = document.querySelector(".secret-word");
      if (stamp && stamp.textContent.includes(expectedRole)
        && (expectedRole !== "IMPOSTER" || secret?.textContent.trim().toUpperCase() === expectedWord)) {
        const title = document.querySelector(".card-phase");
        return title && (getComputedStyle(title).textOverflow === "ellipsis" || title.scrollWidth > title.clientWidth + 1)
          ? [{ check: "card-header-clipped", element: ".card-phase", detail: title.textContent }]
          : [];
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [{
      check: "live-card-role",
      element: "#card-root",
      detail: expectedRole === "IMPOSTER"
        ? "real demo Imposter card did not show secret word " + expectedWord
        : "real demo Detective card did not render",
    }];
  })()`;
}

function formatFailure(failure) {
  if (typeof failure === "string") return failure;
  const geometry = failure.box ? ` · box ${JSON.stringify(failure.box)}` : "";
  return `${failure.check} on ${failure.element}${failure.detail ? ` · ${failure.detail}` : ""}${geometry}`;
}

async function loadRoute(devtools, sessionId, route, dimensions, checkLayout) {
  const { label, url } = route;
  const errors = [];
  const capture = (check, message) => errors.push({ check, element: "page", detail: message });
  const consoleListener = ({ type, args = [] }) => {
    if (type === "error") capture("console-error", args.map((arg) => arg.value || arg.description || "console error").join(" "));
  };
  const exceptionListener = ({ exceptionDetails = {} }) => capture("uncaught-exception", exceptionDetails.exception?.description || exceptionDetails.text || "uncaught exception");
  const logListener = ({ entry = {} }) => {
    if (entry.level === "error") capture("browser-log-error", entry.text || "browser log error");
  };
  devtools.on("Runtime.consoleAPICalled", sessionId, consoleListener);
  devtools.on("Runtime.exceptionThrown", sessionId, exceptionListener);
  devtools.on("Log.entryAdded", sessionId, logListener);
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: dimensions.width,
    height: dimensions.height,
    deviceScaleFactor: 1,
    mobile: dimensions.mobile || false,
  }, sessionId);
  await devtools.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  }, sessionId);
  const loaded = devtools.once("Page.loadEventFired", sessionId);
  await devtools.send("Page.navigate", { url }, sessionId);
  await loaded;
  const layoutFailures = checkLayout
    ? await evaluate(devtools, sessionId, OVERLAY_LAYOUT_CHECK)
    : (await evaluate(devtools, sessionId, SETTLE_PAGE), []);
  const routeFailures = route.verifyExpression
    ? await evaluate(devtools, sessionId, route.verifyExpression) : [];
  if (errors.length || layoutFailures.length || routeFailures.length) {
    throw new Error(`${label} failed\n${[...errors, ...layoutFailures, ...routeFailures].map((failure) => `  - ${formatFailure(failure)}`).join("\n")}`);
  }
}

function prepareLiveDemoCards(game, count = 4) {
  for (let index = 1; index <= count; index += 1) {
    const login = `demo_card_${index}`;
    const sessionId = `demo-player-session-${String(index).padStart(4, "0")}`;
    const claim = game.createClaim({ sessionId, login });
    game.claim({ code: claim.code, login, userId: `demo-${index}`, simulated: true });
  }
  game.start();
  game.go({ word: "candle", category: "home" });
  const assignment = game.currentRound.impostors[0];
  const impostor = Number(assignment.playerId.replace("demo-", ""));
  const detectivePlayer = [...game.currentRound.roster.values()].find(({ id }) => id !== assignment.playerId);
  game.recordMessage({
    userId: detectivePlayer.id,
    messageId: "watch-demo-chat",
    text: "the rain sounds relaxing tonight",
  });
  return { impostor, detective: Number(detectivePlayer.id.replace("demo-", "")), word: assignment.word };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", exited);
      resolve(false);
    }, timeoutMs);
    function exited() {
      clearTimeout(timeout);
      resolve(true);
    }
    child.once("exit", exited);
  });
}

async function closeChrome(devtools, child) {
  const warnings = [];
  if (devtools) {
    try {
      await Promise.race([
        devtools.send("Browser.close"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Browser.close timed out")), 3_000)),
      ]);
    } catch (error) {
      warnings.push(`Browser.close: ${error.message}`);
    }
  } else child.kill("SIGTERM");
  if (!await waitForExit(child, 3_000)) {
    warnings.push("Chrome did not exit within 3 seconds; sent SIGKILL");
    child.kill("SIGKILL");
    if (!await waitForExit(child, 2_000)) warnings.push("Chrome still did not report an exit after SIGKILL");
  }
  return warnings;
}

async function main() {
  const demoCodes = ["A2B3", "C4D5", "E6F7", "G8H9"];
  const game = new Game({
    random: () => 0,
    codeGenerator: () => demoCodes.shift(),
    durations: {
      round: 60_000,
      categoryHint: 30_000,
      letterHint: 50_000,
      vote: 15_000,
      revealOne: 5_000,
      revealTwo: 5_000,
    },
    words: [{ word: "candle", category: "home" }],
  });
  const service = createSusWordServer({
    game,
    port: 0,
    env: { DEMO_MODE: "1" },
    logger: { log() {}, error() {} },
  });
  const profile = await mkdtemp(join(tmpdir(), "sus-word-browser-"));
  const chrome = launchChrome(chromePath(), profile);
  let devtools;
  let primaryError;
  const cleanupWarnings = [];
  try {
    const address = await service.start();
    devtools = await DevTools.connect(await chrome.endpoint);
    const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
    await Promise.all([
      devtools.send("Page.enable", {}, sessionId),
      devtools.send("Runtime.enable", {}, sessionId),
      devtools.send("Log.enable", {}, sessionId),
    ]);
    const origin = `http://127.0.0.1:${address.port}`;
    const liveCards = prepareLiveDemoCards(game);
    for (const [role, number] of [["IMPOSTER", liveCards.impostor], ["DETECTIVE", liveCards.detective]]) {
      await loadRoute(devtools, sessionId, {
        label: `live demo ${role.toLowerCase()} card`,
        url: `${origin}/card?demo=${number}`,
        verifyExpression: liveCardCheck(role, liveCards.word),
      }, { width: 390, height: 844, mobile: true }, false);
      console.log(`✓ live demo ${role.toLowerCase()} card`);
    }
    for (const dimensions of [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 390, height: 844, mobile: true },
    ]) {
      const size = `${dimensions.width}x${dimensions.height}`;
      await loadRoute(devtools, sessionId, {
        label: `watch round at ${size}`,
        url: `${origin}/watch`,
        verifyExpression: WATCH_LAYOUT_CHECK,
      }, dimensions, false);
      console.log(`✓ watch round at ${size}`);
    }
    game.beginVote();
    game.finishVote();
    await loadRoute(devtools, sessionId, {
      label: "watch reveal role marker at 1280x720",
      url: `${origin}/watch?expect=reveal`,
      verifyExpression: WATCH_LAYOUT_CHECK,
    }, { width: 1280, height: 720 }, false);
    console.log("✓ watch reveal role marker at 1280x720");
    for (const dimensions of [{ width: 854, height: 480 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      const size = `${dimensions.width}x${dimensions.height}`;
      for (const mock of OVERLAY_MOCKS) {
        await loadRoute(devtools, sessionId, {
          label: `overlay ${mock} at ${size}`,
          url: `${origin}/overlay?mock=${mock}`,
        }, dimensions, true);
        console.log(`✓ overlay ${mock} at ${size}`);
      }
      await loadRoute(devtools, sessionId, {
        label: `overlay reveal payoff at ${size}`,
        url: `${origin}/overlay?mock=reveal&frame=payoff`,
      }, dimensions, true);
      console.log(`✓ overlay reveal payoff at ${size}`);
      await loadRoute(devtools, sessionId, {
        label: `overlay voice reveal payoff at ${size}`,
        url: `${origin}/overlay?mock=reveal-voice&frame=payoff`,
      }, dimensions, true);
      console.log(`✓ overlay voice reveal payoff at ${size}`);
      await loadRoute(devtools, sessionId, {
        label: `overlay reveal before leaders at ${size}`,
        url: `${origin}/overlay?mock=reveal&frame=preleaders`,
      }, dimensions, true);
      console.log(`✓ overlay reveal before leaders at ${size}`);
      for (const phase of ["round", "vote", "reveal"]) {
        await loadRoute(devtools, sessionId, {
          label: `overlay ${phase} BUSTED row at ${size}`,
          url: `${origin}/overlay?mock=${phase}&frame=busted`,
        }, dimensions, true);
        console.log(`✓ overlay ${phase} BUSTED row at ${size}`);
      }
      await loadRoute(devtools, sessionId, {
        label: `overlay featured table plate at ${size}`,
        url: `${origin}/overlay?mock=round&tables=3`,
      }, dimensions, true);
      console.log(`✓ overlay featured table plate at ${size}`);
    }
    for (const mock of CARD_MOCKS) {
      await loadRoute(devtools, sessionId, {
        label: `card ${mock}`,
        url: `${origin}/card?mock=${mock}`,
        verifyExpression: CARD_LAYOUT_CHECK,
      }, { width: 390, height: 844, mobile: true }, false);
      console.log(`✓ card ${mock}`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      cleanupWarnings.push(...await closeChrome(devtools, chrome.child));
    } catch (error) {
      cleanupWarnings.push(`Chrome cleanup: ${error.message}`);
    }
    try {
      service.game.reset();
      await service.stop();
    } catch (error) {
      cleanupWarnings.push(`server cleanup: ${error.message}`);
    }
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      cleanupWarnings.push(`profile cleanup: ${error.message}`);
    }
  }
  if (primaryError) {
    primaryError.cleanupWarnings = cleanupWarnings;
    throw primaryError;
  }
  for (const warning of cleanupWarnings) console.warn(`Cleanup warning: ${warning}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  for (const warning of error.cleanupWarnings || []) console.warn(`Cleanup warning: ${warning}`);
  process.exitCode = 1;
});
