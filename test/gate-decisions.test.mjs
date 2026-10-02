// Gate decision logging (BACKLOG: gate karar loglama, 2026-10-01): every
// coverage-gate verdict is a structured record — reason code, Jaccard value,
// blocker id — and the trail flows into the Stage 0 recommendation event as
// `gate_decisions` (trackRecommendationV1 in src/cli.mjs).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  selectSet,
  present,
  GATE_REASONS,
  JACCARD_DROP,
} from "../lib/pipeline/recommend/present.mjs";
import { validateEvent } from "../lib/telemetry/schema.mjs";

const mkItem = (over) => ({
  id: "xa",
  type: "skill",
  tier: "mission",
  cluster: "xa",
  capabilities: [],
  needs: [],
  stacks: ["*"],
  descriptionChars: 100,
  summary: "xa",
  security: { level: "verified" },
  signals: { lastCommitDays: 5 },
  conflicts: [],
  ...over,
});
const mk = (id, score, caps, needs = [], over = {}) => ({
  item: mkItem({ id, capabilities: caps, needs, ...over }),
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

const byId = (gateDecisions) => Object.fromEntries(gateDecisions.map((g) => [g.skill_id, g]));

test("gate decision record format: one full record per evaluated candidate", () => {
  const scored = [
    mk("xa", 0.9, ["tdd-discipline"], ["testing"]),
    mk("ya", 0.85, ["tdd-discipline"], ["testing"]),
    mk("za", 0.7, ["pdf-processing"], ["testing"]),
  ];
  const { gateDecisions, variant } = withVariant("jaccard", () =>
    selectSet(scored, { budgetChars: 6000, demand: demand() }));
  assert.equal(variant, "jaccard");
  assert.equal(gateDecisions.length, 3);
  for (const g of gateDecisions) {
    assert.ok(typeof g.skill_id === "string" && g.skill_id.length > 0);
    assert.ok(g.decision === "selected" || g.decision === "dropped");
    assert.ok(typeof g.reason === "string" && g.reason.length > 0);
    assert.equal(g.variant, "jaccard");
    assert.ok(g.jaccard === null || (typeof g.jaccard === "number" && g.jaccard >= 0 && g.jaccard <= 1));
    assert.ok(g.blocker === null || typeof g.blocker === "string");
  }
});

test("jaccard drop carries the jaccard value and the blocker id", () => {
  const x = mk("xa", 0.9, ["tdd-discipline"], ["testing"]);
  const y = mk("ya", 0.85, ["tdd-discipline"], ["testing"]); // identical -> Jaccard 1.0
  const { gateDecisions, skipped } = withVariant("jaccard", () =>
    selectSet([x, y], { budgetChars: 6000, demand: demand() }));
  const g = byId(gateDecisions).ya;
  assert.equal(g.decision, "dropped");
  assert.equal(g.reason, GATE_REASONS.NO_NEW_COVERAGE_JACCARD);
  assert.ok(g.jaccard >= JACCARD_DROP, `jaccard ${g.jaccard} >= threshold ${JACCARD_DROP}`);
  assert.equal(g.blocker, "xa");
  const s = skipped.find((sk) => sk.id === "ya");
  assert.equal(s.reason, GATE_REASONS.NO_NEW_COVERAGE_JACCARD);
  assert.equal(s.jaccard, g.jaccard);
  assert.equal(s.blocker, "xa");
});

test("jaccard pass records the max similarity and the nearest blocker", () => {
  const x = mk("xa", 0.9, ["tdd-discipline"], ["testing"]); // wanted toks {tdd-discipline, testing}
  const z = mk("za", 0.8, ["pdf-processing"], ["testing"]); // Jaccard 1/3 -> pass
  const { gateDecisions } = withVariant("jaccard", () =>
    selectSet([x, z], { budgetChars: 6000, demand: demand() }));
  const g = byId(gateDecisions).za;
  assert.equal(g.decision, "selected");
  assert.equal(g.reason, GATE_REASONS.JACCARD_PASS);
  assert.ok(g.jaccard < JACCARD_DROP, `jaccard ${g.jaccard} below threshold`);
  assert.equal(g.blocker, "xa"); // nearest selected item, even below the drop bar
});

test("strict drop and pass codes (no jaccard fields)", () => {
  const scored = [
    mk("xa", 0.9, ["tdd-discipline"]),
    mk("ya", 0.8, ["tdd-discipline"]),
    mk("za", 0.7, ["pdf-processing"]),
  ];
  const { gateDecisions } = withVariant("strict", () =>
    selectSet(scored, { budgetChars: 6000, demand: demand() }));
  const g = byId(gateDecisions);
  assert.equal(g.ya.decision, "dropped");
  assert.equal(g.ya.reason, GATE_REASONS.NO_NEW_COVERAGE_STRICT);
  assert.equal(g.ya.jaccard, null);
  assert.equal(g.ya.blocker, null);
  assert.equal(g.xa.reason, GATE_REASONS.STRICT_PASS);
  assert.equal(g.za.reason, GATE_REASONS.STRICT_PASS);
});

test("loose score-band bypass and core-tier pass codes", () => {
  const x = mk("xa", 0.9, ["tdd-discipline"]);
  const y = mk("ya", 0.85, ["tdd-discipline"]); // within SCORE_MARGIN of top
  const c = mk("ca", 0.5, ["tdd-discipline"], [], { tier: "core" });
  const { gateDecisions } = withVariant("loose", () =>
    selectSet([x, y, c], { budgetChars: 6000, demand: demand() }));
  const g = byId(gateDecisions);
  assert.equal(g.ya.decision, "selected");
  assert.equal(g.ya.reason, GATE_REASONS.SCORE_BAND_PASS);
  assert.equal(g.ca.decision, "selected");
  assert.equal(g.ca.reason, GATE_REASONS.CORE_TIER_PASS);
});

test("hybrid double-fail reports the graded jaccard reason", () => {
  const x = mk("xa", 0.9, ["tdd-discipline"], ["testing"]);
  const w = mk("wa", 0.5, ["tdd-discipline"], ["testing"]); // far + near-duplicate
  const { gateDecisions } = withVariant("hybrid", () =>
    selectSet([x, w], { budgetChars: 6000, demand: demand() }));
  const g = byId(gateDecisions).wa;
  assert.equal(g.decision, "dropped");
  assert.equal(g.reason, GATE_REASONS.NO_NEW_COVERAGE_JACCARD);
  assert.equal(g.blocker, "xa");
});

test("budget drop carries BUDGET_EXCEEDED with the gate verdict attached", () => {
  const a = mk("aa", 0.9, ["tdd-discipline"], [], { descriptionChars: 100 });
  const b = mk("ba", 0.7, ["pdf-processing"], [], { descriptionChars: 5000 });
  const { gateDecisions } = withVariant("jaccard", () =>
    selectSet([a, b], { budgetChars: 600, demand: demand() }));
  const g = byId(gateDecisions).ba;
  assert.equal(g.decision, "dropped");
  assert.equal(g.reason, GATE_REASONS.BUDGET_EXCEEDED);
});

test("present() exposes gateDecisions (empty on the reject path)", () => {
  const scored = [
    mk("xa", 0.9, ["tdd-discipline"], ["testing"]),
    mk("ya", 0.85, ["tdd-discipline"], ["testing"]),
  ];
  const ok = withVariant("jaccard", () => present(scored, demand(), {}));
  assert.equal(ok.decision, "recommend");
  assert.ok(Array.isArray(ok.gateDecisions) && ok.gateDecisions.length === 2);
  const rej = present([], demand(), {});
  assert.equal(rej.decision, "reject");
  assert.deepEqual(rej.gateDecisions, []);
});

test("telemetry schema: recommendation event accepts gate_decisions", () => {
  const ev = {
    type: "recommendation",
    ts: new Date().toISOString(),
    install_id: "12345678-1234-1234-1234-123456789abc",
    episode_id: "abcdefab-1234-1234-1234-abcdefabcdef",
    candidates: [{ skill_id: "xa", position: 0, propensity: 0.5, shown: true }],
    gate_decisions: [
      { skill_id: "xa", decision: "selected", reason: "JACCARD_PASS", variant: "jaccard", jaccard: 0.3333, blocker: null },
      { skill_id: "ya", decision: "dropped", reason: "NO_NEW_COVERAGE_JACCARD", variant: "jaccard", jaccard: 1, blocker: "xa" },
    ],
  };
  assert.deepEqual(validateEvent(ev), []);
  const badDecision = {
    ...ev,
    gate_decisions: [{ skill_id: "ya", decision: "maybe", reason: "X", variant: "jaccard", jaccard: 0.5, blocker: null }],
  };
  assert.ok(validateEvent(badDecision).length > 0, "invalid decision rejected");
  const badJaccard = {
    ...ev,
    gate_decisions: [{ skill_id: "ya", decision: "dropped", reason: "X", variant: "jaccard", jaccard: 2, blocker: null }],
  };
  assert.ok(validateEvent(badJaccard).length > 0, "out-of-range jaccard rejected");
  const badField = {
    ...ev,
    gate_decisions: [{ skill_id: "ya", decision: "dropped", reason: "X", variant: "jaccard", jaccard: 0.5, blocker: null, extra: 1 }],
  };
  assert.ok(validateEvent(badField).length > 0, "unknown field rejected");
});
