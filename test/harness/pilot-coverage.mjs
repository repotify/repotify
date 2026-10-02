#!/usr/bin/env node
// Coverage-gate experiment pilot (2026-10-01): strict vs loose vs jaccard.
// Protocol mirrors pilot-p1.mjs: for each scenario x arm x rep, resolve the
// arm's skill set and score it with a TAKE-ALL mock agent. This isolates
// PIPELINE routing quality from agent sampling whims.
// Arms: repotify (strict default), repotify-loose (Variant A), repotify-jaccard
// (Variant B), v1-baseline, none, naive (references).
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARMS, loadCatalog, resolveArmSet } from "./arms.mjs";
import { scoreRouting } from "./rubric.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const catalog = loadCatalog((f) => JSON.parse(readFileSync(join(here, "..", "..", "catalog", f), "utf8")));

function loadScenarios() {
  return readdirSync(join(here, "scenarios")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(here, "scenarios", f), "utf8")));
}

const ARMS_PILOT = ["repotify", "repotify-loose", "repotify-jaccard", "repotify-hybrid", "v1-baseline", "none", "naive"];
// CI can shrink the repetition count (PILOT_REPS) for speed: the v2 arms are
// deterministic, so the --check verdict does not depend on it.
const REPS = Math.max(1, Number(process.env.PILOT_REPS ?? 30) || 30);
for (const a of ARMS_PILOT) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);

// Regression verdict for CI (--check): encodes the experiment's conclusion
// (jaccard won) as a gate. jaccard must not lose to strict on recall or nDCG,
// and F1 may regress at most 0.05. Pure function so unit tests can feed it
// synthetic rows without running the pilot.
export function checkPilotOutcome(out) {
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const summary = {};
  for (const a of ["repotify", "repotify-jaccard"]) {
    const rows = out.filter((r) => r.arm === a);
    if (!rows.length) return { pass: false, failures: [`arm ${a} missing from pilot output`], summary };
    summary[a] = {
      recall: +mean(rows.map((r) => r.routing_recall ?? 0)).toFixed(3),
      ndcg: +mean(rows.map((r) => r.routing_ndcg ?? 0)).toFixed(3),
      f1: +mean(rows.map((r) => r.routing_f1 ?? 0)).toFixed(3),
    };
  }
  const failures = [];
  const j = summary["repotify-jaccard"];
  const s = summary["repotify"]; // the "repotify" arm pins the strict variant
  if (!(j.recall >= s.recall - 1e-9)) failures.push(`jaccard recall ${j.recall} < strict recall ${s.recall}`);
  if (!(j.ndcg >= s.ndcg - 1e-9)) failures.push(`jaccard ndcg ${j.ndcg} < strict ndcg ${s.ndcg}`);
  if (!(j.f1 >= s.f1 - 0.05)) failures.push(`jaccard f1 ${j.f1} regressed >0.05 vs strict f1 ${s.f1}`);
  return { pass: failures.length === 0, failures, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
const out = [];
for (const scenario of loadScenarios()) {
  for (const arm of ARMS_PILOT) {
    for (let rep = 0; rep < REPS; rep++) {
      const armSet = await resolveArmSet({ arm, catalog, scenario, repIndex: rep });
      const routing = scoreRouting(armSet.ids, scenario, armSet.ids.length);
      out.push({
        event: "coverage_pilot", protocol: "take-all-mock-agent",
        scenario: scenario.id, arm, rep,
        offered: armSet.ids.length, source: armSet.source,
        coverage_variant: armSet.meta?.coverageVariant ?? null,
        routing_recall: routing.recall, routing_precision: routing.precision,
        routing_f1: routing.f1, routing_ndcg: routing.ndcg,
        routing_hits: routing.hits, routing_of: routing.of,
        routing_violations: routing.violations,
      });
    }
  }
  console.log(`scenario ${scenario.id} done`);
}

const outPath = join(here, "runs", "coverage-pilot.jsonl");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n");

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
console.log(`\n# Coverage pilot: n=${REPS}/arm, ${loadScenarios().length} scenarios, take-all mock agent`);
for (const [a, b] of [["repotify-loose", "repotify"], ["repotify-jaccard", "repotify"], ["repotify-hybrid", "repotify"], ["repotify-hybrid", "repotify-loose"], ["repotify-hybrid", "repotify-jaccard"]]) {
  for (const f of ["routing_recall", "routing_precision", "routing_f1", "routing_ndcg"]) {
    const ds = pairedDelta(a, b, f);
    const [lo, hi] = ci95(ds);
    console.log(`${a}-${b} ${f}: n=${ds.length} mean_delta=${mean(ds).toFixed(3)} ci95=[${lo.toFixed(3)},${hi.toFixed(3)}]`);
  }
}
// Per-arm means + mean set size for the record.
for (const a of ARMS_PILOT) {
  const rs = out.filter((r) => r.arm === a);
  console.log(`${a}: recall=${mean(rs.map((r) => r.routing_recall)).toFixed(3)} precision=${mean(rs.map((r) => r.routing_precision)).toFixed(3)} f1=${mean(rs.map((r) => r.routing_f1)).toFixed(3)} ndcg=${mean(rs.map((r) => r.routing_ndcg)).toFixed(3)} mean_offered=${mean(rs.map((r) => r.offered)).toFixed(1)}`);
}
// Per-scenario recall for the v2 arms (where do the variants win/lose?).
for (const s of loadScenarios()) {
  const r = (a) => mean(out.filter((x) => x.arm === a && x.scenario === s.id).map((x) => x.routing_recall)).toFixed(2);
  console.log(`scenario ${s.id}: recall strict=${r("repotify")} loose=${r("repotify-loose")} jaccard=${r("repotify-jaccard")}`);
}
console.log(`wrote ${outPath}`);

if (process.argv.includes("--check")) {
  const verdict = checkPilotOutcome(out);
  console.log(`\n# pilot regression check: ${verdict.pass ? "PASS" : "FAIL"}`);
  console.log(`  strict:  ${JSON.stringify(verdict.summary["repotify"])}`);
  console.log(`  jaccard: ${JSON.stringify(verdict.summary["repotify-jaccard"])}`);
  for (const f of verdict.failures) console.log(`  FAIL: ${f}`);
  if (!verdict.pass) process.exit(1);
}
}

