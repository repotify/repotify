#!/usr/bin/env node
// Aggregate harness JSONL into per-scenario x arm means. Learning-curve friendly:
// run with --by-rep to see per-rep values instead of aggregates.
// Usage: node test/harness/report.mjs --in test/harness/runs/series1.jsonl [--by-rep]
import { isMain } from "../../src/util.mjs";
import { readFileSync } from "node:fs";

export function loadRuns(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Seeded bootstrap 95% CI for a mean (pilot-scale: B=1000 default).
export function bootstrapCI(xs, B = 1000, seed = 12345) {
  if (!xs.length) return [0, 0];
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const means = [];
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(rnd() * xs.length)];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(B - 1, Math.floor(p * B))];
  return [+q(0.025).toFixed(3), +q(0.975).toFixed(3)];
}

export function aggregate(runs) {
  const groups = new Map();
  for (const r of runs.filter((x) => x.event === "harness_run" && x.ok)) {
    const k = `${r.scenario}::${r.arm}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
  return [...groups.entries()].map(([k, rs]) => {
    const [scenario, arm] = k.split("::");
    const pick = (f) => rs.map((r) => f(r));
    const rout = pick((r) => r.routing_recall), task = pick((r) => r.task_score), prec = pick((r) => r.routing_precision ?? 0);
    return {
      scenario, arm, n: rs.length,
      routing_recall: +mean(rout).toFixed(3),
      routing_ci95: bootstrapCI(rout),
      // Pragmatist tur2 (c1): at n=3 the bootstrap 95% CI implies inferential
      // rigor that doesn't exist. The site renders the observed min–max spread
      // instead — descriptive, not inferential.
      routing_min: +Math.min(...rout).toFixed(3),
      routing_max: +Math.max(...rout).toFixed(3),
      routing_precision: +mean(prec).toFixed(3),
      routing_f1: +mean(pick((r) => r.routing_f1 ?? 0)).toFixed(3),
      routing_ndcg: +mean(pick((r) => r.routing_ndcg ?? 0)).toFixed(3),
      task_score: +mean(task).toFixed(3),
      task_ci95: bootstrapCI(task),
      task_min: +Math.min(...task).toFixed(3),
      task_max: +Math.max(...task).toFixed(3),
      violations: pick((r) => r.routing_violations).reduce((a, b) => a + b, 0),
      retries: pick((r) => r.retries).reduce((a, b) => a + b, 0),
      contract_fails: pick((r) => (r.contract_fail_route || r.contract_fail_task) ? 1 : 0).reduce((a, b) => a + b, 0),
      tokens_est: Math.round(mean(pick((r) => (r.tokens_est_in ?? 0) + (r.tokens_est_out ?? 0)))),
      latency_ms: Math.round(mean(pick((r) => r.latency_ms ?? 0))),
      // The none arm is shown no skill cards, so its routing recall is 0 by
      // construction (structural zero / negative control), not an empirical finding.
      note: arm === "none" ? "structural zero (negative control: no skill cards shown)" : null,
    };
  }).sort((a, b) => a.scenario.localeCompare(b.scenario) || a.arm.localeCompare(b.arm));
}

export function printTable(rows) {
  const head = ["scenario", "arm", "n", "rout_r", "prec", "task", "viol", "cfail", "retr", "tok", "ms"];
  console.log(head.join("\t"));
  for (const r of rows) {
    console.log([r.scenario, r.arm, r.n, `${r.routing_recall} [${r.routing_ci95.join(",")}]`, r.routing_precision, `${r.task_score} [${r.task_ci95.join(",")}]`, r.violations, r.contract_fails, r.retries, r.tokens_est, r.latency_ms].join("\t"));
  }
  if (rows.some((r) => r.note)) console.log("# NOTE: none arm routing recall is a structural zero (negative control), not evidence of a routing effect.");
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const path = args[args.indexOf("--in") + 1];
  const runs = loadRuns(path);
  if (args.includes("--by-rep")) {
    for (const r of runs) console.log([r.scenario, r.arm, r.rep, r.routing_recall?.toFixed(2), r.task_score?.toFixed(2), r.retries, (r.tokens_est_in ?? 0) + (r.tokens_est_out ?? 0)].join("\t"));
  } else {
    printTable(aggregate(runs));
  }
}
