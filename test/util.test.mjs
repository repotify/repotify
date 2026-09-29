import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, estimateTokens, safeRelPath, readJsonSafe, stableStringify } from "../src/util.mjs";

test("sha256 matches the known vector", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("estimateTokens is conservative (chars / 3.5, rounded up)", () => {
  assert.equal(estimateTokens("a".repeat(35)), 10);
  assert.equal(estimateTokens(""), 0);
});

test("safeRelPath rejects traversal, absolute, backslash and NUL paths", () => {
  assert.equal(safeRelPath("../x"), null);
  assert.equal(safeRelPath("a/../../x"), null);
  assert.equal(safeRelPath("/etc/passwd"), null);
  assert.equal(safeRelPath("a\\b"), null);
  assert.equal(safeRelPath("a\0b"), null);
  assert.equal(safeRelPath(""), null);
  assert.equal(safeRelPath("C:/x"), null);
  assert.equal(safeRelPath("a/./b"), "a/b");
  assert.equal(safeRelPath("scripts/run.py"), "scripts/run.py");
});

test("readJsonSafe tolerates a BOM and reports invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-"));
  writeFileSync(join(dir, "a.json"), "\uFEFF{\"x\":1}");
  writeFileSync(join(dir, "b.json"), "{nope");
  assert.deepEqual(readJsonSafe(join(dir, "a.json")), { ok: true, value: { x: 1 } });
  const bad = readJsonSafe(join(dir, "b.json"));
  assert.equal(bad.ok, false);
  assert.equal(readJsonSafe(join(dir, "missing.json")).ok, false);
});

test("stableStringify sorts keys and ends with a newline", () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3] } }), '{\n  "a": {\n    "c": [\n      3\n    ],\n    "d": 2\n  },\n  "b": 1\n}\n');
});
