#!/usr/bin/env node
// JACCARD_DROP sensitivity sweep (2026-10-01, BACKLOG S1).
//
// The coverage gate's jaccard variant drops a candidate when its max pairwise
// Jaccard similarity (over demand-wanted tokens) with any selected item is
// >= JACCARD_DROP (default 0.6, lib/pipeline/recommend/present.mjs). The
// threshold is a module-level const with no env override, so the sweep
// re-implements the gate's greedy loop faithfully here and validates the
// re-implementation against the production `present()` at the default
// threshold on every harness scenario. If the re-implementation ever drifts
// from production, the script fails loudly (faithfulness check) instead of
// publishing a misleading landscape.
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
import { buildDemand } from "../../src/recommend.mjs";
import {
  narrowCandidates,
  scoreCandidates,
  resolveExclusions,
  present,
  SCORE_MARGIN,
  JACCARD_DROP,
  DEFAULT_BUDGET_CHARS,
  GATE_REASONS,
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
  const demand = {
    ...buildDemand({ taxonomy: catalog.taxonomy, fingerprint: fp, needs: resolved }),
    stacks: fp?.stacks ?? [],
    answered: resolved.answered ?? [],
  };
  const narrowed = narrowCandidates({
    catalog, graph, demand,
    installed: [], blocked: [],
    answers: scenario.answers ?? {},
  });
  const scored = scoreCandidates(narrowed, demand);
  const { kept } = resolveExclusions(scored, narrowed.exclusions);
  return { demand, kept };
}

// Faithful re-implementation of selectSet()'s jaccard-variant greedy loop
// (lib/pipeline/recommend/present.mjs), parameterized by the drop threshold.
// Duplication is deliberate: the threshold is a module const in production,
// so the only way to sweep it without touching product code is to re-run the
// loop here. The faithfulness check (compare against present() at the
// default threshold) guards against drift.
export function simulateJaccardGate(kept, demand, threshold) {
  const wantedCaps = new Set(demand.capabilitiesWanted ?? []);
  const wantedNeeds = new Set(demand.needs ?? []);
  const wantedStacks = new Set(demand.stacks ?? []);
  const wantedTokensOf = (item) =>
    new Set(
      [...(item.capabilities ?? []), ...(item.needs ?? []), ...(item.stacks ?? [])].filter(
        (t) => wantedCaps.has(t) || wantedNeeds.has(t) || wantedStacks.has(t),
      ),
    );
  const jaccard = (a, b) => {
    if (!a.size && !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  // Mirrors estimateTokens() in present.mjs (P2: value per token, Turkish bias fix).
  const estimateTokens = (item) => {
    const chars = item.descriptionChars ?? 200;
    const isTurkish = /[ğışçöüİ]/.test(item.summary ?? "");
    return Math.max(12, Math.ceil(chars / (isTurkish ? 5.2 : 4.0)));
  };
  const valuePerToken = (s) => s.score / estimateTokens(s.item);
  const topScore = kept.length ? Math.max(...kept.map((s) => s.score)) : 0;
  const nearTop = (s) => s.score >= topScore - SCORE_MARGIN;
  const round4 = (x) => Math.round(x * 10000) / 10000;

  const servedCaps = new Set();
  const servedNeeds = new Set();
  const servedStacks = new Set();
  const coverageOf = (s) => ({
    caps: (s.item.capabilities ?? []).filter((c) => wantedCaps.has(c) && !servedCaps.has(c)),
    needs: (s.item.needs ?? []).filter((n) => wantedNeeds.has(n) && !servedNeeds.has(n)),
    stacks: (s.item.stacks ?? []).filter((x) => wantedStacks.has(x) && !servedStacks.has(x)),
  });
  const markServed = (s) => {
    for (const c of (s.item.capabilities ?? []).filter((x) => wantedCaps.has(x))) servedCaps.add(c);
    for (const n of (s.item.needs ?? []).filter((x) => wantedNeeds.has(x))) servedNeeds.add(n);
    for (const x of (s.item.stacks ?? []).filter((y) => wantedStacks.has(y))) servedStacks.add(x);
  };

  const selectedTokenSets = []; // [{ id, tokens, score, caps }]
  const maxSimilarity = (s) => {
    const t = wantedTokensOf(s.item);
    let best = { jaccard: 0, blocker: null, blockerScore: -Infinity, blockerCaps: new Set() };
    for (const st of selectedTokenSets) {
      const j = jaccard(t, st.tokens);
      if (j > best.jaccard) {
        best = { jaccard: j, blocker: st.id, blockerScore: st.score, blockerCaps: st.caps };
      }
    }
    return best;
  };

  const gateDecision = (s) => {
    if (s.item.tier === "core") {
      return { pass: true, reason: GATE_REASONS.CORE_TIER_PASS, jaccard: null, blocker: null };
    }
    if (!wantedTokensOf(s.item).size) {
      const cov = coverageOf(s);
      const pass = cov.caps.length > 0 || cov.needs.length > 0 || cov.stacks.length > 0;
      return {
        pass,
        reason: pass ? GATE_REASONS.STRICT_PASS : GATE_REASONS.NO_NEW_COVERAGE_STRICT,
        jaccard: null,
        blocker: null,
      };
    }
    const { jaccard: j, blocker, blockerScore, blockerCaps } = maxSimilarity(s);
    const jr = round4(j);
    if (j >= threshold) {
      const tied = s.score === blockerScore;
      const candCaps = new Set(s.item.capabilities ?? []);
      const addsKind = [...candCaps].some((c) => !blockerCaps.has(c));
      if (!(tied && addsKind && nearTop(s))) {
        return { pass: false, reason: GATE_REASONS.NO_NEW_COVERAGE_JACCARD, jaccard: jr, blocker };
      }
    }
    return { pass: true, reason: GATE_REASONS.JACCARD_PASS, jaccard: jr, blocker };
  };

  const core = kept.filter((s) => s.item.tier === "core");
  const rest = kept
    .filter((s) => s.item.tier !== "core")
    .sort((a, b) => valuePerToken(b) - valuePerToken(a) || (a.item.id < b.item.id ? -1 : 1));
  const ordered = [...core, ...rest];

  let used = 0;
  const selected = [];
  const decisions = [];
  for (const s of ordered) {
    const gd = gateDecision(s);
    if (!gd.pass) {
      decisions.push({ skill_id: s.item.id, decision: "dropped", reason: gd.reason, jaccard: gd.jaccard, blocker: gd.blocker });
      continue;
    }
    const cost = s.item.descriptionChars ?? 200;
    if (used + cost <= DEFAULT_BUDGET_CHARS) {
      used += cost;
      selected.push(s);
      markServed(s);
      selectedTokenSets.push({
        id: s.item.id,
        tokens: wantedTokensOf(s.item),
        score: s.score,
        caps: new Set(s.item.capabilities ?? []),
      });
      decisions.push({ skill_id: s.item.id, decision: "selected", reason: gd.reason, jaccard: gd.jaccard, blocker: gd.blocker });
    } else {
      decisions.push({ skill_id: s.item.id, decision: "dropped", reason: GATE_REASONS.BUDGET_EXCEEDED, jaccard: gd.jaccard, blocker: gd.blocker });
    }
  }
  return { ids: selected.map((s) => s.item.id), decisions, budget: { used, limit: DEFAULT_BUDGET_CHARS } };
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
