// Unit tests: lib/learn/linucb.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_DIM, DEFAULT_ALPHA, LinUCB, LinUCBArm,
  dot, addOuter, matVec, invertSPD,
} from "../lib/learn/linucb.mjs";

const D = FEATURE_DIM;

test("FEATURE_DIM is 64 (DL-014)", () => {
  assert.equal(D, 64);
});

test("dot / addOuter / matVec basics", () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
  const A = new Float64Array(9);
  addOuter(A, 3, [1, 2, 3]);
  assert.deepEqual(Array.from(A), [1, 2, 3, 2, 4, 6, 3, 6, 9]);
  assert.deepEqual(matVec(new Float64Array([1, 0, 0, 1]), 2, [5, 7]), [5, 7]);
});

test("invertSPD inverts a known matrix", () => {
  // diag(2,4,8): inverse is diag(1/2,1/4,1/8)
  const A = new Float64Array([2, 0, 0, 0, 4, 0, 0, 0, 8]);
  const I = invertSPD(A, 3);
  const got = [I[0], I[4], I[8]];
  assert.ok(Math.abs(got[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(got[1] - 0.25) < 1e-12);
  assert.ok(Math.abs(got[2] - 0.125) < 1e-12);
  assert.ok(Math.abs(I[1]) < 1e-12 && Math.abs(I[3]) < 1e-12);
});

test("invertSPD: A * Ainv == I for a random SPD matrix", () => {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const d = 8;
  const M = new Float64Array(d * d);
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) M[i * d + j] = rnd();
  const A = new Float64Array(d * d); // A = M M^T + I
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) {
    let acc = 0;
    for (let k = 0; k < d; k++) acc += M[i * d + k] * M[j * d + k];
    A[i * d + j] = acc + (i === j ? 1 : 0);
  }
  const Ainv = invertSPD(A, d);
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) {
    let acc = 0;
    for (let k = 0; k < d; k++) acc += A[i * d + k] * Ainv[k * d + j];
    assert.ok(Math.abs(acc - (i === j ? 1 : 0)) < 1e-9, `identity check failed at ${i},${j}`);
  }
});

test("cold arm: mean=0, bonus=alpha (max uncertainty), ucb=alpha", () => {
  const arm = new LinUCBArm();
  const x = new Array(D).fill(0); x[0] = 1; // unit norm
  const { mean, bonus, ucb } = arm.score(x, 1.0);
  assert.equal(mean, 0);
  assert.ok(Math.abs(bonus - 1.0) < 1e-9); // x^T I^{-1} x = 1
  assert.ok(Math.abs(ucb - 1.0) < 1e-9);
});

test("theta recovers a linear reward function", () => {
  const arm = new LinUCBArm();
  const trueTheta = new Array(D).fill(0);
  trueTheta[3] = 2.0; trueTheta[10] = -1.5;
  let s = 999;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 400; t++) {
    const x = Array.from({ length: D }, () => rnd() * 2 - 1);
    const r = dot(trueTheta, x) + (rnd() - 0.5) * 0.1;
    arm.update(x, r);
  }
  const th = arm.theta();
  assert.ok(Math.abs(th[3] - 2.0) < 0.15, `theta[3]=${th[3]}`);
  assert.ok(Math.abs(th[10] + 1.5) < 0.15, `theta[10]=${th[10]}`);
  for (let i = 0; i < D; i++) {
    if (i === 3 || i === 10) continue;
    assert.ok(Math.abs(th[i]) < 0.15, `theta[${i}]=${th[i]} should be ~0`);
  }
});

test("exploration bonus shrinks with pulls in observed directions", () => {
  const arm = new LinUCBArm();
  const x = new Array(D).fill(0); x[5] = 1;
  const before = arm.score(x).bonus;
  for (let t = 0; t < 20; t++) arm.update(x, 0.5);
  const after = arm.score(x).bonus;
  assert.ok(after < before, `bonus should shrink: ${before} -> ${after}`);
  // ...but stays large in unexplored directions
  const y = new Array(D).fill(0); y[40] = 1;
  assert.ok(arm.score(y).bonus > after * 2);
});

test("LinUCB.select picks argmax UCB; deterministic tiebreak", () => {
  const p = new LinUCB();
  const mk = (v) => { const x = new Array(D).fill(0); x[0] = v; return x; };
  // arm b gets positive rewards, arm a gets nothing
  for (let t = 0; t < 30; t++) p.observe("b", mk(1), 1.0);
  const { armId, scores } = p.select({ a: mk(1), b: mk(1) });
  assert.equal(armId, "b");
  assert.equal(scores[0].armId, "b");
  assert.ok(scores[0].ucb >= scores[1].ucb);
});

test("per-arm models are independent", () => {
  const p = new LinUCB();
  const x = new Array(D).fill(1 / 8); // norm 1
  for (let t = 0; t < 20; t++) p.observe("good", x, 1.0);
  for (let t = 0; t < 20; t++) p.observe("bad", x, 0.0);
  const s = p.scores({ good: x, bad: x });
  assert.equal(s[0].armId, "good");
  assert.ok(s[0].mean > 0.9 && s[1].mean < 0.1);
});

test("serialization roundtrip preserves behavior", () => {
  const p = new LinUCB({ alpha: 1.5 });
  const x = new Array(D).fill(0); x[1] = 1;
  p.observe("a", x, 0.7); p.observe("a", x, 0.3);
  const q = LinUCB.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const s1 = p.scores({ a: x })[0];
  const s2 = q.scores({ a: x })[0];
  assert.ok(Math.abs(s1.ucb - s2.ucb) < 1e-12);
  assert.equal(q.alpha, 1.5);
  assert.ok(q.hasArm("a") && !q.hasArm("zzz"));
});

test("input validation throws loudly", () => {
  const p = new LinUCB();
  assert.throws(() => p.observe("a", [1, 2, 3], 0.5), /length/);
  assert.throws(() => p.observe("a", new Array(D).fill(0), NaN), /finite/);
  assert.throws(() => p.select({}), /no candidate/);
  const arm = new LinUCBArm();
  assert.throws(() => arm.score(new Array(D).fill(NaN)), /finite/);
});

test("DEFAULT_ALPHA is 1.0 (Li 2010 practical default)", () => {
  assert.equal(DEFAULT_ALPHA, 1.0);
});

test("decay: gamma=1 identity, gamma=0 resets to prior, rejects out-of-range", () => {
  const arm = new LinUCBArm();
  const x = new Array(D).fill(0); x[3] = 1;
  arm.update(x, 1.0);
  arm.update(x, 0.5);
  const bBefore = Array.from(arm.b);
  const pullsBefore = arm.pulls;
  arm.decay(1);
  assert.deepEqual(Array.from(arm.b), bBefore); // identity
  arm.decay(0.5);
  for (let i = 0; i < arm.d; i++) {
    assert.ok(Math.abs(arm.b[i] - 0.5 * bBefore[i]) < 1e-12);
    // diagonal keeps the lambda floor: A_ii = 0.5*(lambda + sumsq) + 0.5*lambda
    assert.ok(arm.A[i * arm.d + i] >= 0.5 * arm.lambda);
  }
  assert.equal(arm.pulls, pullsBefore); // pulls counts decisions, not sample mass
  arm.decay(0);
  assert.ok(arm.b.every((v) => v === 0));
  for (let i = 0; i < arm.d; i++) {
    assert.equal(arm.A[i * arm.d + i], arm.lambda);
  }
  // scoring still works after full reset (well-conditioned)
  const s = arm.score(x);
  assert.ok(Number.isFinite(s.ucb));
  assert.throws(() => arm.decay(-0.1), /\[0, 1\]/);
  assert.throws(() => arm.decay(1.1), /\[0, 1\]/);
});
