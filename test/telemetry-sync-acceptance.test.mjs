// P5 ACCEPTANCE (FAZ 9): the fleet policy improves over the FAZ 5 baseline.
//
// Official baseline: lib/pipeline/recommend/score.mjs (scoreCandidates) —
// frozen, untouched. The experiment:
//
// Phase A (collection): N simulated users install skills following the
//   baseline (90% exploit: 3 picks sampled from the baseline top-10;
//   10% randomized explore arm: the simulation's natural-experiment arm,
//   free of selection bias). NOTE: this 10% is the *simulation's* explore
//   arm, not the product exploration policy — DL-007/DL-049 specify
//   perturbation-primary + a <=5% blind quota arm, which no serving path
//   implements (deferred per DL-051; serving stays exploitation-only).
//   Do not read a product "10% quota" into this test: the product quota is
//   DL-049 (<=5%).
//   Outcomes are drawn from per-skill ground-truth quality. Each user
//   `sync`s aggregates (in-process transport); the reference server
//   quarantines 24h, enforces min-group-size 5, and the nightly job computes
//   fleet-policy.json.
// Phase B (measurement): fresh users on explore-arm (randomized) slates.
//   Metric per episode: mean ground-truth quality of each policy's top-3.
//   Acceptance: fleet beats baseline by >= 10% relative AND the 95% CI of
//   the paired difference excludes 0.
//
// Deterministic: seeded PRNG throughout, no wall-clock dependence.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { scoreCandidates } from "../lib/pipeline/recommend/score.mjs";
import { scoreWithFleet, loadFleetPolicy, FLEET_BLEND } from "../lib/telemetry/fleet-policy.mjs";
import { createTracker } from "../lib/telemetry/store.mjs";
import { buildSyncPayload, applyFleetPolicy, FLEET_POLICY_SCHEMA } from "../lib/telemetry/sync.mjs";
import { writeConfig } from "../src/config.mjs";
import { createAggregator } from "../lib/telemetry/server/aggregate.mjs";
import { computeFleetPolicy } from "../lib/telemetry/server/policy.mjs";
import { computeLeaderboardStatus } from "../lib/telemetry/server/leaderboard.mjs";
import { distribute } from "../lib/telemetry/server/distribute.mjs";

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

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N_SKILLS = 24;
const N_USERS = 48;          // >= 5 distinct syncs per skill via round-robin explore
const EPISODES_PER_USER = 10; // 9 exploit + 1 explore (simulation explore arm)
const TOP3 = 3;

// Ground truth: half the skills are good (q=0.75), half bad (q=0.25),
// shuffled by the master seed. The baseline is quality-blind by construction.
const skillIds = Array.from({ length: N_SKILLS }, (_, i) => `fleet-skill-${String(i + 1).padStart(2, "0")}`);
function groundTruth(masterSeed) {
  const r = mulberry32(masterSeed);
  const shuffled = [...skillIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return Object.fromEntries(shuffled.map((id, i) => [id, i < N_SKILLS / 2 ? 0.75 : 0.25]));
}

// Catalog items crafted so the FAZ 5 baseline is ~equal and quality-blind:
// identical classFit/gate, tiny deterministic freshness jitter.
function catalogItems(seed) {
  const r = mulberry32(seed);
  return skillIds.map((id, i) => ({
    id,
    capabilities: ["cap-x"],
    needs: [],
    stacks: ["*"],
    tier: "tool",
    security: { level: "verified" },
    signals: { lastCommitDays: 5 + Math.floor(r() * 40) },
    _idx: i,
  }));
}
const DEMAND = { capabilitiesWanted: ["cap-x"], needs: [], stacks: [] };

function baselineRanking(items) {
  const narrowed = { candidates: items.map((item) => ({ item })), unmet: [] };
  return scoreCandidates(narrowed, DEMAND).map((row) => row.item.id);
}

const dir = () => mkTemp("rp-fleet-");

// One simulated user: episodes -> local events -> sync payload.
function simulateUser(u, items, baselineTop10, quality, masterSeed) {
  const d = dir();
  const env = { REPOTIFY_HOME: d };
  writeConfig(env, { telemetry: true, telemetryNoticeShown: true });
  const t0 = Date.parse("2026-05-10T00:00:00Z") + u * 3600 * 1000;
  let tick = 0;
  const now = () => new Date(t0 + tick++ * 1000).toISOString();
  const tracker = createTracker({ env, dir: d, installId: randomUUID(), now });
  const rng = mulberry32(masterSeed + u);
  const session = `sess-${u}`;

  const recordInstall = (skillId, episodeId, fromRecommendation) => {
    const q = quality[skillId];
    tracker.track({ type: "install", skill_id: skillId, episode_id: episodeId, from_recommendation: fromRecommendation });
    tracker.track({ type: "invoke", skill_id: skillId, invocation_kind: "explicit", session_id: session });
    const success = rng() < q;
    tracker.track({ type: "outcome", skill_id: skillId, task_success: success });
    if (success) tracker.track({ type: "kept_30d", skill_id: skillId });
    else tracker.track({ type: "removed_fast", skill_id: skillId, removal_reason: "unused" });
  };

  for (let e = 0; e < EPISODES_PER_USER; e++) {
    const episodeId = randomUUID();
    const isExplore = e === EPISODES_PER_USER - 1; // the simulation explore arm
    if (isExplore) {
      // Natural experiment arm: randomized slate, deterministic round-robin
      // coverage so every skill reaches the min-group-size bar.
      const picks = [u % N_SKILLS, (u + 8) % N_SKILLS, (u + 16) % N_SKILLS].map((i) => skillIds[i]);
      tracker.track({
        type: "recommendation", episode_id: episodeId, randomized: true,
        candidates: picks.map((skill_id, position) => ({ skill_id, position, propensity: 1 / N_SKILLS, shown: true, is_explore: true })),
      });
      for (const s of picks) recordInstall(s, episodeId, true);
    } else {
      // Exploit arm: user picks 3 from the baseline top-10.
      const pool = [...baselineTop10];
      const picks = [];
      for (let k = 0; k < 3; k++) picks.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
      tracker.track({
        type: "recommendation", episode_id: episodeId, randomized: false,
        candidates: baselineTop10.map((skill_id, position) => ({ skill_id, position, propensity: 0.9, shown: true })),
      });
      for (const s of picks) recordInstall(s, episodeId, true);
    }
  }
  const built = buildSyncPayload({ env });
  assert.equal(built.status, "ready", `user ${u} should have a payload`);
  return { payload: built.payload, home: d, env };
}

// One full run of the P5 experiment under a master seed: collection,
// sync, nightly, measurement. Returns the paired-improvement metrics;
// per-run invariants are asserted inside, the acceptance gate across seeds
// is asserted by the outer test.
function runExperiment(masterSeed) {
  const quality = groundTruth(masterSeed);
  const items = catalogItems(masterSeed ^ 0x9e37);
  const ranked = baselineRanking(items);
  const baselineTop10 = ranked.slice(0, 10);
  const baseMeanQ = ranked.slice(0, TOP3).reduce((s, id) => s + quality[id], 0) / TOP3;
  console.log(`    seed ${masterSeed}: baseline top-3 mean ground-truth quality: ${baseMeanQ.toFixed(3)} (quality-blind)`);

  // ---- Phase A: collection + sync + nightly job ----
  // Server clock starts after the last user's window (ingest rejects future windows).
  const clock = { t: Date.parse("2026-05-13T00:00:00Z") };
  const server = createAggregator({ now: () => new Date(clock.t) });
  const homes = [];
  for (let u = 0; u < N_USERS; u++) {
    const { payload, home, env } = simulateUser(u, items, baselineTop10, quality, masterSeed);
    homes.push({ home, env });
    server.ingest(payload); // quarantined on arrival
  }
  assert.equal(server.admit().admitted, 0, "quarantine holds before 24h");
  clock.t += 25 * 3600 * 1000; // the nightly job runs
  const admitted = server.admit();
  assert.equal(admitted.admitted, N_USERS);
  const snapshot = server.snapshot();
  assert.equal(snapshot.suppressed.length, 0, `every skill reaches min group size; suppressed: ${snapshot.suppressed}`);
  assert.equal(Object.keys(snapshot.skills).length, N_SKILLS);
  const policy = computeFleetPolicy(snapshot, { now: () => new Date(clock.t) });
  assert.equal(policy.schema, FLEET_POLICY_SCHEMA);
  const lb = computeLeaderboardStatus(snapshot);
  assert.equal(lb.enabled, false, "48 installs < 200: 8b stays flagged");
  const bundle = join(dir(), "catalog-bundle");
  const { policyPath } = distribute({ policy, leaderboardStatus: lb, outDir: bundle });
  console.log(`    nightly: ${admitted.admitted} syncs admitted, ${policy.skills_published} skills published, policy -> ${policyPath}`);

  // Sanity: the fleet learned the ground truth ordering.
  const effs = Object.entries(policy.skills).map(([id, s]) => [id, s.effectiveness]);
  const goodMean = effs.filter(([id]) => quality[id] === 0.75).reduce((a, [, e]) => a + e, 0) / (N_SKILLS / 2);
  const badMean = effs.filter(([id]) => quality[id] === 0.25).reduce((a, [, e]) => a + e, 0) / (N_SKILLS / 2);
  console.log(`    seed ${masterSeed}: fleet effectiveness: good skills ${goodMean.toFixed(3)}, bad skills ${badMean.toFixed(3)}`);
  assert.ok(goodMean > badMean + 0.2, "fleet separates good from bad skills");

  // The sync round-trip persists the policy where the client finds it.
  const { env: env0 } = homes[0];
  applyFleetPolicy({ env: env0, policy });
  const loaded = loadFleetPolicy({ env: env0 });
  assert.ok(loaded && loaded.skills["fleet-skill-01"], "policy round-trips through the local file");

  // ---- Phase B: measurement on the explore (randomized) arm ----
  // Uses the LOADED policy (JSON round-trip through the local file): the
  // measurement is end-to-end, not on the in-memory object.
  const mrng = mulberry32(masterSeed ^ 0x51f7);
  const diffs = [];
  const qBase = [], qFleet = [];
  const N_MEASURE = 20;
  for (let m = 0; m < N_MEASURE; m++) {
    // Randomized slate: the simulation explore arm, free of selection bias.
    const order = [...items];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(mrng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const narrowed = { candidates: order.map((item) => ({ item })), unmet: [] };
    const base = scoreCandidates(narrowed, DEMAND);
    const withFleet = scoreWithFleet(base, loaded);
    const meanQ = (rows) => rows.slice(0, TOP3).reduce((s, r) => s + quality[r.item.id], 0) / TOP3;
    const qb = meanQ(base), qf = meanQ(withFleet);
    qBase.push(qb); qFleet.push(qf); diffs.push(qf - qb);
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mBase = mean(qBase), mFleet = mean(qFleet), mDiff = mean(diffs);
  const relImprovement = mDiff / mBase;
  console.log(`    seed ${masterSeed}: baseline top-3 quality: ${mBase.toFixed(3)} | fleet top-3 quality: ${mFleet.toFixed(3)}`);
  console.log(`    seed ${masterSeed}: paired improvement: +${(mDiff).toFixed(3)} (rel +${(relImprovement * 100).toFixed(1)}%), n=${N_MEASURE}`);
  return { relImprovement, mDiff, mBase, mFleet, goodMean, badMean };
}

// P5 acceptance, multi-seed: the old single-seed run produced a degenerate
// CI [0.333, 0.333] (deterministic simulation — a CI with no variance proves
// nothing). Running the experiment under 5 master seeds gives the gate real
// variance: the mean relative improvement must clear 10% AND the 95% CI of
// the per-seed paired differences must exclude 0.
// (The 10% here is the acceptance threshold measured on the simulation's
// natural-experiment arm — it is NOT the product exploration quota, which
// is DL-049: <=5%.)
test("P5: fleet policy suggestions improve over the FAZ 5 baseline (measured, multi-seed)", () => {
  const seeds = [20261001, 101, 202, 303, 404];
  const results = seeds.map((s) => ({ seed: s, ...runExperiment(s) }));
  const diffs = results.map((r) => r.mDiff);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mDiff = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mDiff) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  // t_{0.975, df=4} = 2.776 for the 5-seed CI.
  const ciLo = mDiff - 2.776 * se, ciHi = mDiff + 2.776 * se;
  const meanRel = mean(results.map((r) => r.relImprovement));
  console.log(`    across seeds: mean rel improvement +${(meanRel * 100).toFixed(1)}%, 95% CI of paired diff [${ciLo.toFixed(3)}, ${ciHi.toFixed(3)}]`);
  for (const r of results) {
    console.log(`      seed ${r.seed}: rel +${(r.relImprovement * 100).toFixed(1)}%, diff +${r.mDiff.toFixed(3)}`);
  }
  assert.ok(meanRel >= 0.10, `P5 acceptance: >= 10% mean relative improvement across seeds, got ${(meanRel * 100).toFixed(1)}%`);
  assert.ok(ciLo > 0, `P5 acceptance: 95% CI across seeds excludes 0, got [${ciLo.toFixed(3)}, ${ciHi.toFixed(3)}]`);
  assert.ok(FLEET_BLEND * 0.5 <= 0.1 + 1e-12, "fleet influence stays bounded (±0.1)");
});
