import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canControl, parseCommand, parseVoteMessage } from "../src/commands.js";

describe("parseCommand", () => {
  test("parses player commands case-insensitively", () => {
    assert.deepEqual(parseCommand(" !JOIN "), { type: "join" });
    assert.deepEqual(parseCommand("!leave"), { type: "leave" });
    assert.deepEqual(parseCommand("!claim k7q2"), { type: "claim", code: "K7Q2" });
    assert.deepEqual(parseCommand("!join k7q2"), {
      type: "claim",
      code: "K7Q2",
      joinCommand: true,
    });
    assert.deepEqual(parseCommand("!vote @Some_Name"), {
      type: "vote",
      target: "some_name",
    });
    assert.deepEqual(parseCommand("!accuse @Some_Name Candles"), {
      type: "accuse",
      target: "some_name",
      word: "candles",
    });
  });

  test("recognizes friendly join aliases and all number-vote forms", () => {
    assert.deepEqual(parseCommand(" join  "), { type: "joinAlias" });
    assert.deepEqual(parseCommand("IJoin"), { type: "joinAlias" });
    for (const text of ["2", "#2", "!2", "!vote 2", "!vote #2"]) {
      assert.deepEqual(parseVoteMessage(text), { type: "vote", number: 2, voteMessage: true });
      assert.deepEqual(parseCommand(text), { type: "vote", number: 2, voteMessage: true });
    }
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
      "!vote bad-name", "!accuse name", "!accuse bad-name candle",
      "!sus reset", "!sus start now", "",
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
