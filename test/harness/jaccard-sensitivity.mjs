#!/usr/bin/env node
// JACCARD_DROP sensitivity sweep (2026-10-01, BACKLOG S1).
//
// The coverage gate's jaccard variant drops a candidate when its max pairwise
// Jaccard similarity (over demand-wanted tokens) with any selected item is
// >= JACCARD_DROP (default 0.6, lib/pipeline/recommend/present.mjs). The sweep
// runs the production selectSet() with its jaccardDrop option at each
// threshold. (It used to re-implement the loop; the copy drifted when the set
// rules gained one-item-per-job, the fit floor and curated-first, and the
// faithfulness check below failed CI.) The check still compares the sweep at
// the default threshold with production present() on every harness scenario.
//
// For each threshold on the grid the script resolves the jaccard arm's set
// for every scenario in test/harness/scenarios/ and scores it with the same
// take-all mock agent the coverage pilot uses (scoreRouting: mustInclude
// recall / precision / F1 / nDCG). Output is a JSON report; CI runs this
// script and fails on (a) faithfulness drift, (b) mustInclude recall at the
// shipped default falling below the published floor (0.857, the pilot recall
// measured after the js-frontend triage fix). The +/-0.1 window around the
// default is reported as a knife-edge flag (informational only: the threshold
// is known to sit on a ~0.1 knife edge; that is a property, not a failure).
//
// Exit codes: 0 = sweep ok, faithfulness holds, baseline floor holds.
//             1 = faithfulness drift or baseline regression.
// The knife-edge flag is a warning on stderr, never a failure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCatalog, seedGraph } from "./arms.mjs";
import { resolveNeeds } from "../../src/needs.mjs";
import {
  demandFor,
  narrowCandidates,
  scoreCandidates,
  resolveExclusions,
  present,
  selectSet,
  SCORE_MARGIN,
  JACCARD_DROP,
  DEFAULT_BUDGET_CHARS,
  MIN_CANDIDATE_FIT,
} from "../../lib/pipeline/recommend/index.mjs";
import { scoreRouting } from "./rubric.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

// The sweep grid. The +/-0.1 window around the shipped default (0.6) is the
// knife-edge window from the BACKLOG item; the wider grid maps the full
// redundancy landscape.
export const JACCARD_GRID = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
// Published pilot recall after the js-frontend triage fix (BACKLOG 2026-10-01:
// "pilot recall 0.857"; tie-contender escape took js-frontend 0.00 -> 1.00).
// This is a floor, not a target: the sweep must never silently accept a
// regression below the last published measurement.
export const RECALL_FLOOR = 0.857;

// Build the exact inputs the production pipeline feeds the gate, mirroring
// recommendV1For in arms.mjs (demand construction) and recommendV1 in
// lib/pipeline/recommend/index.mjs (narrow -> score -> exclusions). No
// arbitration, no fleet blend, no exploration: the harness measures the local
// pipeline deterministically.
export function scenarioInputs(catalog, graph, scenario) {
  const fp = {
    empty: false, stacks: [], inferredNeeds: [],
    agents: { configured: [], skills: [] },
    ...scenario.fingerprint,
  };
  const resolved = resolveNeeds({ fingerprint: fp, answers: scenario.answers ?? {}, taxonomy: catalog.taxonomy });
  const demand = demandFor({ catalog, fingerprint: fp, needs: resolved });
  const narrowed = narrowCandidates({
    catalog, graph, demand,
    installed: [], blocked: [],
    answers: scenario.answers ?? {},
  });
  const scored = scoreCandidates(narrowed, demand, { minFit: MIN_CANDIDATE_FIT });
  const { kept } = resolveExclusions(scored, narrowed.exclusions);
  return { demand, kept };
}

// The production gate (jaccard variant) at another drop threshold.
export function simulateJaccardGate(kept, demand, threshold) {
  const r = selectSet(kept, { demand, jaccardDrop: threshold, budgetChars: DEFAULT_BUDGET_CHARS });
  return { ids: r.selected.map((s) => s.item.id), decisions: r.gateDecisions, budget: r.budget };
}

// Compare the simulation at the shipped default against production present().
// The threshold only affects selectSet(); uncertaintyOf() (the reject path)
// is threshold-independent, so on a reject the expected simulated set is
// empty too.
export function checkFaithfulness(prod, sim) {
  const prodIds = [...prod.set].sort();
  const simIds = [...sim.ids].sort();
  if (JSON.stringify(prodIds) !== JSON.stringify(simIds)) {
    return {
      faithful: false,
      detail: `selected set mismatch: prod=[${prodIds}] sim=[${simIds}]`,
    };
  }
  const prodDec = (prod.gateDecisions ?? []).map((d) => [d.skill_id, d.decision, d.reason].join("|"));
  const simDec = sim.decisions.map((d) => [d.skill_id, d.decision, d.reason].join("|"));
  if (JSON.stringify(prodDec) !== JSON.stringify(simDec)) {
    return { faithful: false, detail: "gate decision sequence mismatch" };
  }
  return { faithful: true, detail: null };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function runSensitivity({ catalog, graph, scenarios, grid = JACCARD_GRID }) {
  // Force the production default variant for the faithfulness baseline.
  delete process.env.REPOTIFY_COVERAGE_VARIANT;

  const perThreshold = [];
  const faithfulness = [];

  for (const t of grid) {
    const rows = [];
    for (const scenario of scenarios) {
      const { demand, kept } = scenarioInputs(catalog, graph, scenario);
      const sim = simulateJaccardGate(kept, demand, t);
      const routing = scoreRouting(sim.ids, scenario, sim.ids.length);
      rows.push({
        scenario: scenario.id,
        offered: sim.ids.length,
        recall: +routing.recall.toFixed(3),
        precision: routing.precision,
        f1: routing.f1,
        ndcg: routing.ndcg,
        hits: routing.hits,
        of: routing.of,
      });
      if (t === JACCARD_DROP) {
        const prod = present(kept, demand, {});
        const fc = checkFaithfulness(prod, sim);
        faithfulness.push({ scenario: scenario.id, ...fc });
      }
    }
    perThreshold.push({
      threshold: t,
      mean_recall: +mean(rows.map((r) => r.recall)).toFixed(3),
      mean_precision: +mean(rows.map((r) => r.precision)).toFixed(3),
      mean_f1: +mean(rows.map((r) => r.f1)).toFixed(3),
      mean_ndcg: +mean(rows.map((r) => r.ndcg)).toFixed(3),
      mean_offered: +mean(rows.map((r) => r.offered)).toFixed(1),
      per_scenario: Object.fromEntries(rows.map((r) => [r.scenario, {
        recall: r.recall, precision: r.precision, f1: r.f1, ndcg: r.ndcg,
        offered: r.offered, hits: r.hits, of: r.of,
      }])),
    });
    console.log(`threshold ${t.toFixed(2)}: mean_recall=${perThreshold.at(-1).mean_recall} mean_offered=${perThreshold.at(-1).mean_offered}`);
  }

  const at = (t) => perThreshold.find((p) => p.threshold === t);
  const win = [0.5, JACCARD_DROP, 0.7].map((t) => at(t)?.mean_recall ?? null);
  const knifeEdge = win.some((r) => r === null) ? null : Math.max(...win) - Math.min(...win) > 1e-9;
  const recallAtDefault = at(JACCARD_DROP)?.mean_recall ?? null;
  const faithful = faithfulness.every((f) => f.faithful);

  return {
    generated_at: new Date().toISOString(),
    variant: "jaccard",
    threshold_default: JACCARD_DROP,
    score_margin: SCORE_MARGIN,
    budget_chars: DEFAULT_BUDGET_CHARS,
    scenarios: scenarios.map((s) => s.id),
    grid,
    faithful,
    faithfulness,
    per_threshold: perThreshold,
    window: {
      minus: 0.5,
      def: JACCARD_DROP,
      plus: 0.7,
      recall: { minus: win[0], def: win[1], plus: win[2] },
      knife_edge: knifeEdge,
    },
    baseline: {
      recall_floor: RECALL_FLOOR,
      recall_at_default: recallAtDefault,
      pass: recallAtDefault !== null && recallAtDefault >= RECALL_FLOOR,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]
    : join(here, "runs", "jaccard-sensitivity.json");

  const catalog = loadCatalog((f) => JSON.parse(readFileSync(join(here, "..", "..", "catalog", f), "utf8")));
  const graph = seedGraph();
  const { readdirSync } = await import("node:fs");
  const scenarios = readdirSync(join(here, "scenarios"))
    .filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(here, "scenarios", f), "utf8")));

  const report = runSensitivity({ catalog, graph, scenarios });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${outPath}`);

  const w = report.window;
  console.log(`window recall: 0.50=${w.recall.minus} 0.60=${w.recall.def} 0.70=${w.recall.plus} knife_edge=${w.knife_edge}`);
  console.log(`baseline: recall@${JACCARD_DROP}=${report.baseline.recall_at_default} floor=${RECALL_FLOOR} pass=${report.baseline.pass}`);
  console.log(`faithfulness: ${report.faithful ? "holds" : "DRIFTED"}`);
  for (const f of report.faithfulness) {
    if (!f.faithful) console.log(`  DRIFT scenario=${f.scenario}: ${f.detail}`);
  }

  if (w.knife_edge) {
    console.error(
      `warning: JACCARD_DROP sits on a knife edge — recall changes within +/-0.1 of the default. ` +
      `See ${outPath}. This is informational, not a failure.`,
    );
  }
  if (!report.faithful) {
    console.error("error: simulation drifted from production present() at the default threshold; the sweep is invalid.");
    process.exit(1);
  }
  if (!report.baseline.pass) {
    console.error(`error: mustInclude recall at the default threshold fell below the published floor (${RECALL_FLOOR}).`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
