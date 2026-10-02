import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetry, validateEvent, EVENT_TYPES, NOTICE, NOTICE_DETAILS, MAX_QUEUE } from "../src/telemetry.mjs";
import { TELEMETRY_ENDPOINT } from "../src/config.mjs";

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

const NOW = new Date("2026-09-28T12:00:00Z");
const home = () => mkTemp("rp-tel-");
const envFor = (dir, extra = {}) => ({ REPOTIFY_HOME: dir, ...extra });
const queueLines = (dir) => (existsSync(join(dir, "queue.jsonl")) ? readFileSync(join(dir, "queue.jsonl"), "utf8").trim().split("\n").filter(Boolean) : []);

test("the built-in endpoint stays disabled until the analytics backend is configured", () => {
  assert.equal(TELEMETRY_ENDPOINT, null);
});

test("event types and schema reject anything that could identify code or people", () => {
  assert.deepEqual(EVENT_TYPES, ["run", "shown", "selected", "installed", "kept7d", "removed", "vote"]);
  const ok = { type: "shown", ts: NOW.toISOString(), installId: "123e4567-e89b-42d3-a456-426614174000", agent: "claude-code", version: "0.1.0", items: ["graphify", "pdf"], stacks: ["nextjs"], needs: ["pdf"] };
  assert.deepEqual(validateEvent(ok), []);
  assert.ok(validateEvent({ ...ok, repoName: "secret-project" }).some((e) => e.includes("repoName")));
  assert.ok(validateEvent({ ...ok, items: ["../etc"] }).length > 0);
  assert.ok(validateEvent({ ...ok, type: "keystroke" }).length > 0);
  assert.ok(validateEvent({ ...ok, installId: "me@example.com" }).length > 0);
  assert.ok(validateEvent({ ...ok, items: Array.from({ length: 51 }, (_, i) => `id-${i}`) }).length > 0);
  assert.ok(validateEvent({ ...ok, type: "vote", item: "pdf", vote: "maybe" }).length > 0);
  assert.deepEqual(validateEvent({ ...ok, type: "vote", items: undefined, item: "pdf", vote: "up" }), []);
});

test("events are queued locally and nothing is sent while the endpoint is null", async () => {
  const dir = home();
  let called = 0;
  const t = createTelemetry({ env: envFor(dir), fetchImpl: async () => { called++; }, now: NOW, version: "0.1.0" });
  assert.equal(t.enabled, true);
  assert.equal(t.track({ type: "run", agent: "claude-code" }), true);
  assert.equal(t.track({ type: "shown", agent: "claude-code", items: ["pdf"] }), true);
  const r = await t.flush();
  assert.deepEqual(r, { sent: 0, queued: 2 });
  assert.equal(called, 0);
  const first = JSON.parse(queueLines(dir)[0]);
  assert.match(first.installId, /^[0-9a-f-]{36}$/);
  assert.equal(first.ts, NOW.toISOString());
});

test("DO_NOT_TRACK, NO_ANALYTICS and REPOTIFY_TELEMETRY=0 turn everything off, including the install id", () => {
  for (const extra of [{ DO_NOT_TRACK: "1" }, { NO_ANALYTICS: "1" }, { REPOTIFY_TELEMETRY: "0" }]) {
    const dir = home();
    const t = createTelemetry({ env: envFor(dir, extra), now: NOW });
    assert.equal(t.enabled, false);
    assert.equal(t.track({ type: "run", agent: "cursor" }), false);
    assert.equal(t.noticeNeeded(), false);
    assert.deepEqual(queueLines(dir), []);
    assert.equal(existsSync(join(dir, "config.json")), false);
  }
});

test("setEnabled(false) persists the opt-out", () => {
  const dir = home();
  createTelemetry({ env: envFor(dir), now: NOW }).setEnabled(false);
  assert.equal(createTelemetry({ env: envFor(dir), now: NOW }).enabled, false);
});

test("invalid events are dropped, not queued", () => {
  const dir = home();
  const t = createTelemetry({ env: envFor(dir), now: NOW });
  assert.equal(t.track({ type: "shown", agent: "claude-code", items: ["pdf"], filePath: "/home/me/x" }), false);
  assert.deepEqual(queueLines(dir), []);
});

test("the queue is bounded", () => {
  const dir = home();
  const lines = Array.from({ length: MAX_QUEUE + 5 }, () => JSON.stringify({ type: "run" })).join("\n") + "\n";
  writeFileSync(join(dir, "queue.jsonl"), lines);
  createTelemetry({ env: envFor(dir), now: NOW }).track({ type: "run", agent: "codex" });
  assert.equal(queueLines(dir).length, MAX_QUEUE);
});

test("the one-time notice is the frozen FAZ 0 text; details explain what is and is not collected", () => {
  const dir = home();
  const t = createTelemetry({ env: envFor(dir), now: NOW });
  assert.equal(t.noticeNeeded(), true);
  t.markNoticeShown();
  assert.equal(createTelemetry({ env: envFor(dir), now: NOW }).noticeNeeded(), false);
  // DL-009: exact wording frozen at FAZ 0 — a single line.
  assert.equal(NOTICE, "Repotify measures which skills actually work and shares anonymous usage counts to improve recommendations. Turn off any time: `repotify telemetry off`.");
  assert.equal(NOTICE.split("\n").length, 1, "the notice is one line");
  assert.match(NOTICE_DETAILS, /never/i);
  assert.match(NOTICE_DETAILS, /REPOTIFY_TELEMETRY=0/);
  assert.match(NOTICE_DETAILS, /repotify sync/);
});

test("a self-hosted endpoint receives batches and the queue is cleared on success", async () => {
  const dir = home();
  const bodies = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://stats.example.org/v1/events");
    bodies.push(JSON.parse(init.body));
    return new Response(null, { status: 202 });
  };
  const t = createTelemetry({ env: envFor(dir, { REPOTIFY_TELEMETRY_URL: "https://stats.example.org" }), fetchImpl, now: NOW });
  t.track({ type: "run", agent: "claude-code" });
  t.track({ type: "installed", agent: "claude-code", items: ["pdf"] });
  assert.deepEqual(await t.flush(), { sent: 2, queued: 0 });
  assert.equal(bodies[0].events.length, 2);
  assert.deepEqual(queueLines(dir), []);
  const failing = createTelemetry({ env: envFor(dir, { REPOTIFY_TELEMETRY_URL: "https://stats.example.org" }), fetchImpl: async () => { throw new Error("offline"); }, now: NOW });
  failing.track({ type: "run", agent: "claude-code" });
  assert.deepEqual(await failing.flush(), { sent: 0, queued: 1 });
});
