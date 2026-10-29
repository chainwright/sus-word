import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("browser checks and push CI stay wired independently of npm test", async () => {
  const root = new URL("../", import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const workflow = await readFile(new URL(".github/workflows/test.yml", root), "utf8");
  const browserCheck = await readFile(new URL("scripts/browser-test.js", root), "utf8");
  const readme = await readFile(new URL("README.md", root), "utf8");
  assert.equal(packageJson.scripts.test, "node --test test/*.test.js");
  assert.equal(packageJson.scripts["test:browser"], "node scripts/browser-test.js");
  assert.match(workflow, /^\s*push:/m);
  assert.match(workflow, /run: npm test/);
  assert.match(readme, /actions\/workflows\/test\.yml\/badge\.svg/);
  assert.match(readme, /npm run test:browser/);
  assert.match(browserCheck, /waitForExit\(child, 3_000\)/);
  assert.match(browserCheck, /child\.kill\("SIGKILL"\)/);
  assert.match(browserCheck, /maxRetries: 8, retryDelay: 100/);
  assert.match(browserCheck, /primaryError\.cleanupWarnings = cleanupWarnings/);
  assert.match(browserCheck, /player-name-vertical-clipped/);
  assert.match(browserCheck, /player-name-vote-overlap/);
  assert.match(browserCheck, /width: 1920, height: 1080/);
});
