// S13 test-hardening (SWARM-15, 2026-10-01): coverage for the code paths that
// learn-attribution.test.mjs does not reach — policy-gate options,
// decay scheduler edges, tripwire boundaries, instrument malformed input,
// and tokenizer entry points. All deterministic (fixed seeds / injected time).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatePolicyChange, GATE_VERSION } from "../lib/learn/policy-gate.mjs";
import {
  createDecayScheduler, DECAY_GAMMA_DEFAULT, DECAY_INTERVAL_MS,
} from "../lib/learn/decay.mjs";
import {
  checkT1, checkT2, checkT3, TRIPWIRE_VERSION,
  T1_MIN_COVERAGE, T2_MIN_SHARED_EPISODES, T3_MAX_REFUSAL_DAYS,
} from "../lib/learn/tripwires.mjs";
import {
  wrapInstalledSkill, readInstrumentManifest, unwrapInstalledSkill,
  resolveInstrumentedSkill, buildInstallEvent, buildInvokeEvent,
  INSTRUMENT_MANIFEST, INSTRUMENT_SCHEMA,
} from "../lib/telemetry/instrument.mjs";
import { INVOCATION_KINDS } from "../lib/telemetry/schema.mjs";
import { LinUCB } from "../lib/learn/linucb.mjs";
import { countTokens, itemTokens } from "../lib/tokenizer.mjs";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const DAY = 24 * 3600 * 1000;

// ---- policy-gate: uncovered paths ----

test("S13 gate: targetPropensityOf callback supplies missing target propensities", () => {
  const rows = Array.from({ length: 40 }, () => ({ logPropensity: 0.5, reward: 0.5 }));
  const g = gatePolicyChange(rows, { targetPropensityOf: () => 0.6 });
  assert.equal(g.verdict, "pass");
  assert.equal(g.refused, false);
  assert.ok(g.estimates && g.estimates.ess > 0);
});

test("S13 gate: vetoThreshold option moves the pass/veto boundary", () => {
  const rows = Array.from({ length: 40 }, () => ({ logPropensity: 0.5, targetPropensity: 0.6, reward: 0.5 }));
  assert.equal(gatePolicyChange(rows).verdict, "pass"); // dr ~ 0.6 > default 0
  assert.equal(gatePolicyChange(rows, { vetoThreshold: 1.0 }).verdict, "veto"); // dr < 1.0 and ips < 1.0
});

test("S13 gate: clipped estimate → flagged with the clipped fraction", () => {
  const rows = [
    ...Array.from({ length: 36 }, () => ({ logPropensity: 0.01, targetPropensity: 1.0, reward: 0.5 })),
    ...Array.from({ length: 4 }, () => ({ logPropensity: 0.5, targetPropensity: 0.5, reward: 0.5 })),
  ];
  const g = gatePolicyChange(rows);
  assert.equal(g.verdict, "flagged");
  assert.equal(g.refused, false);
  assert.ok(/clippedFrac 0\.9/.test(g.reason), g.reason);
  assert.ok(g.estimates && g.estimates.clipped === true);
});

test("S13 gate: empty / non-array / malformed rows refuse honestly", () => {
  for (const rows of [[], null, undefined, "nope"]) {
    const g = gatePolicyChange(rows);
    assert.equal(g.verdict, "flagged");
    assert.equal(g.refused, true);
    assert.equal(g.estimates, null);
    assert.equal(g.ess, null);
    assert.ok(/no rows/.test(g.reason), g.reason);
  }
  const g2 = gatePolicyChange([null]);
  assert.equal(g2.verdict, "flagged");
  assert.equal(g2.refused, true);
  assert.ok(/not an object|finite number/.test(g2.reason), g2.reason);
});

test("S13 gate: row-level OPE plumbing (ess/n surface, version constant)", () => {
  assert.equal(GATE_VERSION, "gate1");
  const rows = Array.from({ length: 40 }, () => ({ logPropensity: 1.0, targetPropensity: 0.6, reward: 0.5 }));
  const g = gatePolicyChange(rows);
  assert.equal(g.verdict, "flagged");
  assert.equal(g.refused, true);
  assert.equal(g.n, 40);
});

// ---- decay scheduler: uncovered paths ----

test("S13 decay: not-due apply is a no-op with a reason", () => {
  const policy = new LinUCB();
  policy.observe("a", new Array(64).fill(0.5), 1.0);
  const before = policy.arm("a").b[0];
  const sched = createDecayScheduler({ gamma: 0.9, intervalMs: DAY, now: () => new Date(T0 + 2 * DAY) });
  assert.equal(sched.due(new Date(T0 + 1.5 * DAY).toISOString()).due, false);
  const r = sched.apply(policy, new Date(T0 + 1.5 * DAY).toISOString());
  assert.equal(r.applied, false);
  assert.equal(r.reason, "not-due");
  assert.equal(r.decayedArms, 0);
  assert.equal(policy.arm("a").b[0], before, "arm untouched when not due");
  assert.ok(!Number.isNaN(Date.parse(r.at)), "at is an ISO timestamp");
});

test("S13 decay: overdueMs measures how late the decay is", () => {
  const sched = createDecayScheduler({ intervalMs: DAY, now: () => new Date(T0 + 31 * DAY) });
  const d = sched.due(new Date(T0).toISOString());
  assert.equal(d.due, true);
  assert.equal(d.overdueMs, 30 * DAY);
  assert.equal(d.reason, "interval-elapsed");
  const r = sched.apply(new LinUCB(), new Date(T0).toISOString());
  assert.equal(r.applied, true);
  assert.equal(r.overdueMs, 30 * DAY);
  assert.equal(r.gamma, DECAY_GAMMA_DEFAULT, "gamma echoed in the result");
});

test("S13 decay: constructor rejects invalid gamma / intervalMs", () => {
  assert.throws(() => createDecayScheduler({ gamma: 1.5 }), /gamma/);
  assert.throws(() => createDecayScheduler({ gamma: -0.1 }), /gamma/);
  assert.throws(() => createDecayScheduler({ gamma: "0.95" }), /gamma/);
  assert.throws(() => createDecayScheduler({ intervalMs: 0 }), /intervalMs/);
  assert.throws(() => createDecayScheduler({ intervalMs: -5 }), /intervalMs/);
});

test("S13 decay: gamma default and ms-number inputs", () => {
  assert.equal(createDecayScheduler().gamma, DECAY_GAMMA_DEFAULT);
  assert.equal(createDecayScheduler().intervalMs, DECAY_INTERVAL_MS);
  const sched = createDecayScheduler({ intervalMs: DAY, now: () => new Date(T0 + 2 * DAY) });
  assert.equal(sched.intervalMs, DAY);
  // Date objects behave like ISO strings
  assert.equal(sched.due(new Date(T0 + DAY)).due, true); // elapsed 1 day >= 1 day interval
  assert.equal(sched.due(new Date(T0 + 2 * DAY - 1)).due, false); // 1 ms short of the interval
  // an unparseable lastDecayAt is treated as never-decayed (due, not an error)
  assert.equal(sched.due("not-a-date").due, true);
  assert.equal(sched.due("not-a-date").reason, "never-decayed");
  // S13 finding (2026-10-01), fixed by K2 coordinator: the docstring promises ms
  // numbers are accepted — toMs() now treats finite numbers as epoch ms.
  const msNum = T0 + DAY; // ms epoch number, same instant as the ISO string above
  assert.equal(sched.due(msNum).due, true, "ms epoch number accepted, elapsed 1 day");
  assert.equal(sched.due(msNum).reason, "interval-elapsed");
  assert.equal(sched.due(T0 + 2 * DAY - 1).due, false, "ms epoch number 1 ms short of interval");
  assert.equal(sched.due(NaN).reason, "never-decayed", "NaN is not a usable timestamp");
  assert.equal(sched.due(Infinity).reason, "never-decayed", "Infinity is not a usable timestamp");
});

// ---- tripwires: boundaries ----

test("S13 T1: null/empty input is silence, not a pass", () => {
  for (const input of [null, undefined, []]) {
    const t = checkT1(input);
    assert.equal(t.tripped, false);
    assert.equal(t.detail.reason, "insufficient_data");
    assert.equal(t.tripwire, "T1");
  }
  assert.equal(TRIPWIRE_VERSION, "tw1");
});

test("S13 T1: exactly 80% coverage does not trip (strict <)", () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push({ signals: { invoke_observed: true } });
  for (let i = 0; i < 2; i++) rows.push({ signals: { invoke_observed: false } });
  const t = checkT1(rows);
  assert.equal(t.detail.coverage, 0.8);
  assert.equal(t.tripped, false, "boundary: 0.8 is not < 0.8");
  assert.equal(t.detail.action, "none");
  assert.ok(!Number.isNaN(Date.parse(t.checkedAt)), "checkedAt is ISO");
});

test("S13 T1: trip carries the remediation action; minRows is overridable", () => {
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push({ signals: { invoke_observed: true } });
  for (let i = 0; i < 2; i++) rows.push({ signals: { invoke_observed: false } });
  // 6 rows < default minRows 10 → silent …
  assert.equal(checkT1(rows).detail.reason, "insufficient_data");
  // … but trippable with an explicit minRows
  const t = checkT1(rows, { minRows: 5 });
  assert.equal(t.tripped, true);
  assert.ok(/OPE-only/.test(t.detail.action), t.detail.action);
  assert.equal(t.detail.minCoverage, T1_MIN_COVERAGE);
});

test("S13 T2: disjoint episodes → insufficient_data; constant outcomes are skipped", () => {
  const disjoint = [];
  for (let e = 0; e < 6; e++) {
    disjoint.push({ episode_id: `a${e}`, skill_id: "arm-a", signals: { outcome_success: e % 2 === 0 } });
    disjoint.push({ episode_id: `b${e}`, skill_id: "arm-b", signals: { outcome_success: e % 2 === 0 } });
  }
  const t1 = checkT2(disjoint);
  assert.equal(t1.tripped, false);
  assert.equal(t1.detail.reason, "insufficient_data");
  assert.equal(t1.detail.pairs, 0);

  // both arms win every shared episode: zero variance → pearson null → no pairs
  const constant = [];
  for (let e = 0; e < 6; e++) {
    constant.push({ episode_id: `ep${e}`, skill_id: "arm-a", signals: { outcome_success: true } });
    constant.push({ episode_id: `ep${e}`, skill_id: "arm-b", signals: { outcome_success: true } });
  }
  const t2 = checkT2(constant);
  assert.equal(t2.tripped, false);
  assert.equal(t2.detail.reason, "insufficient_data");
});

test("S13 T2: shared-episode boundary and worstPair detail", () => {
  // exactly minShared shared episodes (5) are evaluated; identical outcomes → trips
  const rows = [];
  for (let e = 0; e < 5; e++) {
    const win = e % 2 === 0;
    rows.push({ episode_id: `ep${e}`, skill_id: "arm-a", signals: { outcome_success: win } });
    rows.push({ episode_id: `ep${e}`, skill_id: "arm-b", signals: { outcome_success: win } });
  }
  // 5 shared >= T2_MIN_SHARED_EPISODES (5) → evaluated
  const t = checkT2(rows);
  assert.equal(t.detail.pairs, 1);
  assert.equal(t.tripped, true);
  assert.deepEqual(t.detail.worstPair.arms, ["arm-a", "arm-b"]);
  assert.equal(t.detail.worstPair.shared, 5);
  // 4 shared < 5 → not enough overlap
  const thin = rows.slice(0, 8);
  const t2 = checkT2(thin);
  assert.equal(t2.detail.reason, "insufficient_data");
});

test("S13 T3: unsorted log still counts the trailing streak", () => {
  const mk = (day, refused) => ({ day, refused });
  const log = [
    mk("2026-03-03", true), mk("2026-03-01", true), mk("2026-03-02", true),
  ];
  const t = checkT3(log, { maxRefusalDays: 3 });
  assert.equal(t.detail.refusalStreakDays, 3);
  assert.equal(t.tripped, true);
});

test("S13 T3: 89 does not trip, only the trailing streak counts", () => {
  const log = [];
  for (let d = 0; d < 89; d++) log.push({ day: `2026-04-${String(d + 1).padStart(2, "0")}`, refused: true });
  const t89 = checkT3(log, { maxRefusalDays: 90 });
  assert.equal(t89.tripped, false);
  assert.equal(t89.detail.refusalStreakDays, 89);
  assert.equal(t89.detail.maxRefusalDays, T3_MAX_REFUSAL_DAYS);
  assert.equal(t89.detail.action, "none");

  // an old 90-day streak broken by a clean day yesterday → trailing streak is 0
  const old = log.map((r) => ({ ...r }));
  old.push({ day: "2026-08-01", refused: false });
  const tBroken = checkT3(old, { maxRefusalDays: 90 });
  assert.equal(tBroken.tripped, false);
  assert.equal(tBroken.detail.refusalStreakDays, 0);
  assert.equal(checkT3(null).tripped, false);
  assert.equal(checkT3(null).detail.logDays, 0);
});

// ---- instrument: malformed input ----

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "repotify-s13-"));
}

test("S13 instrument: readInstrumentManifest rejects garbage, wrong schema, wrong shape", () => {
  const dir = tmpDir();
  try {
    const d = join(dir, "skill-x");
    wrapInstalledSkill({ dir: d, skillId: "skill-x" });
    assert.equal(readInstrumentManifest(d).schema, INSTRUMENT_SCHEMA);

    writeFileSync(join(d, INSTRUMENT_MANIFEST), "not json {{{");
    assert.equal(readInstrumentManifest(d), null, "corrupt JSON → null");

    writeFileSync(join(d, INSTRUMENT_MANIFEST), JSON.stringify({ schema: "other/v9", skill_id: "x" }));
    assert.equal(readInstrumentManifest(d), null, "wrong schema → null");

    writeFileSync(join(d, INSTRUMENT_MANIFEST), JSON.stringify({ schema: INSTRUMENT_SCHEMA, skill_id: 42 }));
    assert.equal(readInstrumentManifest(d), null, "non-string skill_id → null");
    assert.equal(resolveInstrumentedSkill(d), null, "unresolvable → null, never guessed");

    writeFileSync(join(d, INSTRUMENT_MANIFEST), "42");
    assert.equal(readInstrumentManifest(d), null, "non-object JSON → null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S13 instrument: wrap honors installedAt; unwrap on a missing dir is still true", () => {
  const dir = tmpDir();
  try {
    const w = wrapInstalledSkill({ dir: join(dir, "s"), skillId: "s", installedAt: "2026-01-02T03:04:05.000Z" });
    assert.equal(w.ok, true);
    assert.equal(readInstrumentManifest(join(dir, "s")).installed_at, "2026-01-02T03:04:05.000Z");
    assert.equal(unwrapInstalledSkill(join(dir, "never-wrapped")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S13 instrument: built events carry only the fields given", () => {
  const inst = buildInstallEvent({ skillId: "skill-x" });
  assert.equal(inst.from_recommendation, false);
  assert.ok(!("episode_id" in inst), "no episode_id key when not given");

  for (const kind of INVOCATION_KINDS) {
    const e = buildInvokeEvent({ skillId: "s", invocationKind: kind });
    assert.equal(e.invocation_kind, kind);
    assert.ok(!("episode_id" in e) && !("session_id" in e));
  }
  assert.throws(() => buildInvokeEvent({ skillId: "s", invocationKind: "psychic" }), /invocationKind/);
});

// ---- tokenizer: entry points ----

test("S13 tokenizer: itemTokens prefers summary, falls back to description", () => {
  const text = "Provides domain-specific intelligence for a project niche.";
  assert.equal(itemTokens({ summary: text }), countTokens(text));
  assert.equal(itemTokens({ description: text }), countTokens(text));
  assert.equal(itemTokens({ summary: text, description: "other" }), countTokens(text), "summary wins");
  assert.equal(itemTokens({}), 0);
  assert.equal(itemTokens({ summary: "" }), 0);
});

test("S13 tokenizer: non-string input coerces; empty is zero", () => {
  assert.equal(countTokens(""), 0);
  assert.equal(countTokens(null), 0);
  assert.equal(countTokens(undefined), 0);
  assert.ok(countTokens(12345) > 0, "numbers coerce to strings");
});

test("S13 tokenizer: uppercase dotted İ takes the Turkish path; casing is normalized", () => {
  // "İSTANBUL" (8 chars) hits the Turkish branch via İ → ceil(8/5.2) = 2
  assert.equal(countTokens("İSTANBUL"), 2);
  // lowercase Turkish dotted/diacritic chars take the same path
  assert.equal(countTokens("ışık"), Math.max(1, Math.ceil("ışık".length / 5.2)));
  // case is noise: cased variants count identically
  assert.equal(countTokens("Hello World"), countTokens("HELLO WORLD"));
  assert.equal(countTokens("Hello World"), countTokens("hello world"));
});
