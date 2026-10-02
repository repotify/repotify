// P5: jury scores as bandit context features (not as a mixed score).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FEATURE_DIM } from "../lib/learn/linucb.mjs";
import { buildContext, juryFeatures, demandFeatures } from "../lib/learn/features.mjs";

test("buildContext returns d=64 vector", () => {
  const x = buildContext({ jury: { quality: 0.9, specificity: 0.8, maintenance: 0.7, agreement: 1.0 } }, {});
  assert.equal(x.length, FEATURE_DIM);
  assert.ok(x.every((v) => typeof v === "number" && Number.isFinite(v)));
});

test("jury scores are raw features (dims 0-3), not mixed", () => {
  const item = { jury: { quality: 0.9, specificity: 0.8, maintenance: 0.7, agreement: 0.6 } };
  const x = buildContext(item, {});
  assert.deepEqual(x.slice(0, 4), [0.9, 0.8, 0.7, 0.6]);
  // No scalar mixture: the four scores stay separate.
  assert.notEqual(x[0], x[1]);
});

test("missing jury defaults to neutral (0.5/0.5/0.5/1.0)", () => {
  const x = buildContext({}, {});
  assert.deepEqual(x.slice(0, 4), [0.5, 0.5, 0.5, 1.0]);
});

test("demand match features are overlap ratios", () => {
  const item = { capabilities: ["a", "b"], needs: ["n1"], stacks: ["s1"] };
  const demand = { wantedCaps: ["a", "c"], needs: ["n1", "n2"], stacks: ["s1"] };
  const [cap, need, stack] = demandFeatures(item, demand);
  assert.equal(cap, 0.5);
  assert.equal(need, 0.5);
  assert.equal(stack, 1.0);
});

test("tier one-hot and badges", () => {
  const x = buildContext({ tier: "core", badges: ["verified"] }, {});
  assert.deepEqual(x.slice(7, 10), [1, 0, 0]);
  assert.deepEqual(x.slice(10, 12), [1, 0]);
});

test("reserved dims are zero", () => {
  const x = buildContext({ jury: { quality: 1, specificity: 1, maintenance: 1, agreement: 1 } }, {});
  assert.ok(x.slice(12).every((v) => v === 0));
});
