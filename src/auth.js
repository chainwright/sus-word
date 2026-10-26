import "dotenv/config";

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const AUTH_SCOPES = Object.freeze([
  "user:read:chat",
  "user:write:chat",
  "user:bot",
  "channel:bot",
]);

export const REDIRECT_URI = "http://localhost:3000/auth/callback";

function tokenPath(path) {
  return path ?? resolve(process.cwd(), ".tokens.json");
}

async function responseJson(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    throw new Error(body.message ?? `Twitch OAuth returned ${response.status}`);
  }
  return body;
}

export async function loadTokens(options = {}) {
  const contents = await readFile(tokenPath(options.tokenPath), "utf8");
  return JSON.parse(contents);
}

export async function saveTokens(tokens, options = {}) {
  const savedAt = Date.now();
  const stored = {
    ...tokens,
    saved_at: savedAt,
    expires_at: tokens.expires_in ? savedAt + tokens.expires_in * 1_000 : null,
  };
  const path = tokenPath(options.tokenPath);
  await writeFile(
    path,
    `${JSON.stringify(stored, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return stored;
}

export async function refresh(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientId = options.clientId ?? process.env.TWITCH_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.TWITCH_CLIENT_SECRET;
  const current = options.tokens ?? await loadTokens(options);
  if (!clientId || !clientSecret || !current.refresh_token) {
    throw new Error("Cannot refresh Twitch auth without client credentials and a refresh token");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  });
  const response = await fetchImpl("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const next = await responseJson(response);
  return saveTokens({
    ...current,
    ...next,
    refresh_token: next.refresh_token ?? current.refresh_token,
  }, options);
}

async function exchangeCode(code, options) {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  const response = await options.fetchImpl("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return responseJson(response);
}

async function authorizedLogin(accessToken, fetchImpl) {
  const response = await fetchImpl("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const validation = await responseJson(response);
  return validation.login;
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", () => {});
}

export async function runAuth(options = {}) {
  const clientId = options.clientId ?? process.env.TWITCH_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.TWITCH_CLIENT_SECRET;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!clientId || !clientSecret) {
    throw new Error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env first");
  }

  const state = randomBytes(24).toString("base64url");
  const authorizeUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: AUTH_SCOPES.join(" "),
    state,
  });

  const login = await new Promise((resolveLogin, rejectLogin) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, REDIRECT_URI);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }

      try {
        if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
        const code = url.searchParams.get("code");
        const oauthError = url.searchParams.get("error_description")
          ?? url.searchParams.get("error");
        if (oauthError) throw new Error(oauthError);
        if (!code) throw new Error("Twitch did not return an authorization code");
        const tokens = await exchangeCode(code, { clientId, clientSecret, fetchImpl });
        const stored = await saveTokens(tokens, options);
        const authorized = await authorizedLogin(stored.access_token, fetchImpl);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h1>Sus Word authorized</h1><p>You can close this tab.</p>");
        server.close();
        resolveLogin(authorized);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`Authorization failed: ${error.message}`);
        server.close();
        rejectLogin(error);
      }
    });
    server.on("error", rejectLogin);
    server.listen(3000, "127.0.0.1", () => {
      console.log(`Open this URL to authorize Sus Word:\n${authorizeUrl}`);
      openBrowser(authorizeUrl.toString());
    });
  });

  console.log(`Authorized Twitch login: ${login}`);
  return login;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runAuth().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
