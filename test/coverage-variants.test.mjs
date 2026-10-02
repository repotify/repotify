// Coverage-gate variants (2026-10-01 experiment): strict (default), loose
// (Variant A: near-top scorers bypass), jaccard (Variant B: graded redundancy).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  selectSet,
  coverageVariant,
  COVERAGE_VARIANTS,
  SCORE_MARGIN,
  JACCARD_DROP,
  GATE_REASONS,
} from "../lib/pipeline/recommend/present.mjs";

// Each synthetic item does its own job (cluster = id) unless a test sets one.
const mkItem = (over) => ({
  id: "x",
  type: "skill",
  tier: "mission",
  cluster: "x",
  capabilities: [],
  needs: [],
  stacks: ["*"],
  descriptionChars: 100,
  summary: "x",
  security: { level: "verified" },
  signals: { lastCommitDays: 5 },
  conflicts: [],
  ...over,
  cluster: over.cluster ?? over.id ?? "x",
});
const mk = (id, score, caps, needs = []) => ({
  item: mkItem({ id, capabilities: caps, needs }),
  score, parts: {}, flags: [], reasons: [],
});
const demand = (over) => ({
  stacks: [],
  platforms: [],
  capabilitiesWanted: ["tdd-discipline", "pdf-processing"],
  needs: ["testing"],
  ...over,
});

// Run fn with REPOTIFY_COVERAGE_VARIANT set; always restore.
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

test("coverageVariant: defaults to jaccard, rejects unknown values", () => {
  withVariant(undefined, () => assert.equal(coverageVariant(), "jaccard"));
  withVariant("bogus", () => assert.equal(coverageVariant(), "jaccard"));
  withVariant("strict", () => assert.equal(coverageVariant(), "strict"));
  withVariant("loose", () => assert.equal(coverageVariant(), "loose"));
  withVariant("jaccard", () => assert.equal(coverageVariant(), "jaccard"));
  assert.deepEqual([...COVERAGE_VARIANTS].sort(), ["hybrid", "jaccard", "loose", "strict"]);
});

test("variant strict: binary gate unchanged (shares-one-token => dropped)", () => {
  const scored = [mk("x", 0.9, ["tdd-discipline"]), mk("y", 0.8, ["tdd-discipline"]), mk("z", 0.7, ["pdf-processing"])];
  const { selected, skipped } = withVariant("strict", () =>
    selectSet(scored, { budgetChars: 6000, demand: demand() }));
  assert.deepEqual(selected.map((s) => s.item.id).sort(), ["x", "z"]);
  assert.ok(skipped.some((s) => s.id === "y" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_STRICT));
});

test("variant loose: near-top scorer bypasses the gate", () => {
  // y is within SCORE_MARGIN of top (0.9): bypasses. w is outside: gated out.
  const scored = [
    mk("x", 0.9, ["tdd-discipline"]),
    mk("y", 0.9 - SCORE_MARGIN, ["tdd-discipline"]),
    mk("w", 0.9 - SCORE_MARGIN - 0.01, ["tdd-discipline"]),
  ];
  const { selected, skipped } = withVariant("loose", () =>
    selectSet(scored, { budgetChars: 6000, demand: demand() }));
  assert.ok(selected.some((s) => s.item.id === "x"));
  assert.ok(selected.some((s) => s.item.id === "y"), "near-top y bypasses the gate");
  assert.ok(skipped.some((s) => s.id === "w" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_STRICT));
});

test("variant loose: strict behavior for the long tail is untouched", () => {
  const scored = [mk("x", 0.9, ["tdd-discipline"]), mk("y", 0.5, ["tdd-discipline"])];
  const { selected } = withVariant("loose", () =>
    selectSet(scored, { budgetChars: 6000, demand: demand() }));
  assert.deepEqual(selected.map((s) => s.item.id), ["x"]);
});

test("variant jaccard: near-duplicate dropped, distinctive admitted", () => {
  const x = mk("x", 0.9, ["tdd-discipline"], ["testing"]); // wanted toks {tdd-discipline, testing}
  const y = mk("y", 0.85, ["tdd-discipline"], ["testing"]); // identical -> Jaccard 1.0 -> dropped
  const z = mk("z", 0.8, ["pdf-processing"], ["testing"]); // Jaccard 1/3 < 0.6 -> admitted
  const { selected, skipped } = withVariant("jaccard", () =>
    selectSet([x, y, z], { budgetChars: 6000, demand: demand() }));
  const ids = selected.map((s) => s.item.id);
  assert.ok(ids.includes("x"));
  assert.ok(ids.includes("z"), "distinctive z admitted under graded redundancy");
  assert.ok(skipped.some((s) => s.id === "y" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD), "near-duplicate y dropped");
});

test("variant jaccard: item with zero wanted tokens falls back to strict", () => {
  const x = mk("x", 0.9, ["tdd-discipline"]);
  const q = mk("q", 0.8, ["unrelated-cap"], ["unrelated-need"]); // no wanted tokens at all
  const { selected } = withVariant("jaccard", () =>
    selectSet([x, q], { budgetChars: 6000, demand: demand() }));
  assert.deepEqual(selected.map((s) => s.item.id), ["x"]);
});

test("variant jaccard: threshold constant is sane", () => {
  assert.ok(JACCARD_DROP > 0.5 && JACCARD_DROP < 1, "drop bar must be strict-majority similarity");
});

test("variant hybrid: admits when near-top OR not near-duplicate", () => {
  // y: near-top by score but a near-duplicate of x -> admitted via score band.
  // z: far from top by score but distinctive -> admitted via jaccard.
  // w: far from top AND a near-duplicate -> dropped.
  const x = mk("x", 0.9, ["tdd-discipline"], ["testing"]);
  const y = mk("y", 0.85, ["tdd-discipline"], ["testing"]);
  const z = mk("z", 0.5, ["pdf-processing"], ["testing"]);
  const w = mk("w", 0.5, ["tdd-discipline"], ["testing"]);
  const { selected, skipped } = withVariant("hybrid", () =>
    selectSet([x, y, z, w], { budgetChars: 6000, demand: demand() }));
  const ids = selected.map((s) => s.item.id);
  assert.ok(ids.includes("x"));
  assert.ok(ids.includes("y"), "near-top y admitted despite duplication");
  assert.ok(ids.includes("z"), "distinctive z admitted despite low score");
  assert.ok(skipped.some((s) => s.id === "w" && s.reason === GATE_REASONS.NO_NEW_COVERAGE_JACCARD), "low-score duplicate w dropped");
});

test("variants are deterministic across runs", () => {
  const scored = [mk("x", 0.9, ["tdd-discipline"]), mk("y", 0.85, ["tdd-discipline"]), mk("z", 0.8, ["pdf-processing"])];
  for (const v of COVERAGE_VARIANTS) {
    const a = withVariant(v, () => selectSet(scored, { budgetChars: 6000, demand: demand() }).selected.map((s) => s.item.id));
    const b = withVariant(v, () => selectSet(scored, { budgetChars: 6000, demand: demand() }).selected.map((s) => s.item.id));
    assert.deepEqual(a, b, `variant ${v} must be deterministic`);
  }
});
