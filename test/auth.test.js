import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadTokens, refresh } from "../src/auth.js";

test("refresh exchanges and securely persists a replacement Twitch token", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sus-word-auth-"));
  const tokenPath = join(directory, ".tokens.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let request;

  const tokens = await refresh({
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenPath,
    tokens: { access_token: "expired", refresh_token: "old-refresh" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        access_token: "fresh",
        refresh_token: "new-refresh",
        expires_in: 14_400,
        scope: ["user:read:chat"],
        token_type: "bearer",
      }), { status: 200 });
    },
  });

  assert.equal(request.url, "https://id.twitch.tv/oauth2/token");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.body.get("grant_type"), "refresh_token");
  assert.equal(request.options.body.get("refresh_token"), "old-refresh");
  assert.equal(tokens.access_token, "fresh");
  assert.equal(tokens.refresh_token, "new-refresh");
  assert.equal((await loadTokens({ tokenPath })).access_token, "fresh");
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
});
