import test from "node:test";
import assert from "node:assert/strict";
import { strip, visibleLen } from "../src/ansi";

test("visibleLen strips ANSI escape sequences", () => {
  assert.equal(visibleLen("\x1b[32mCtx\x1b[0m 12%"), 7);
});

test("strip removes OSC hyperlinks before grapheme clipping", () => {
  assert.equal(strip("\x1b]8;;https://example.com\x07中文\x1b]8;;\x07"), "中文");
});

test("visibleLen measures terminal columns for CJK, emoji and combining marks", () => {
  for (const [input, want] of [
    ["中文", 4], ["e\u0301", 1], ["😀", 2], ["👩‍💻", 2], ["🇬🇧", 2],
    ["👍🏽", 2], ["1️⃣", 2], ["\x1b[32m你好👩‍💻\x1b[0m", 6]
  ] as const) {
    assert.equal(visibleLen(input), want, input);
  }
});

test("recent emoji sequences and extended combining marks use display columns", () => {
  for (const [input, want] of [["🫨", 2], ["🫠", 2], ["🪿", 2], ["🧑🏽‍💻", 2], ["e\u1ab0", 1], ["a\u200db", 2]] as const) {
    assert.equal(visibleLen(input), want, input);
  }
});
