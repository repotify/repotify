// Client-side fleet policy hook (FAZ 9).
//
// The FAZ 5 simple score (lib/pipeline/recommend/score.mjs) is the FROZEN
// baseline (P5) — this module never touches it. Instead, when a fleet policy
// has arrived via `repotify sync`, `scoreWithFleet()` applies it as a bounded
// prior on top of the baseline ranking:
//
//   adjusted = clamp01(baseline + FLEET_BLEND * (effectiveness - 0.5))
//
// FLEET_BLEND = 0.2 bounds the fleet's influence to ±0.1: the fleet informs,
// it never dictates. Skills absent from the policy keep their baseline score
// untouched. This is the B2 "fleet's prior" idea served at recommend time,
// and the exact blend the FAZ 9 acceptance test measures.
//
// Node 18+, no dependencies.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../../src/config.mjs";
import { FLEET_POLICY_FILE, FLEET_POLICY_SCHEMA } from "./sync.mjs";

// Bounded influence: the fleet may shift a score by at most ±0.1.
// The principle (FAZ 9 debate d3): the fleet INFORMS, it never DICTATES —
// the frozen P5 baseline (built from our own test battery) can never be
// overruled by fleet data alone, no matter how lopsided the fleet looks.
// The 0.2 factor is a safety clamp, not a tuned parameter; scaling the
// bound with per-skill n (more data → more trust) is future work.
export const FLEET_BLEND = 0.2;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Load the locally saved fleet policy, or null when never synced. */
export function loadFleetPolicy({ env = process.env } = {}) {
  const path = join(homeDir(env), FLEET_POLICY_FILE);
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf8"));
    if (p?.schema !== FLEET_POLICY_SCHEMA || typeof p.skills !== "object") return null;
    return p;
  } catch {
    return null;
  }
}

/** Blend one baseline score with the fleet prior for a skill. */
export function blendScore(baselineScore, skillId, policy, { blend = FLEET_BLEND } = {}) {
  const prior = policy?.skills?.[skillId]?.effectiveness;
  if (typeof prior !== "number") return baselineScore;
  return clamp01(baselineScore + blend * (prior - 0.5));
}

/**
 * Re-rank a scoreCandidates() slate with the fleet prior. Returns new row
 * objects ({ ...row, score, fleetAdjusted }) sorted by adjusted score desc,
 * id asc for determinism. Rows for skills missing from the policy are
 * unchanged. A null policy returns the input untouched.
 */
export function scoreWithFleet(scored, policy, { blend = FLEET_BLEND } = {}) {
  if (!policy) return scored;
  const out = scored.map((row) => {
    const id = row.item?.id ?? row.id;
    const adjusted = blendScore(row.score, id, policy, { blend });
    return {
      ...row,
      score: Math.round(adjusted * 1000) / 1000,
      fleetAdjusted: adjusted !== row.score,
    };
  });
  out.sort((a, b) => b.score - a.score || ((a.item?.id ?? a.id) < (b.item?.id ?? b.id) ? -1 : 1));
  return out;
}
