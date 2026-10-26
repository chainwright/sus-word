import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canControl, parseCommand } from "../src/commands.js";

describe("parseCommand", () => {
  test("parses player commands case-insensitively", () => {
    assert.deepEqual(parseCommand(" !JOIN "), { type: "join" });
    assert.deepEqual(parseCommand("!leave"), { type: "leave" });
    assert.deepEqual(parseCommand("!claim k7q2"), { type: "claim", code: "K7Q2" });
    assert.deepEqual(parseCommand("!vote @Some_Name"), {
      type: "vote",
      target: "some_name",
    });
  });

  test("parses host controls and leaves help open to everyone", () => {
    for (const action of ["start", "go", "vote", "next", "end"]) {
      assert.deepEqual(parseCommand(`!sus ${action}`), {
        type: "sus",
        action,
        requiresControl: true,
      });
    }
    assert.deepEqual(parseCommand("!sus help"), {
      type: "sus",
      action: "help",
      requiresControl: false,
    });
  });

  test("rejects malformed and unrelated chat", () => {
    for (const text of [
      "hello", "!join now", "!claim O123", "!claim ABC", "!vote",
      "!vote bad-name", "!sus reset", "!sus start now", "",
    ]) {
      assert.equal(parseCommand(text), null);
    }
  });
});

describe("canControl", () => {
  test("allows broadcasters and moderators", () => {
    assert.equal(canControl({ isBroadcaster: true }), true);
    assert.equal(canControl({ isModerator: true }), true);
    assert.equal(canControl({}), false);
  });
});
