import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { voteDue, keptEvents } from "../src/feedback.mjs";
import { fetchCommunity, mergeCommunity } from "../pipeline/community.mjs";

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

const DAY = 86400000;
const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test("voting is due at most once a week", () => {
  assert.equal(voteDue({}, NOW), true);
  assert.equal(voteDue({ lastVoteAskAt: ago(6) }, NOW), false);
  assert.equal(voteDue({ lastVoteAskAt: ago(7) }, NOW), true);
});

test("kept7d is reported once per item installed at least a week ago", () => {
  const lock = { items: { a: { installedAt: ago(8) }, b: { installedAt: ago(2) }, repotify: { type: "self", installedAt: ago(30) } } };
  const first = keptEvents(lock, {}, NOW);
  assert.deepEqual(first.events, [{ type: "kept7d", items: ["a"] }]);
  assert.deepEqual(first.reported, ["a"]);
  assert.deepEqual(keptEvents(lock, { keptReported: first.reported }, NOW).events, []);
});

test("community stats merge into items; missing stats leave items unchanged", async () => {
  const items = [{ id: "pdf", community: { shown: 0 } }, { id: "other", community: { shown: 3 } }];
  const stats = { items: { pdf: { shown: 10, selected: 4, installed: 4, kept7d: 3, removed: 1, up: 3, down: 1 } } };
  const merged = mergeCommunity(items, stats);
  assert.deepEqual(merged[0].community, { shown: 10, selected: 4, kept7d: 3, removed: 1, rating: 0.75, votes: 4 });
  assert.deepEqual(merged[1].community, { shown: 3 });
  assert.equal(mergeCommunity(items, null), items);
  const ok = await fetchCommunity({ url: "https://s.test/v1/stats", fetchImpl: async () => new Response(JSON.stringify(stats)) });
  assert.deepEqual(ok, stats);
  assert.equal(await fetchCommunity({ url: "https://s.test/v1/stats", fetchImpl: async () => { throw new Error("down"); } }), null);
  assert.equal(await fetchCommunity({ url: "https://s.test/v1/stats", fetchImpl: async () => new Response("x", { status: 500 }) }), null);
});

const bin = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/projects/nextjs-saas", import.meta.url));
const run = (home, args, extra = {}, cwd = fixture) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, REPOTIFY_HOME: home, REPOTIFY_OFFLINE: "1", REPOTIFY_TELEMETRY: "", DO_NOT_TRACK: "", ...extra } });
const queue = (home) => (existsSync(join(home, "queue.jsonl")) ? readFileSync(join(home, "queue.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const stage0 = (home) => (existsSync(join(home, "stage0.jsonl")) ? readFileSync(join(home, "stage0.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("CLI: recommend logs a Stage 0 recommendation episode, vote records a vote, and nothing is sent", () => {
  const home = mkTemp("rp-cli-tel-");
  assert.equal(run(home, ["recommend"]).status, 0);
  const rec = stage0(home).find((e) => e.type === "recommendation");
  assert.ok(rec, "recommendation episode logged in Stage 0 format");
  assert.ok(rec.candidates.length > 0);
  assert.ok(rec.candidates.every((c) => c.propensity > 0 && c.propensity < 1), "B1: 0 < p < 1");
  assert.equal(rec.randomized, true, "P3: ε-greedy policy is stochastic");
  assert.ok(rec.candidates.every((c) => typeof c.is_explore === "boolean"), "P3: is_explore filled");
  assert.ok(rec.candidates.some((c) => c.shown), "some candidates marked shown");
  assert.equal(run(home, ["vote", "--due"]).stdout.trim(), "due");
  const proj = mkTemp("rp-vote-proj-");
  writeFileSync(join(proj, "repotify.lock.json"), JSON.stringify({ version: 1, items: { graphify: { type: "tool", targets: [] } } }));
  assert.equal(run(home, ["vote", "graphify", "up"], {}, proj).status, 0);
  assert.equal(queue(home).find((e) => e.type === "vote").vote, "up");
  assert.equal(run(home, ["vote", "--due"]).stdout.trim(), "not due");
  assert.equal(run(home, ["vote", "not-installed", "up"], {}, proj).status, 1);
  const status = run(home, ["telemetry", "status"]).stdout;
  assert.match(status, /on/);
  assert.match(status, /endpoint not configured/);
});

test("CLI: telemetry off stops all queuing", () => {
  const home = mkTemp("rp-cli-tel-");
  run(home, ["telemetry", "off"]);
  run(home, ["recommend"]);
  assert.deepEqual(queue(home), []);
  assert.match(run(home, ["telemetry", "status"]).stdout, /off/);
});

test("CLI: DO_NOT_TRACK=1 queues nothing", () => {
  const home = mkTemp("rp-cli-tel-");
  run(home, ["recommend"], { DO_NOT_TRACK: "1" });
  assert.deepEqual(queue(home), []);
});
