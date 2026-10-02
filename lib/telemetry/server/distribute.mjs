// Distribution: the nightly job's last step. fleet-policy.json ships WITH the
// catalog bundle (same release train as the catalog data), so every install
// picks up the fleet's wisdom on update — no extra round-trip, no account,
// no tracking of who fetched it.
//
// Writes into outDir (the catalog bundle directory):
//   fleet-policy.json       the public proof (per-skill effectiveness)
//   leaderboard-status.json { enabled, installs, threshold } for the 8b flag
//
// Node 18+, no dependencies.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function distribute({ policy, leaderboardStatus, outDir }) {
  if (!outDir) throw new Error("distribute requires an outDir");
  if (!policy || typeof policy !== "object") throw new Error("distribute requires a policy");
  mkdirSync(outDir, { recursive: true });
  const policyPath = join(outDir, "fleet-policy.json");
  const statusPath = join(outDir, "leaderboard-status.json");
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n", "utf8");
  writeFileSync(statusPath, JSON.stringify({ generated_at: policy.computed_at ?? null, ...(leaderboardStatus ?? {}) }, null, 2) + "\n", "utf8");
  return { policyPath, statusPath };
}
