import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, estimateTokens, safeRelPath, readJsonSafe, readTextSafe, stableStringify } from "../src/util.mjs";
import { readLock } from "../src/lock.mjs";

// Test temp dirs: track every mkdtempSync dir and remove them all in after(),
// or a day of test runs fills /tmp (512M tmpfs) and later runs fail with ENOSPC.
const tempDirs = [];
const mkTemp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

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
  const dir = mkTemp("rp-");
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

// A cloned project can link its files to a device that never ends: reading one would hang and fill the memory.
const devZero = process.platform !== "win32" && existsSync("/dev/zero");

test("readTextSafe reads regular files of a sane size and nothing else", { skip: !devZero && "needs /dev/zero" }, () => {
  const dir = mkTemp("repotify-util-");
  writeFileSync(join(dir, "a.txt"), "hello");
  assert.deepEqual(readTextSafe(join(dir, "a.txt")), { ok: true, text: "hello" });
  assert.equal(readTextSafe(join(dir, "a.txt"), { maxBytes: 3 }).error.code, "EFBIG");
  symlinkSync("/dev/zero", join(dir, "zero.json"));
  assert.equal(readTextSafe(join(dir, "zero.json")).error.code, "ENOTFILE");
  assert.equal(readJsonSafe(join(dir, "zero.json")).ok, false);
  assert.equal(readTextSafe(join(dir, "missing")).ok, false);
  assert.equal(readTextSafe(dir).error.code, "ENOTFILE");
});

test("a lock file linked to a device is read as no lock instead of hanging", { skip: !devZero && "needs /dev/zero" }, () => {
  const dir = mkTemp("repotify-util-");
  symlinkSync("/dev/zero", join(dir, "repotify.lock.json"));
  assert.deepEqual(readLock(dir), { version: 1, catalogVersion: null, items: {} });
});
