import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";

import { createSusWordServer } from "../src/server.js";

const OVERLAY_MOCKS = [
  "lobby-first", "lobby", "round", "round12", "vote",
  "reveal", "reveal2", "reveal-miss", "champion", "newround",
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
  if (errors.length || layoutFailures.length) {
    throw new Error(`${label} failed\n${[...errors, ...layoutFailures].map((failure) => `  - ${formatFailure(failure)}`).join("\n")}`);
  }
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
  const service = createSusWordServer({
    port: 0,
    env: {},
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
    for (const dimensions of [{ width: 854, height: 480 }, { width: 1920, height: 1080 }]) {
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
