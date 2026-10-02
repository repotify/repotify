// Unit tests: lib/learn/explore.mjs (B1 perturbation + DL-049 quota)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTA_RATE, makeRng, randn, perturbContext,
  selectPerturbed, QuotaGuard, quotaPick, isColdStart,
} from "../lib/learn/explore.mjs";
import { LinUCB, FEATURE_DIM } from "../lib/learn/linucb.mjs";

const D = FEATURE_DIM;

test("QUOTA_RATE pinned at 0.05 (DL-049)", () => {
  assert.equal(QUOTA_RATE, 0.05);
});

test("makeRng is deterministic", () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
  const c = makeRng(43);
  assert.notEqual(a(), c()); // (overwhelmingly likely; streams differ)
});

test("perturbContext: same seed -> same noise; sigma=0 rejected", () => {
  const x = new Array(D).fill(0.5);
  const p1 = perturbContext(x, 0.05, makeRng(7));
  const p2 = perturbContext(x, 0.05, makeRng(7));
  assert.deepEqual(p1, p2);
  const p3 = perturbContext(x, 0.05, makeRng(8));
  assert.notDeepEqual(p1, p3);
  // micro-noise: stays in the neighborhood
  const dist = Math.sqrt(p1.reduce((s, v, i) => s + (v - x[i]) ** 2, 0));
  assert.ok(dist < 1.0, `perturbation too large: ${dist}`);
  assert.throws(() => perturbContext(x, 0, makeRng(1)), /> 0/);
  assert.throws(() => perturbContext(x, 0.05, null), /rng/);
});

test("selectPerturbed: propensities always in (0,1), sum ~1", () => {
  const p = new LinUCB();
  const x = new Array(D).fill(0); x[0] = 1;
  const contexts = { a: x, b: x, c: x };
  for (const seed of [1, 2, 3]) {
    const { armId, propensities, perturbed, mc } = selectPerturbed(p, contexts, { sigma: 0.05, mc: 24, seed });
    assert.ok(["a", "b", "c"].includes(armId));
    assert.equal(perturbed, true);
    let sum = 0;
    for (const pr of Object.values(propensities)) {
      assert.ok(pr > 0 && pr < 1, `propensity ${pr} escaped (0,1)`);
      sum += pr;
    }
    assert.ok(Math.abs(sum - 1) < 0.2, `propensities sum to ${sum}`);
    assert.equal(mc, 24);
  }
});

test("selectPerturbed: learned preference concentrates propensity", () => {
  const p = new LinUCB();
  const x = new Array(D).fill(0); x[0] = 1;
  for (let t = 0; t < 60; t++) p.observe("winner", x, 1.0);
  for (let t = 0; t < 60; t++) p.observe("loser", x, 0.0);
  const { propensities } = selectPerturbed(p, { winner: x, loser: x }, { sigma: 0.05, mc: 64, seed: 11 });
  assert.ok(propensities.winner > 0.9, `winner propensity ${propensities.winner}`);
  assert.ok(propensities.loser < 1, "loser propensity strictly below 1 (schema B1)");
  assert.ok(propensities.loser > 0, "loser propensity strictly above 0 (IPS needs p>0)");
});

test("selectPerturbed explores more when uncertain (cold arms get mass)", () => {
  const p = new LinUCB();
  const x = new Array(D).fill(0); x[0] = 1;
  for (let t = 0; t < 100; t++) p.observe("known", x, 0.6);
  const { propensities } = selectPerturbed(p, { known: x, fresh: x }, { sigma: 0.05, mc: 64, seed: 21 });
  // fresh arm has max uncertainty bonus -> must steal non-trivial propensity
  assert.ok(propensities.fresh > 0.05, `fresh arm propensity ${propensities.fresh} too small`);
});

test("QuotaGuard: quota NEVER exceeds the rate (hard cap, DL-049)", () => {
  for (const rate of [0.05, 0.01, 0.2]) {
    const g = new QuotaGuard({ rate });
    let taken = 0;
    for (let i = 0; i < 2000; i++) if (g.take()) taken++;
    assert.ok(taken / 2000 <= rate + 1e-9, `rate ${rate}: took ${taken}/2000`);
    g.assertWithinQuota(); // must not throw
    assert.ok(Math.abs(g.observedRate() - taken / 2000) < 1e-12);
  }
});

test("QuotaGuard: early decisions are quota (bucket starts full)", () => {
  const g = new QuotaGuard({ rate: 0.05 });
  assert.equal(g.take(), true); // 0 < 0.05*1 -> quota
});

test("QuotaGuard rejects invalid rates", () => {
  assert.throws(() => new QuotaGuard({ rate: 0 }), /\(0,1\)/);
  assert.throws(() => new QuotaGuard({ rate: 1 }), /\(0,1\)/);
  assert.throws(() => new QuotaGuard({ rate: -0.1 }), /\(0,1\)/);
});

test("quotaPick is uniform over arms", () => {
  const rng = makeRng(5);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 1000; i++) counts[quotaPick(["a", "b"], rng)]++;
  assert.ok(Math.abs(counts.a - 500) < 80, `a picked ${counts.a}x`);
  assert.throws(() => quotaPick([], rng), /needs arms/);
});

test("isColdStart: epsilon/quota is the only blind exploration for new arms", () => {
  const p = new LinUCB();
  const arm = p.arm("newbie");
  assert.equal(isColdStart(arm), true);
  arm.update(new Array(D).fill(0.1), 0.5);
  assert.equal(isColdStart(arm), false);
});
