// FAZ 9 — fleet wiring tests: recommendV1 + fleet prior, nightly job,
// D1 reference schema. (P5 acceptance lives in telemetry-sync-acceptance.test.mjs.)
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { recommendV1 } from "../lib/pipeline/recommend/index.mjs";
import { scoreCandidates } from "../lib/pipeline/recommend/score.mjs";
import { narrowCandidates } from "../lib/pipeline/recommend/narrow.mjs";
import { FLEET_BLEND } from "../lib/telemetry/fleet-policy.mjs";
import { FLEET_POLICY_SCHEMA } from "../lib/telemetry/sync.mjs";
import { createAggregator } from "../lib/telemetry/server/aggregate.mjs";
import { runNightly } from "../lib/telemetry/server/nightly.mjs";
import { FLEET_INSTALL_THRESHOLD } from "../lib/telemetry/server/thresholds.mjs";

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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- fixtures (same shape as test/recommend-v1.test.mjs) ---------------------

const mkItem = (over) => ({
  id: "x",
  type: "skill",
  tier: "mission",
  cluster: "x",
  capabilities: ["tdd-discipline"],
  needs: [],
  stacks: ["*"],
  descriptionChars: 200,
  summary: "x",
  security: { level: "verified" },
  signals: { lastCommitDays: 5 },
  conflicts: [],
  ...over,
});

const mkCatalog = (items) => ({
  items,
  taxonomy: {
    capabilities: { "tdd-discipline": {} },
    needs: { testing: { capabilities: ["tdd-discipline"] } },
    projectTypes: {},
    priorities: {},
  },
});

const mkGraph = () => ({
  byType: new Map([["provides", []], ["requires", []], ["conflicts_with", []], ["supersedes", []], ["depends_on", []], ["fallback", []]]),
  edgesOf: () => [],
});

const demand = () => ({
  stacks: [],
  platforms: [],
  capabilitiesWanted: ["tdd-discipline"],
  capWeights: { "tdd-discipline": 1 },
  needs: ["testing"],
  needWeights: { testing: 1 },
  webOnlyCaps: new Set(),
});

const mkPolicy = (skills) => ({ schema: FLEET_POLICY_SCHEMA, version: "fleet/1", skills });

// --- recommendV1 + fleet ----------------------------------------------------

test("recommendV1 without a fleet policy leaves the frozen baseline untouched", async () => {
  const catalog = mkCatalog([mkItem({ id: "a" }), mkItem({ id: "b" })]);
  const params = { catalog, graph: mkGraph(), demand: demand() };
  const r1 = await recommendV1(params);
  const r2 = await recommendV1(params);
  assert.equal(r1.fleetApplied, false);
  assert.ok(r1.ranked.every((r) => r.fleetAdjusted === false));
  // Deterministic and identical to the raw baseline path.
  assert.deepEqual(r1.ranked.map((r) => [r.id, r.score]), r2.ranked.map((r) => [r.id, r.score]));
  const narrowed = narrowCandidates({ catalog, graph: mkGraph(), demand: demand() });
  const base = scoreCandidates(narrowed, demand());
  assert.deepEqual(r1.ranked.map((r) => r.id), base.map((s) => s.item.id));
  assert.deepEqual(r1.ranked.map((r) => r.score), base.map((s) => s.score));
});

test("recommendV1 with a fleet policy blends the bounded prior and flags rows", async () => {
  // Identical items => identical baseline scores; the fleet decides the order.
  const catalog = mkCatalog([mkItem({ id: "fleet-a" }), mkItem({ id: "fleet-b" }), mkItem({ id: "fleet-c" })]);
  const params = { catalog, graph: mkGraph(), demand: demand() };
  const base = await recommendV1(params);
  const baseById = Object.fromEntries(base.ranked.map((r) => [r.id, r.score]));
  assert.equal(baseById["fleet-a"], baseById["fleet-b"], "baseline is quality-blind by construction");

  const policy = mkPolicy({
    "fleet-a": { effectiveness: 0.2 },   // the fleet learned this one is weak
    "fleet-b": { effectiveness: 0.9 },   // ...and this one strong
    // fleet-c absent from the policy: untouched
  });
  const r = await recommendV1(params, { fleetPolicy: policy });
  assert.equal(r.fleetApplied, true);
  const byId = Object.fromEntries(r.ranked.map((x) => [x.id, x]));
  // Order follows the fleet: strong first.
  assert.deepEqual(r.ranked.map((x) => x.id), ["fleet-b", "fleet-c", "fleet-a"]);
  // Exact blend math: baseline + FLEET_BLEND * (effectiveness - 0.5).
  assert.equal(byId["fleet-b"].score, Math.round((baseById["fleet-b"] + FLEET_BLEND * 0.4) * 1000) / 1000);
  assert.equal(byId["fleet-a"].score, Math.round((baseById["fleet-a"] - FLEET_BLEND * 0.3) * 1000) / 1000);
  assert.equal(byId["fleet-c"].score, baseById["fleet-c"], "skills missing from the policy keep their baseline");
  assert.equal(byId["fleet-b"].fleetAdjusted, true);
  assert.equal(byId["fleet-c"].fleetAdjusted, false);
  // The bound holds: no score moves more than ±0.1.
  for (const row of r.ranked) {
    assert.ok(Math.abs(row.score - baseById[row.id]) <= 0.1 + 1e-9, `${row.id}: fleet shift bounded`);
  }
});

test("recommendV1 re-applies the fleet prior after arbitration", async () => {
  // Identical baseline scores => ambiguous; a small fleet shift (0.03, still
  // under the 0.08 ambiguity margin) keeps arbitration in play. The
  // arbitrator resolves to fleet-b, then the fleet blend must still be
  // visible on top of the arbitrated ranking.
  const catalog = mkCatalog([mkItem({ id: "fleet-a" }), mkItem({ id: "fleet-b" })]);
  const policy = mkPolicy({ "fleet-b": { effectiveness: 0.65 } });
  // answered: [...] lifts the "thin-demand" flag so arbitration is allowed.
  const d = { ...demand(), answered: ["q1"] };
  const r = await recommendV1(
    { catalog, graph: mkGraph(), demand: d },
    { fleetPolicy: policy, arbitrate: async () => ({ "fleet-b": 1, "fleet-a": 0 }) },
  );
  assert.equal(r.arbitrated, true);
  assert.equal(r.fleetApplied, true);
  assert.equal(r.ranked[0].id, "fleet-b");
  assert.equal(r.ranked[0].fleetAdjusted, true);
});

// --- nightly job ------------------------------------------------------------

const syncPayload = (skillIds, t) => ({
  schema: "telemetry-sync/v1",
  window_start: new Date(t - 3600 * 1000).toISOString(),
  window_end: new Date(t).toISOString(),
  nonce: randomUUID(),
  aggregates: Object.fromEntries(
    skillIds.map((id) => [id, { shown: 3, installed: 2, invoked: 5, invoked_sessions: 2, outcome_success: 4, kept_30d: 3 }]),
  ),
});

test("runNightly: admit -> policy -> gate -> distribute", () => {
  const clock = { t: Date.parse("2026-06-01T00:00:00Z") };
  // Default k-anonymity floor (FLEET_MIN_GROUP_INSTALLS = 5): five distinct
  // nonces so both skills clear the aggregate gate AND the policy.mjs
  // defense-in-depth re-check.
  const agg = createAggregator({ now: () => new Date(clock.t) });
  for (let i = 0; i < 5; i++) agg.ingest(syncPayload(["nightly-a", "nightly-b"], clock.t - (i + 1) * 1000));
  const outDir = mkTemp("rp-nightly-");
  clock.t += 25 * 3600 * 1000; // past the 24h quarantine
  const r = runNightly({ aggregator: agg, outDir, now: () => new Date(clock.t) });
  assert.equal(r.admitted.admitted, 5);
  assert.equal(r.skills_published, 2);
  assert.equal(r.skills_suppressed, 0);
  assert.equal(r.leaderboard.enabled, false, "2 installs < 200: 8b stays flagged");
  assert.equal(r.leaderboard.threshold, FLEET_INSTALL_THRESHOLD);
  const policy = JSON.parse(readFileSync(r.policyPath, "utf8"));
  assert.equal(policy.schema, "fleet-policy/1");
  assert.ok(policy.skills["nightly-a"].effectiveness > 0.5, "kept + success outweigh the skeptical prior");
  const status = JSON.parse(readFileSync(r.statusPath, "utf8"));
  assert.equal(status.enabled, false);
});

test("runNightly validates its inputs", () => {
  assert.throws(() => runNightly({ outDir: tmpdir() }), /requires an aggregator/);
  assert.throws(
    () => runNightly({ aggregator: createAggregator(), outDir: null }),
    /requires an outDir/,
  );
});

// --- D1 reference schema ------------------------------------------------------

test("d1-schema.sql: aggregate-only, no per-device columns", () => {
  const sql = readFileSync(join(root, "lib", "telemetry", "server", "d1-schema.sql"), "utf8");
  for (const table of ["fleet_windows", "fleet_counters", "fleet_policies", "fleet_gate"]) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), table);
  }
  // Privacy by construction: strip comments, then require no per-device
  // column to exist anywhere in the DDL.
  const ddl = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();
  for (const forbidden of ["install_id", "nonce", "ip_address", "user_agent"]) {
    assert.ok(!ddl.includes(forbidden), `no ${forbidden} column: privacy by construction`);
  }
  // The counter allowlist mirrors the client/server vocabulary.
  for (const c of ["kept_30d", "outcome_success", "removed_fast", "invoked_sessions", "questions_answered"]) {
    assert.ok(sql.includes(`'${c}'`), `counter ${c} in the allowlist`);
  }
});
