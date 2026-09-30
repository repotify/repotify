import { test } from "node:test";
import assert from "node:assert/strict";
import { shownName } from "../src/display.mjs";

test("plain names print as they are", () => {
  for (const s of ["pptx", ".claude/skills/pdf-export", "react-native-skills", "a_b.c@1+2"]) assert.equal(shownName(s), s);
});

test("anything else is single-quoted for a shell, and a quote inside is closed and reopened", () => {
  assert.equal(shownName("my skill"), "'my skill'");
  assert.equal(shownName("a;b"), "'a;b'");
  assert.equal(shownName("$(id)"), "'$(id)'");
  assert.equal(shownName("it's"), "'it'\\''s'");
});

test("terminal control, invisible and bidi characters are escaped, never printed raw", () => {
  const out = [shownName("red\u001b[31mtext"), shownName("csi\u009bx"), shownName("gnp.\u202eexe"), shownName("zero\u200bwidth")];
  for (const s of out) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u200b\u202e]/.test(s), JSON.stringify(s));
  assert.equal(out[0], "'red\\u{1B}[31mtext'");
  assert.equal(out[1], "'csi\\u{9B}x'");
});
