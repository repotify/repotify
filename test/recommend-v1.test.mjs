// Tests for lib/pipeline/recommend/: narrow -> score -> present, plus the
// information-gain question ordering and the audit.
import { strict as assert } from "node:assert";
import { test, before } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { narrowCandidates } from "../lib/pipeline/recommend/narrow.mjs";
import { scoreCandidates, needsArbitration, MERIT_WEIGHTS } from "../lib/pipeline/recommend/score.mjs";
import { present, uncertaintyOf, resolveExclusions, selectSet, GATE_REASONS } from "../lib/pipeline/recommend/present.mjs";
import { orderQuestions, nextQuestion } from "../lib/pipeline/recommend/order.mjs";
import { recommendV1 } from "../lib/pipeline/recommend/index.mjs";
import { questionBank } from "../src/needs.mjs";
import { loadCatalog } from "../src/catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let graph;
let catalog;

before(async () => {
  graph = loadSeedGraph(join(root, "data", "graph-seed.json"));
  ({ catalog } = await loadCatalog());
});

// --- Synthetic fixtures -----------------------------------------------------

// Each synthetic item does its own job (cluster = id) unless a test sets one.
const mkItem = (over) => ({
  id: "x",
  type: "skill",
  tier: "mission",
  cluster: "x",
  capabilities: [],
  needs: [],
  stacks: ["*"],
  descriptionChars: 200,
  summary: "x",
  security: { level: "verified" },
  signals: { lastCommitDays: 5 },
  conflicts: [],
  ...over,
  cluster: over.cluster ?? over.id ?? "x",
});

const mkCatalog = (items) => ({
  items,
  taxonomy: {
    capabilities: Object.fromEntries(items.flatMap((i) => i.capabilities).map((c) => [c, {}])),
    needs: { testing: { capabilities: ["tdd-discipline"] }, pdf: { capabilities: ["pdf-processing"] } },
    projectTypes: { "web-app": { needs: ["testing"] } },
    priorities: { security: { label: "Security" }, quality: { label: "Quality" } },
  },
});

const mkGraph = () => ({
  byType: new Map([["provides", []], ["requires", []], ["conflicts_with", []], ["supersedes", []], ["depends_on", []], ["fallback", []]]),
  edgesOf: () => [],
});

const demand = (over) => ({
  stacks: [],
  platforms: [],
  capabilitiesWanted: ["tdd-discipline"],
  capWeights: { "tdd-discipline": 1 },
  needs: ["testing"],
  needWeights: { testing: 1 },
  webOnlyCaps: new Set(),
  ...over,
});

// --- narrow -----------------------------------------------------------------

test("narrow: security-blocked items never survive", () => {
  const cat = mkCatalog([mkItem({ id: "bad", capabilities: ["tdd-discipline"], security: { level: "blocked" } })]);
  const n = narrowCandidates({ catalog: cat, graph: mkGraph(), demand: demand() });
  assert.equal(n.candidates.length, 0);
  assert.ok(n.eliminated.some((e) => e.id === "bad" && e.reasons.includes("security:blocked")));
});

test("narrow: platform mismatch eliminates web-only skills", () => {
  const cat = mkCatalog([
    mkItem({ id: "webby", capabilities: ["tdd-discipline"] }),
  ]);
  const d = demand({ platforms: ["mobile"], webOnlyCaps: new Set(["tdd-discipline"]) });
  const n = narrowCandidates({ catalog: cat, graph: mkGraph(), demand: d });
  assert.ok(n.eliminated.some((e) => e.reasons.includes("platform:mismatch")));
});

test("narrow: stack-tier items die on stack mismatch; installed items are reported", () => {
  const cat = mkCatalog([
    mkItem({ id: "rn", tier: "stack", stacks: ["react-native"], capabilities: ["tdd-discipline"] }),
    mkItem({ id: "have", capabilities: ["tdd-discipline"] }),
  ]);
  const n = narrowCandidates({ catalog: cat, graph: mkGraph(), demand: demand({ stacks: ["nextjs"] }), installed: ["have"] });
  assert.ok(n.eliminated.some((e) => e.id === "rn" && e.reasons.includes("stack:mismatch")));
  assert.ok(n.eliminated.some((e) => e.id === "have" && e.reasons.includes("already-installed")));
  assert.ok(!n.candidates.some((c) => c.item.id === "have"));
});

test("narrow: demand with no overlap eliminates, every elimination has a reason", () => {
  const cat = mkCatalog([mkItem({ id: "zzz", capabilities: ["pdf-processing"], needs: ["pdf"] })]);
  const n = narrowCandidates({ catalog: cat, graph: mkGraph(), demand: demand() });
  assert.equal(n.candidates.length, 0);
  assert.ok(n.eliminated.every((e) => e.reasons.length > 0));
});

// --- score ------------------------------------------------------------------

test("score: merit weights sum to 1 and gate punishes caution", () => {
  const sum = Object.values(MERIT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const good = mkItem({ id: "a", capabilities: ["tdd-discipline"] });
  const meh = mkItem({ id: "b", capabilities: ["tdd-discipline"], security: { level: "caution" } });
  const cat = mkCatalog([good, meh]);
  const n = narrowCandidates({ catalog: cat, graph: mkGraph(), demand: demand() });
  const [sa, sb] = scoreCandidates(n, demand());
  assert.ok(sa.score > sb.score, `${sa.score} > ${sb.score}`);
  assert.ok(sb.flags.includes("caution-verdict"));
});

test("score: jev signal is a small nudge, not the decider", () => {
  const a = mkItem({ id: "a", capabilities: ["tdd-discipline"] });
  const b = mkItem({ id: "b", capabilities: ["tdd-discipline"] });
  const cat = mkCatalog([a, b]);
  const n = narrowCandidates({ catalog: cat, graph: mkGraph(), demand: demand() });
  const plain = scoreCandidates(n, demand());
  const gap = plain[0].score - plain[1].score;
  assert.ok(gap < 0.08, "synthetic tie is ambiguous by construction");
  // Even a maximal Jev signal for the loser cannot flip the ranking by much.
  const withJev = scoreCandidates(n, demand(), { jevSignal: { [plain[1].item.id]: 1 } });
  assert.ok(withJev[0].score - withJev[1].score > -0.06, "jev weight 0.05 cannot dominate");
});

test("score: needsArbitration fires only on genuine ambiguity", () => {
  const a = mkItem({ id: "a", capabilities: ["tdd-discipline"], signals: { lastCommitDays: 5 } });
  const b = mkItem({ id: "b", capabilities: ["tdd-discipline"], signals: { lastCommitDays: 400 } });
  const cat = mkCatalog([a, b]);
  const n = narrowCandidates({ catalog: cat, graph: mkGraph(), demand: demand() });
  const scored = scoreCandidates(n, demand());
  assert.equal(needsArbitration(scored), false, "freshness gap settles it locally");
  const tie = scoreCandidates(n, demand(), { jevSignal: null });
  assert.equal(tie.length, 2);
});

// --- present: default reject -------------------------------------------------

test("present: default reject when there are no candidates", () => {
  const r = present([], demand());
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, "no-candidates");
  assert.deepEqual(r.set, []);
});

test("present: default reject below the fit floor", () => {
  const s = [{ item: mkItem({ id: "weak" }), score: 0.1, parts: {}, flags: [], reasons: [] }];
  const r = present(s, demand());
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, "below-fit-floor");
});

test("present: default reject on thin demand with a tie", () => {
  const thin = demand({ capabilitiesWanted: ["tdd-discipline"], answered: [] });
  const s = [0.5, 0.49].map((score, i) => ({ item: mkItem({ id: `c${i}` }), score, parts: {}, flags: ["thin-demand"], reasons: [] }));
  const r = present(s, thin);
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, "thin-demand-tie");
  const u = uncertaintyOf(s, thin);
  assert.equal(u.uncertain, true);
});

test("present: conflicts resolve to the higher scorer, budget fills by value-per-char", () => {
  const mk = (id, score, chars, tier = "mission") => ({
    item: mkItem({ id, descriptionChars: chars, tier, capabilities: ["tdd-discipline"] }),
    score, parts: {}, flags: [], reasons: [`cap:tdd-discipline`],
  });
  const scored = [mk("a", 0.9, 100), mk("b", 0.8, 100), mk("c", 0.7, 5000), mk("d", 0.6, 100)];
  const { kept, dropped } = resolveExclusions(scored, [["a", "b"]]);
  assert.deepEqual(kept.map((k) => k.item.id).sort(), ["a", "c", "d"]);
  assert.ok(dropped.some((d2) => d2.id === "b"));
  const d = demand({ capabilitiesWanted: ["tdd-discipline", "pdf-processing"], answered: ["needs"] });
  const { selected, skipped } = selectSet(kept, { budgetChars: 600, demand: d });
  // c costs 5000 chars: over budget. a covers the cap first; d adds no new
  // coverage after a, so it is skipped for coverage, not budget.
  assert.ok(selected.some((s) => s.item.id === "a"));
  assert.ok(!selected.some((s) => s.item.id === "c"));
  assert.ok(skipped.some((s) => s.id === "d" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD));
});

test("present: coverage gate keeps the set justified", () => {
  const mk = (id, score, caps) => ({
    item: mkItem({ id, descriptionChars: 100, capabilities: caps }),
    score, parts: {}, flags: [], reasons: [],
  });
  const scored = [mk("x", 0.9, ["tdd-discipline"]), mk("y", 0.8, ["tdd-discipline"]), mk("z", 0.7, ["pdf-processing"])];
  const d = demand({ capabilitiesWanted: ["tdd-discipline", "pdf-processing"], answered: ["needs"] });
  const { selected, skipped } = selectSet(scored, { budgetChars: 6000, demand: d });
  assert.deepEqual(selected.map((s) => s.item.id).sort(), ["x", "z"]);
  assert.ok(skipped.some((s) => s.id === "y" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD));
});

test("present: low-confidence flags are exposed on rows", () => {
  const s = [{
    item: mkItem({ id: "risky", capabilities: ["tdd-discipline"], security: { level: "caution" } }),
    score: 0.5, parts: {}, flags: ["caution-verdict", "via-fallback"], reasons: ["cap:tdd-discipline"],
  }];
  const r = present(s, demand({ capabilitiesWanted: ["tdd-discipline", "pdf-processing"], answered: ["x"] }));
  assert.equal(r.decision, "recommend");
  assert.deepEqual(r.lowConfidence, ["risky"]);
});

// --- question ordering -------------------------------------------------------

test("order: the question that prunes most comes first", () => {
  const { taxonomy } = catalog;
  const items = [
    mkItem({ id: "t1", capabilities: ["tdd-discipline"], needs: ["testing"] }),
    mkItem({ id: "t2", capabilities: ["tdd-discipline"], needs: ["testing"] }),
    mkItem({ id: "p1", capabilities: ["pdf-processing"], needs: ["pdf"] }),
  ];
  const candidates = items.map((item) => ({ item, reasons: [] }));
  const ranked = orderQuestions(questionBank(taxonomy, { stacks: ["nextjs"] }), candidates, taxonomy, demand());
  assert.ok(ranked.length > 0);
  assert.ok(ranked[0].expectedElimination >= ranked[ranked.length - 1].expectedElimination);
  // Deterministic across runs.
  const again = orderQuestions(questionBank(taxonomy, { stacks: ["nextjs"] }), candidates, taxonomy, demand());
  assert.deepEqual(ranked.map((r) => r.question.id), again.map((r) => r.question.id));
});

test("order: nextQuestion returns null when settled or capped", () => {
  const { taxonomy } = catalog;
  const items = [mkItem({ id: "t1", capabilities: ["tdd-discipline"], needs: ["testing"] })];
  const candidates = items.map((item) => ({ item, reasons: [] }));
  const ranked = orderQuestions(questionBank(taxonomy, {}), candidates, taxonomy, demand());
  const scored = [{ item: items[0], score: 0.9, parts: {}, flags: [], reasons: [] }];
  const rich = demand({ capabilitiesWanted: ["tdd-discipline", "pdf-processing"], answered: ["needs"] });
  assert.equal(nextQuestion(ranked, { scored, asked: 0 }), null, "clear winner: no question");
  assert.equal(nextQuestion(ranked, { scored, asked: 3 }), null, "question cap reached");
});

// --- recommendV1 end to end ---------------------------------------------------

test("recommendV1: arbitrate is consulted only when ambiguous, failures degrade", async () => {
  const a = mkItem({ id: "a", capabilities: ["tdd-discipline"] });
  const b = mkItem({ id: "b", capabilities: ["tdd-discipline"] });
  const cat = mkCatalog([a, b]);
  let calls = 0;
  const arbitrate = async (ids) => {
    calls++;
    return Object.fromEntries(ids.map((id) => [id, id === "b" ? 1 : 0]));
  };
  const rich = demand({ capabilitiesWanted: ["tdd-discipline", "pdf-processing"], answered: ["needs"] });
  const r = await recommendV1({ catalog: cat, graph: mkGraph(), demand: rich }, { arbitrate });
  assert.equal(calls, 1, "ambiguous top: arbitrator consulted");
  assert.equal(r.arbitrated, true);

  const failing = async () => {
    throw new Error("jev down");
  };
  const r2 = await recommendV1({ catalog: cat, graph: mkGraph(), demand: rich }, { arbitrate: failing });
  assert.equal(r2.arbitrated, false);
  assert.equal(r2.decision, "recommend", "local ranking survives arbitration failure");
});

test("recommendV1: clear local winner skips arbitration entirely", async () => {
  const a = mkItem({ id: "a", capabilities: ["tdd-discipline"], signals: { lastCommitDays: 2 } });
  const b = mkItem({ id: "b", capabilities: ["tdd-discipline"], signals: { lastCommitDays: 900 } });
  const cat = mkCatalog([a, b]);
  let calls = 0;
  const r = await recommendV1(
    { catalog: cat, graph: mkGraph(), demand: demand({ capabilitiesWanted: ["tdd-discipline", "pdf-processing"], answered: ["needs"] }) },
    { arbitrate: async () => { calls++; return {}; } },
  );
  assert.equal(calls, 0, "no ambiguity: no paid call");
  assert.equal(r.decision, "recommend");
});
