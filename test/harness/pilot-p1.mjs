#!/usr/bin/env node
// P1 routing pilot (2026-10-01): honest v2-vs-v1 routing comparison, n=30/arm.
// Protocol: for each scenario x arm x rep, resolve the arm's skill set and
// score it with a TAKE-ALL mock agent (chosen = offered set). This isolates
// PIPELINE routing quality from agent sampling whims: routing recall here is
// exactly "fraction of ground-truth must-includes the pipeline offered".
// It does NOT measure agent behavior or task quality — the full two-phase
// GLM pilot (the "2-week experiment") is the follow-up, pending API budget.
// Arms: repotify (v2), v1-baseline (frozen v1), none, naive.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, loadCatalog, resolveArmSet } from "./arms.mjs";
import { scoreRouting } from "./rubric.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const catalog = loadCatalog((f) => JSON.parse(readFileSync(join(here, "..", "..", "catalog", f), "utf8")));

function loadScenarios() {
  return readdirSync(join(here, "scenarios")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(here, "scenarios", f), "utf8")));
}

const ARMS_PILOT = ["repotify", "v1-baseline", "none", "naive"];
const REPS = 30;
for (const a of ARMS_PILOT) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);

const out = [];
for (const scenario of loadScenarios()) {
  for (const arm of ARMS_PILOT) {
    for (let rep = 0; rep < REPS; rep++) {
      const armSet = await resolveArmSet({ arm, catalog, scenario, repIndex: rep });
      const routing = scoreRouting(armSet.ids, scenario, armSet.ids.length);
      out.push({
        event: "p1_routing_pilot", protocol: "take-all-mock-agent",
        scenario: scenario.id, arm, rep,
        offered: armSet.ids.length, source: armSet.source,
        routing_recall: routing.recall, routing_precision: routing.precision,
        routing_f1: routing.f1, routing_ndcg: routing.ndcg,
        routing_hits: routing.hits, routing_of: routing.of,
        routing_violations: routing.violations,
      });
    }
  }
  console.log(`scenario ${scenario.id} done`);
}

const outPath = join(here, "runs", "p1-routing-pilot.jsonl");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n");

// Paired deltas by (scenario, rep), with normal-approx 95% CI.
function pairedDelta(a, b, field) {
  const key = (r) => `${r.scenario}#${r.rep}`;
  const ma = new Map(out.filter((r) => r.arm === a).map((r) => [key(r), r[field]]));
  const ds = [];
  for (const r of out.filter((r) => r.arm === b)) {
    const x = ma.get(key(r));
    if (x !== undefined) ds.push(x - (r[field] ?? 0));
  }
  return ds;
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const ci95 = (xs) => {
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
  const h = 1.96 * sd / Math.sqrt(xs.length);
  return [m - h, m + h];
};
console.log(`\n# P1 routing pilot: n=${REPS}/arm, ${loadScenarios().length} scenarios, take-all mock agent`);
for (const [a, b] of [["repotify", "v1-baseline"], ["repotify", "none"], ["repotify", "naive"]]) {
  for (const f of ["routing_recall", "routing_precision", "routing_f1", "routing_ndcg"]) {
    const ds = pairedDelta(a, b, f);
    const [lo, hi] = ci95(ds);
    console.log(`${a}-${b} ${f}: n=${ds.length} mean_delta=${mean(ds).toFixed(3)} ci95=[${lo.toFixed(3)},${hi.toFixed(3)}]`);
  }
}
// Per-arm means for the record.
for (const a of ARMS_PILOT) {
  const rs = out.filter((r) => r.arm === a);
  console.log(`${a}: recall=${mean(rs.map((r) => r.routing_recall)).toFixed(3)} precision=${mean(rs.map((r) => r.routing_precision)).toFixed(3)} f1=${mean(rs.map((r) => r.routing_f1)).toFixed(3)} ndcg=${mean(rs.map((r) => r.routing_ndcg)).toFixed(3)}`);
}
console.log(`wrote ${outPath}`);
