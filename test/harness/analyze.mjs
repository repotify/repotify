#!/usr/bin/env node
// Paired counterfactual analysis for a harness series JSONL.
// Pairs runs by (scenario, rep): delta = armA - armB per pair, bootstrap 95% CI on the mean delta.
import { readFileSync } from "node:fs";
import { bootstrapCI } from "./report.mjs";

const path = process.argv[2];
const runs = readFileSync(path, "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.event === "harness_run" && r.ok);

const key = (r) => `${r.scenario}::${r.rep}`;
const byArm = new Map();
for (const r of runs) {
  const k = `${r.arm}::${key(r)}`;
  byArm.set(k, r);
}
const arms = [...new Set(runs.map((r) => r.arm))].sort();
const scenarios = [...new Set(runs.map((r) => r.scenario))].sort();

function pairedDelta(a, b, field) {
  const ds = [];
  for (const r of runs.filter((x) => x.arm === a)) {
    const other = byArm.get(`${b}::${key(r)}`);
    if (other) ds.push((r[field] ?? 0) - (other[field] ?? 0));
  }
  return ds;
}
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

console.log(`# Paired deltas (pairs = scenario x rep), file: ${path}`);
for (const [a, b] of [["repotify", "none"], ["repotify", "naive"], ["repotify", "jev"], ["repotify", "v1-baseline"], ["jev", "none"]]) {
  if (!arms.includes(a) || !arms.includes(b)) continue;
  for (const field of ["routing_recall", "routing_precision", "routing_f1", "task_score"]) {
    const ds = pairedDelta(a, b, field);
    const ci = bootstrapCI(ds);
    console.log(`${a}-${b} ${field}: n=${ds.length} mean_delta=${mean(ds).toFixed(3)} ci95=[${ci.join(",")}]`);
  }
}

console.log("\n# Per scenario x arm (mean routing_recall / task_score, n reps)");
for (const s of scenarios) {
  for (const a of arms) {
    const rs = runs.filter((r) => r.scenario === s && r.arm === a);
    const rr = rs.map((r) => r.routing_recall), ts = rs.map((r) => r.task_score);
    console.log(`${s} ${a}: n=${rs.length} rout=${mean(rr).toFixed(3)} [${bootstrapCI(rr).join(",")}] task=${mean(ts).toFixed(3)} [${bootstrapCI(ts).join(",")}] viol=${rs.reduce((n, r) => n + r.routing_violations, 0)} cfail=${rs.filter((r) => r.contract_fail_route || r.contract_fail_task).length}`);
  }
}

console.log("\n# Learning curves (--by-rep style): task_score by rep");
for (const s of scenarios) {
  const reps = [...new Set(runs.filter((r) => r.scenario === s).map((r) => r.rep))].sort();
  for (const a of arms) {
    const curve = reps.map((rp) => {
      const r = runs.find((x) => x.scenario === s && x.arm === a && x.rep === rp);
      return r ? `${rp}:${r.task_score.toFixed(2)}/${r.routing_recall.toFixed(2)}` : `${rp}:x`;
    });
    console.log(`${s} ${a}: ${curve.join(" ")}`);
  }
}

console.log("\n# Cost");
const tok = runs.reduce((n, r) => n + (r.tokens_est_in ?? 0) + (r.tokens_est_out ?? 0), 0);
const jevCost = runs.reduce((n, r) => n + (r.skill_set_meta?.jevCost ?? 0), 0);
console.log(`runs=${runs.length} est_tokens=${tok} jev_cost_usd=${jevCost.toFixed(6)}`);
const fails = runs.filter((r) => !r.ok);
console.log(`ok=${runs.length} failed=${fails.length}`);
