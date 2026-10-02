// js-frontend triage regression (BACKLOG 2026-10-01): the jaccard variant used to
// compare items over the demand-wanted token subset only. Coarse demand tokens
// made genuinely different skills look like perfect duplicates —
// react-best-practices vs composition-patterns shared exactly {frontend-ui, react}
// of the js-frontend demand vocabulary (wanted-Jaccard 1.0) while their
// capabilities differ (react-performance vs component-architecture), and the
// must-include item was wrongly dropped. Tie-contender escape: an exact score
// tie (scores round to 3 decimals) + a capability kind the blocker lacks admits
// both. The 0.6 threshold and the wanted-token substrate are unchanged.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  selectSet,
  GATE_REASONS,
  JACCARD_DROP,
} from "../lib/pipeline/recommend/present.mjs";

// Each synthetic item does its own job (cluster = id) unless a test sets one.
const mkItem = (over) => ({
  id: "t",
  type: "skill",
  tier: "mission",
  cluster: "t",
  capabilities: [],
  needs: [],
  stacks: [],
  descriptionChars: 100,
  summary: "t",
  security: { level: "verified" },
  signals: { lastCommitDays: 5 },
  conflicts: [],
  ...over,
  cluster: over.cluster ?? over.id ?? "x",
});
const mk = (id, score, over) => ({
  item: mkItem({ id, ...over }),
  score, parts: {}, flags: [], reasons: [],
});
// js-frontend demand shape: coarse vocabulary — only {frontend-ui, react} wanted.
const jsFrontendDemand = () => ({
  stacks: ["react"],
  platforms: [],
  capabilitiesWanted: [],
  needs: ["frontend-ui"],
});

function withVariant(v, fn) {
  const prev = process.env.REPOTIFY_COVERAGE_VARIANT;
  try {
    if (v === undefined) delete process.env.REPOTIFY_COVERAGE_VARIANT;
    else process.env.REPOTIFY_COVERAGE_VARIANT = v;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.REPOTIFY_COVERAGE_VARIANT;
    else process.env.REPOTIFY_COVERAGE_VARIANT = prev;
  }
}

test("js-frontend geometry: exact score tie + new capability kind -> both admitted", () => {
  // composition-patterns vs react-best-practices from the real catalog
  // (field split mirrored exactly; scores tied at 0.859 like the real run).
  const cmp = mk("composition-patterns", 0.859, {
    capabilities: ["component-architecture"],
    needs: ["frontend-ui"],
    stacks: ["react", "nextjs"],
  });
  const rbp = mk("react-best-practices", 0.859, {
    capabilities: ["react-performance"],
    needs: ["performance", "seo", "frontend-ui"],
    stacks: ["react", "nextjs"],
  });
  const { selected, skipped, gateDecisions } = withVariant("jaccard", () =>
    selectSet([cmp, rbp], { budgetChars: 6000, demand: jsFrontendDemand() }));
  const ids = selected.map((s) => s.item.id);
  assert.ok(ids.includes("composition-patterns"), "blocker selected");
  assert.ok(ids.includes("react-best-practices"), "react-best-practices admitted: react-performance is a new kind");
  assert.ok(!skipped.some((s) => s.id === "react-best-practices"), "no drop recorded");
  const g = gateDecisions.find((d) => d.skill_id === "react-best-practices");
  assert.equal(g.decision, "selected");
  assert.equal(g.reason, GATE_REASONS.JACCARD_PASS);
  assert.equal(g.jaccard, 1, "wanted-Jaccard honestly reported as 1.0");
  assert.equal(g.blocker, "composition-patterns");
});

test("true duplicates (same wanted tokens, capabilities contained) are still dropped", () => {
  const a = mk("a", 0.9, { capabilities: ["frontend-ui"], needs: ["frontend-ui"], stacks: ["react"] });
  const b = mk("b", 0.8, { capabilities: ["frontend-ui"], needs: ["frontend-ui"], stacks: ["react"] });
  const { selected, skipped, gateDecisions } = withVariant("jaccard", () =>
    selectSet([a, b], { budgetChars: 6000, demand: jsFrontendDemand() }));
  assert.deepEqual(selected.map((s) => s.item.id), ["a"]);
  const g = gateDecisions.find((d) => d.skill_id === "b");
  assert.equal(g.decision, "dropped");
  assert.equal(g.reason, GATE_REASONS.NO_NEW_COVERAGE_JACCARD);
  assert.ok(skipped.some((s) => s.id === "b" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD));
});

test("specialization contained in the blocker is still dropped (no new kind)", () => {
  // Candidate's capabilities are a subset of the blocker's: genuinely redundant.
  // The specific item scores higher, so it is selected first and blocks the generic.
  const specific = mk("specific", 0.9, {
    capabilities: ["testing", "property-testing"],
    needs: ["testing"],
  });
  const generic = mk("generic", 0.85, {
    capabilities: ["testing"],
    needs: ["testing"],
  });
  const d = () => ({ stacks: [], platforms: [], capabilitiesWanted: [], needs: ["testing"] });
  const { selected, skipped } = withVariant("jaccard", () =>
    selectSet([specific, generic], { budgetChars: 6000, demand: d() }));
  assert.deepEqual(selected.map((s) => s.item.id), ["specific"]);
  assert.ok(skipped.some((s) => s.id === "generic" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD),
    "generic dropped: its kinds are contained in the blocker");
});

test("new kind but clearly lower score -> still dropped (no tie, no escape)", () => {
  // cli-tool geometry: webapp-testing (0.662) vs verification-before-completion
  // (0.702) share wanted-Jaccard 1.0 and differ in kind, but the candidate is
  // not a contender — the blocker stands.
  const vbc = mk("verification-before-completion", 0.702, {
    capabilities: ["verification-gate"],
    needs: ["testing"],
  });
  const wat = mk("webapp-testing", 0.662, {
    capabilities: ["webapp-testing"],
    needs: ["testing"],
  });
  const d = () => ({ stacks: [], platforms: [], capabilitiesWanted: [], needs: ["testing"] });
  const { selected, skipped } = withVariant("jaccard", () =>
    selectSet([vbc, wat], { budgetChars: 6000, demand: d() }));
  assert.deepEqual(selected.map((s) => s.item.id), ["verification-before-completion"]);
  assert.ok(skipped.some((s) => s.id === "webapp-testing" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD),
    "lower-scoring candidate dropped despite a new kind");
});

test("tied + new kind but mid-pack -> still dropped (python-api geometry)", () => {
  // database-optimizer/typescript-pro tied at 0.558 while the top score is
  // 0.846: admitting the tie would waste budget (it starved semgrep).
  const d = () => ({ stacks: [], platforms: [], capabilitiesWanted: [], needs: ["testing", "other-need"] });
  const top = mk("top-item", 0.846, { capabilities: ["top-cap"], needs: ["other-need"] });
  const dbo = mk("database-optimizer", 0.558, {
    capabilities: ["database-tuning"],
    needs: ["testing"],
  });
  const tsp = mk("typescript-pro", 0.558, {
    capabilities: ["typescript"],
    needs: ["testing"],
  });
  const { selected, skipped } = withVariant("jaccard", () =>
    selectSet([top, dbo, tsp], { budgetChars: 6000, demand: d() }));
  assert.ok(selected.some((s) => s.item.id === "database-optimizer"));
  assert.ok(skipped.some((s) => s.id === "typescript-pro" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD),
    "mid-pack tie dropped despite a new kind");
});

test("zero demand overlap still falls back to the strict gate", () => {
  const x = mk("x", 0.9, { capabilities: ["frontend-ui"], stacks: ["react"] });
  const q = mk("q", 0.8, { capabilities: ["unrelated-cap"], needs: ["unrelated-need"] });
  const { selected } = withVariant("jaccard", () =>
    selectSet([x, q], { budgetChars: 6000, demand: jsFrontendDemand() }));
  assert.deepEqual(selected.map((s) => s.item.id), ["x"], "demand-irrelevant q dropped via strict fallback");
});

test("threshold unchanged: JACCARD_DROP still 0.6", () => {
  assert.equal(JACCARD_DROP, 0.6, "triage is structural, not a threshold change");
});
