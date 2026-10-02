// Nightly fleet job — the last step of FAZ 9 / 9.3.
//
// One function, one responsibility: turn the day's quarantined syncs into the
// published bundle. The server calls this once a night (Cloudflare Workers
// cron trigger in production; see lib/telemetry/server/README.md):
//
//   admit()            — fold past-quarantine payloads into sums, drop the rest
//   snapshot()         — per-skill sums, thin buckets suppressed (k-anonymity)
//   computeFleetPolicy — empirical-Bayes effectiveness, the public PROOF
//   computeLeaderboardStatus — the 8b gate (200 installs)
//   distribute()       — fleet-policy.json + leaderboard-status.json ship with
//                        the catalog bundle; every install picks them up on
//                        update, no account, no extra round-trip
//
// The recipe (raw counter breakdowns, weighting, per-sync rows, nonces) never
// leaves the server: only the policy document and the gate status are written
// out. Pure orchestration — all the math lives in the modules above, so this
// is trivially testable with an in-memory aggregator.
//
// Node 18+, no dependencies.

import { computeFleetPolicy } from "./policy.mjs";
import { computeLeaderboardStatus } from "./leaderboard.mjs";
import { distribute } from "./distribute.mjs";

/**
 * Run one nightly cycle.
 *
 * @param {object} aggregator  createAggregator() instance (or the D1-backed
 *   production equivalent — same method surface: admit/snapshot).
 * @param {string} outDir      catalog bundle directory receiving the outputs.
 * @param {object} opts        { now, threshold } — threshold overrides the
 *   frozen FLEET_INSTALL_THRESHOLD only in tests.
 */
export function runNightly({ aggregator, outDir, now = () => new Date(), threshold } = {}) {
  if (!aggregator) throw new Error("runNightly requires an aggregator");
  if (!outDir) throw new Error("runNightly requires an outDir");

  const admitted = aggregator.admit();
  const snapshot = aggregator.snapshot();
  const policy = computeFleetPolicy(snapshot, { now });
  const leaderboardStatus = computeLeaderboardStatus(
    snapshot,
    threshold === undefined ? {} : { threshold },
  );
  const { policyPath, statusPath } = distribute({ policy, leaderboardStatus, outDir });

  return {
    admitted,            // { admitted, quarantine_depth, admitted_total }
    skills_published: policy.skills_published,
    skills_suppressed: policy.skills_suppressed,
    leaderboard: leaderboardStatus, // { enabled, installs, threshold }
    policyPath,
    statusPath,
  };
}
