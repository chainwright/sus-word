import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CATEGORIES, WORDS, findWord } from "../src/words.js";

describe("word catalog", () => {
  test("contains more than 300 unique, categorized, valid words", () => {
    assert.ok(WORDS.length > 300);
    assert.equal(new Set(WORDS.map(({ word }) => word)).size, WORDS.length);
    assert.ok(CATEGORIES.length > 1);

    for (const entry of WORDS) {
      assert.match(entry.word, /^[a-z]{4,9}$/);
      assert.ok(CATEGORIES.includes(entry.category));
    }
  });
});

describe("findWord", () => {
  test("finds a whole word case-insensitively and returns its source range", () => {
    assert.deepEqual(findWord("Well, CANDLE light sounds cozy", "candle"), {
      hit: true,
      index: 6,
      length: 6,
    });
  });

  test("accepts the allowed plural forms", () => {
    assert.deepEqual(findWord("Those candles look nice", "candle"), {
      hit: true,
      index: 6,
      length: 7,
    });
    assert.deepEqual(findWord("The brushes need cleaning", "brush"), {
      hit: true,
      index: 4,
      length: 7,
    });
  });

  test("accepts straight and curly possessives", () => {
    assert.equal(findWord("The candle's flame flickered", "candle").hit, true);
    assert.equal(findWord("That candle’s flame flickered", "candle").hit, true);
  });

  test("replaces a final y with ies", () => {
    assert.deepEqual(findWord("Fresh berries taste amazing", "berry"), {
      hit: true,
      index: 6,
      length: 7,
    });
  });

  test("rejects partial words", () => {
    assert.equal(findWord("That candlelight feels cozy", "candle").hit, false);
    assert.equal(findWord("My scandle test failed", "candle").hit, false);
    assert.equal(findWord("That écandle typo looks odd", "candle").hit, false);
  });

  test("ignores commands, including commands with leading whitespace", () => {
    assert.equal(findWord("!say the candle now", "candle").hit, false);
    assert.equal(findWord("   !say the candle now", "candle").hit, false);
  });

  test("requires a sentence of at least three word tokens", () => {
    assert.equal(findWord("candle", "candle").hit, false);
    assert.equal(findWord("a candle", "candle").hit, false);
    assert.equal(findWord("A candle burns", "candle").hit, true);
  });

  test("reports a miss consistently", () => {
    assert.deepEqual(findWord("There is nothing hidden here", "candle"), {
      hit: false,
      index: -1,
      length: 0,
    });
    assert.deepEqual(findWord(null, "candle"), {
      hit: false,
      index: -1,
      length: 0,
    });
  });
});
