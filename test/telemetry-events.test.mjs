// Stage 0 event schema + store tests: reward-formula-agnostic (D4),
// propensity always < 1 (B1), content-free privacy, append-only JSONL.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION, EVENT_TYPES, validateEvent,
  createEventStore, createTracker, verifyLog,
  hashProjectId, scanEvent,
} from "../lib/telemetry/index.mjs";
import { markNoticeShown } from "../lib/telemetry/consent.mjs";

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

const IID = "123e4567-e89b-42d3-a456-426614174000";
const EID = "223e4567-e89b-42d3-a456-426614174000";
const TS = "2026-10-01T08:00:00.000Z";
const dir = () => mkTemp("rp-s0-");
const envFor = (d, extra = {}) => ({ REPOTIFY_HOME: d, ...extra });
const base = (type, extra = {}) => ({
  type, ts: TS, schema_version: SCHEMA_VERSION, install_id: IID, agent: "claude-code", ...extra,
});

const recEvent = () => base("recommendation", {
  episode_id: EID,
  policy_name: "static-v1",
  budget_chars: 4000,
  candidates: [
    { skill_id: "pdf", position: 0, propensity: 0.7, shown: true, raw_score: 0.91, is_explore: false },
    { skill_id: "graphify", position: 1, propensity: 0.2, shown: true, raw_score: 0.42, is_explore: false },
    // Considered but NOT shown — still gets its exact propensity (DR diagnostics).
    { skill_id: "weird-longshot", position: 2, propensity: 0.09, shown: false, raw_score: 0.05, is_explore: true },
  ],
});

test("schema version is pinned and event types cover the funnel", () => {
  assert.equal(SCHEMA_VERSION, 1);
  for (const t of ["recommendation", "install", "select", "invoke", "abandon", "fallback",
    "outcome", "kept_30d", "removed_fast", "removed", "replaced", "question", "usage"]) {
    assert.ok(EVENT_TYPES.includes(t), `missing ${t}`);
  }
});

test("a full recommendation episode validates, including the propensity record", () => {
  assert.deepEqual(validateEvent(recEvent()), []);
});

test("B1: propensity must always satisfy 0 < p < 1 (deterministic slots break replay)", () => {
  for (const bad of [0, 1, 1.0, -0.2, 1.5, Number.NaN, "0.5", undefined]) {
    const e = recEvent();
    if (bad === undefined) delete e.candidates[0].propensity;
    else e.candidates[0].propensity = bad;
    assert.ok(validateEvent(e).some((m) => m.includes("propensity")), `propensity=${String(bad)} must be rejected`);
  }
  const e = recEvent();
  e.candidates.push({ skill_id: "pdf", position: 3, propensity: 0.01, shown: false });
  assert.ok(validateEvent(e).some((m) => m.includes("duplicate")), "duplicate candidates rejected");
});

test("D4: computed reward/score/weight fields are rejected, never logged", () => {
  for (const k of ["reward", "score", "weights", "expected_reward", "r_hat"]) {
    const e = { ...recEvent(), [k]: 0.5 };
    assert.ok(validateEvent(e).some((m) => m.includes("computed") || m.includes("D4")),
      `computed field ${k} must be rejected`);
  }
  const out = base("outcome", { episode_id: EID, skill_ids: ["pdf"], task_success: true, reward: 1 });
  assert.ok(validateEvent(out).length > 0, "reward on outcome events rejected too");
});

test("every event type has a valid minimal form", () => {
  const cases = [
    base("install", { skill_id: "pdf", episode_id: EID, from_recommendation: true }),
    base("select", { skill_id: "github-mcp", target: "claude-code" }),
    base("invoke", { skill_id: "pdf", invocation_kind: "explicit", session_id: "sess_1" }),
    base("invoke", { skill_id: "pdf", invocation_kind: "implicit" }),
    base("invoke", { skill_id: "pdf", invocation_kind: "load" }),
    base("abandon", { episode_id: EID, skill_id: "pdf", reason: "gave_up" }),
    base("fallback", { from_skill: "pdf", to_skill: "graphify", trigger: "invoke_failed" }),
    base("outcome", { episode_id: EID, skill_ids: ["pdf"], task_success: true, quality: 4 }),
    base("outcome", { task_success: false, skill_free_baseline: true }),
    base("kept_30d", { skill_id: "pdf", episode_id: EID }),
    base("removed_fast", { skill_id: "pdf", removal_reason: "unused" }),
    base("removed", { skill_id: "pdf", removal_reason: "internalized" }),
    base("replaced", { skill_id: "pdf", replaced_by: "graphify" }),
    base("question", { question_id: "q3", answer: "yes", was_confirm: true, skipped: false, question_propensity: 0.5 }),
    base("usage", { episode_id: EID, skill_id: "pdf", tokens_in: 1200, tokens_out: 300, latency_ms: 450 }),
  ];
  for (const e of cases) assert.deepEqual(validateEvent(e), [], `valid ${e.type}: ${JSON.stringify(validateEvent(e))}`);
});

test("invalid shapes are rejected", () => {
  const bad = [
    [{ ...base("install"), skill_id: "../etc/passwd" }, "path-like skill_id"],
    [{ ...base("invoke", { skill_id: "pdf" }) }, "missing invocation_kind"],
    [{ ...base("invoke", { skill_id: "pdf", invocation_kind: "magic" }) }, "bad invocation_kind"],
    [{ ...base("outcome", { task_success: true, quality: 6 }) }, "quality out of range"],
    [{ ...base("outcome", { task_success: true, quality: "high" }) }, "quality not an int"],
    [{ ...base("removed_fast", { skill_id: "pdf" }) }, "missing removal_reason"],
    [{ ...base("usage", { tokens_in: 5 }) }, "usage without attribution"],
    [{ ...base("question", { question_id: "q1", answer: "free text with @mention!" }) }, "free-text answer"],
    [{ ...base("recommendation", { episode_id: EID, candidates: [] }) }, "empty candidates"],
    [{ ...base("install", { skill_id: "pdf" }), repoName: "secret" }, "unknown field"],
    [{ ...base("install", { skill_id: "pdf" }), install_id: "not-a-uuid" }, "bad install_id"],
    [{ ...base("install", { skill_id: "pdf" }), project_hash: "/home/me/proj" }, "raw project path as hash"],
  ];
  for (const [e, why] of bad) assert.ok(validateEvent(e).length > 0, why);
});

test("project hashing is one-way and salted", () => {
  const h1 = hashProjectId("/home/alice/secret-project", IID);
  const h2 = hashProjectId("/home/alice/secret-project", IID);
  assert.equal(h1, h2, "deterministic per machine");
  assert.match(h1, /^[0-9a-f]{32}$/);
  assert.notEqual(hashProjectId("/home/alice/secret-project", "other-salt"), h1, "salt changes the digest");
  assert.ok(!h1.includes("secret"), "no raw name in the digest");
  assert.deepEqual(validateEvent(base("install", { skill_id: "pdf", project_hash: h1 })), []);
});

test("privacy scan trips on paths, emails, keys — code/prompt never reach disk", () => {
  const findings = scanEvent({ a: "see /home/alice/secret", b: "mail me@example.com", c: "api-key xyz" });
  assert.equal(findings.length, 3);
  assert.deepEqual(findings.map((f) => f.pattern).sort(), ["absolute-path", "credential-assignment", "email"]);
  assert.deepEqual(scanEvent(recEvent()), [], "clean events pass");
});

test("store appends append-only JSONL and reads it back filtered", () => {
  const d = dir();
  const store = createEventStore({ dir: d });
  store.append(recEvent());
  store.append(base("install", { skill_id: "pdf", episode_id: EID }));
  store.append(base("invoke", { skill_id: "pdf", invocation_kind: "load", episode_id: EID }));
  const lines = readFileSync(join(d, "stage0.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3, "one line per event, append-only");
  assert.equal(store.read({ type: "invoke" }).length, 1);
  assert.equal(store.read({ episodeId: EID }).length, 3);
  assert.equal(store.read({ skillId: "pdf" }).length, 2);
  assert.equal(store.read({ type: "install", limit: 1 }).length, 1);
});

test("store refuses invalid events and privacy violations — nothing is written", () => {
  const d = dir();
  const store = createEventStore({ dir: d });
  assert.throws(() => store.append({ type: "nope" }), /invalid telemetry event/);
  const sneaky = base("question", { question_id: "q1", answer: "api-key xyz" });
  assert.deepEqual(validateEvent(sneaky), [], "schema-valid but not content-free");
  assert.throws(() => store.append(sneaky), /privacy scan/);
  assert.equal(existsSync(join(d, "stage0.jsonl")), false, "no partial writes");
});

test("store rotates when oversized and skips corrupt lines on read", () => {
  const d = dir();
  const store = createEventStore({ dir: d, maxBytes: 200 });
  store.append(recEvent());
  store.append(base("install", { skill_id: "pdf" }));
  assert.ok(existsSync(join(d, "stage0.jsonl.1")), "rotated generation kept");
  appendFileSync(join(d, "stage0.jsonl"), "not json\n");
  assert.equal(store.read().length, 2, "corrupt line skipped across both generations");
});

test("seq is monotonic per generation and restarts after rotation (gap detection)", () => {
  const d = dir();
  const store = createEventStore({ dir: d, maxBytes: 300 });
  store.append(base("install", { skill_id: "pdf" }));
  store.append(base("install", { skill_id: "graphify" }));
  let seqs = store.read().map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2]);
  store.append(base("install", { skill_id: "pdf" })); // triggers rotation
  assert.ok(existsSync(join(d, "stage0.jsonl.1")));
  seqs = createEventStore({ dir: d, maxBytes: 300 }).read({}).map((e) => e.seq);
  const active = readFileSync(join(d, "stage0.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).seq);
  assert.deepEqual(active, [1], "new generation restarts at 1");
});

test("tracker is fail-open: bad events return false, never throw into the command", () => {
  const d = dir();
  const env = envFor(d);
  markNoticeShown(env);
  const t = createTracker({ env, dir: d, installId: IID });
  assert.equal(t.track({ type: "nope" }), false, "schema violation -> false, not a throw");
  assert.equal(t.track(base("question", { question_id: "q1", answer: "api-key xyz" })), false, "privacy violation -> false");
  assert.deepEqual(storeLines(d), [], "nothing written");
  assert.equal(t.droppedCount(), 2, "attempted-but-failed writes are counted");
});

test("tracker counts disk failures as dropped, consent refusals are not drops", () => {
  const d = dir();
  const blocker = join(d, "blocker");
  writeFileSync(blocker, "x");
  const env = envFor(d);
  markNoticeShown(env);
  const t = createTracker({ env, dir: blocker, installId: IID });
  assert.equal(t.track(base("install", { skill_id: "pdf" })), false);
  assert.equal(t.droppedCount(), 1);
  const t2 = createTracker({ env: envFor(dir()), dir: d, installId: IID });
  assert.equal(t2.track(base("install", { skill_id: "pdf" })), false, "no notice -> refusal, not a drop");
  assert.equal(t2.droppedCount(), 0);
});

test("verifyLog reports seq gaps and corrupt lines (who watches the gaps: this)", () => {
  const d = dir();
  const store = createEventStore({ dir: d });
  store.append(base("install", { skill_id: "pdf" }));
  store.append(base("install", { skill_id: "graphify" }));
  store.append(base("install", { skill_id: "pdf" }));
  let v = verifyLog(d);
  assert.equal(v.ok, true);
  assert.deepEqual(v.generations.find((g) => g.file.endsWith("stage0.jsonl")).gaps, []);
  // Simulate silent loss: remove the middle line.
  const p = join(d, "stage0.jsonl");
  const lines = readFileSync(p, "utf8").trim().split("\n");
  writeFileSync(p, [lines[0], lines[2]].join("\n") + "\n");
  appendFileSync(p, "not json\n");
  v = verifyLog(d);
  assert.equal(v.ok, false);
  const gen = v.generations.find((g) => g.file.endsWith("stage0.jsonl"));
  assert.deepEqual(gen.gaps, [2], "the missing seq is named");
  assert.equal(gen.corrupt, 1);
});

test("recommendation.randomized marks actually-randomized selection (IPS-safe filter)", () => {
  const e = recEvent();
  e.randomized = true;
  assert.deepEqual(validateEvent(e), []);
  const bad = recEvent();
  bad.randomized = "yes";
  assert.ok(validateEvent(bad).some((m) => m.includes("randomized")));
});

const storeLines = (d) => (existsSync(join(d, "stage0.jsonl")) ? readFileSync(join(d, "stage0.jsonl"), "utf8").trim().split("\n").filter(Boolean) : []);

test("tracker: T1 — nothing is written before the notice is seen", () => {
  const d = dir();
  const env = envFor(d);
  const t = createTracker({ env, dir: d, installId: IID });
  assert.equal(t.noticeNeeded(), true);
  assert.equal(t.track(recEvent()), false, "no data before notice");
  assert.equal(existsSync(join(d, "stage0.jsonl")), false);
  markNoticeShown(env);
  assert.equal(t.track(recEvent()), true);
  const [line] = readFileSync(join(d, "stage0.jsonl"), "utf8").trim().split("\n");
  const e = JSON.parse(line);
  assert.equal(e.install_id, IID);
  assert.equal(e.schema_version, 1);
  assert.ok(e.ts);
});
