// Unit tests: lib/learn/warmstart.mjs (B2) + lib/learn/calibrate.mjs (B3)
import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulateFromLabels, warmStartArm, warmStartMany } from "../lib/learn/warmstart.mjs";
import { calibrateProxies, proxyScore, pearson, PROXIES, CALIBRATION_SOURCE } from "../lib/learn/calibrate.mjs";
import { LinUCB, FEATURE_DIM } from "../lib/learn/linucb.mjs";

const D = FEATURE_DIM;
const e = (i) => { const x = new Array(D).fill(0); x[i % D] = 1; return x; };

function row(skill_id, signals, x) {
  return { label_id: `l-${skill_id}`, episode_id: "e", skill_id, window: "month1", signals, _x: x };
}
function sig(over = {}) {
  return {
    invoked_sessions: 1, outcome_success: true, outcome_skill_free_baseline: false,
    kept_30d: true, removed_fast: false, replaced_by: null, ...over,
  };
}

// ---------- warmstart ----------

test("accumulateFromLabels: A = sum xx^T + lambda I, b = sum r x", () => {
  const x1 = e(0), x2 = e(1);
  const rows = [
    row("s1", sig(), x1),
    row("s1", sig(), x2),
    row("s2", sig(), x1),
  ];
  const acc = accumulateFromLabels(rows, (r) => r._x, {
    lambda: 1.0,
    rewardOf: () => 2.0, // fixed reward keeps the math checkable
  });
  const a = acc.get("s1");
  assert.equal(a.n, 2);
  // A[0,0] = 1 (x1 x1^T) + 1 (lambda) = 2 ; A[1,1] = 2 ; A[0,1] = 0
  assert.equal(a.A[0], 2);
  assert.equal(a.A[D + 1], 2);
  assert.equal(a.A[1], 0);
  // b = 2*x1 + 2*x2
  assert.equal(a.b[0], 2);
  assert.equal(a.b[1], 2);
  assert.equal(a.b[2], 0);
  assert.equal(acc.get("s2").n, 1);
});

test("accumulateFromLabels requires a contextProvider (no invented features)", () => {
  assert.throws(() => accumulateFromLabels([], null), /contextProvider/);
  assert.throws(
    () => accumulateFromLabels([row("s", sig(), [1, 2])], (r) => r._x),
    new RegExp(`length ${D}`),
  );
});

test("warmStartArm seeds a fresh arm; theta matches the historical fit", () => {
  const x = e(3);
  const rows = [row("s1", sig(), x), row("s1", sig(), x)];
  const acc = accumulateFromLabels(rows, (r) => r._x, { rewardOf: () => 1.0 });
  const p = new LinUCB();
  const n = warmStartArm(p, "s1", acc);
  assert.equal(n, 2);
  const th = p.arm("s1").theta();
  // ridge fit of r=1 on x=e3 twice: theta[3] = 2/(2+1) = 2/3
  assert.ok(Math.abs(th[3] - 2 / 3) < 1e-9, `theta[3]=${th[3]}`);
  // uncertainty shrank along the observed direction
  const bonus = p.arm("s1").score(x).bonus;
  assert.ok(bonus < 1.0, `bonus ${bonus} should be < 1 after warm-start`);
});

test("warmStartArm refuses arms with live pulls; unknown skills stay cold", () => {
  const rows = [row("s1", sig(), e(0))];
  const acc = accumulateFromLabels(rows, (r) => r._x);
  const p = new LinUCB();
  p.observe("s1", e(0), 0.5);
  assert.throws(() => warmStartArm(p, "s1", acc), /live pulls/);
  assert.equal(warmStartArm(p, "never-seen", acc), 0);
});

test("warmStartMany partitions warmed vs cold", () => {
  const rows = [row("s1", sig(), e(0))];
  const acc = accumulateFromLabels(rows, (r) => r._x);
  const p = new LinUCB();
  const { warmed, cold } = warmStartMany(p, ["s1", "s2"], acc);
  assert.deepEqual(warmed, ["s1"]);
  assert.deepEqual(cold, ["s2"]);
});

// ---------- calibrate ----------

test("CALIBRATION_SOURCE is 'simulated' until real data exists (DL-020)", () => {
  assert.equal(CALIBRATION_SOURCE, "simulated");
});

test("pearson correctness", () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null); // degenerate
  assert.equal(pearson([1], [1]), null);
});

test("calibrateProxies: good proxy kept, noise proxy dropped, source tagged", () => {
  // 60 matured labels: invoked tracks kept_30d perfectly; outcome_delta is noise.
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const good = i % 2 === 0;
    rows.push(row(`s${i % 3}`, sig({
      invoked_sessions: good ? 2 : 0,
      kept_30d: good,
      outcome_success: i % 3 === 0, // noise
      outcome_skill_free_baseline: null,
    }), e(i)));
  }
  const cal = calibrateProxies(rows, { minN: 30 });
  assert.equal(cal.source, "simulated");
  assert.equal(cal.n, 60);
  assert.equal(cal.target, "kept_30d@month1");
  assert.deepEqual(cal.proxies.map((p) => p.proxy).sort(), [...PROXIES].sort());
  const inv = cal.proxies.find((p) => p.proxy === "invoked_unique");
  assert.equal(inv.verdict, "keep");
  assert.ok(inv.corrToTarget > 0.5, `corr ${inv.corrToTarget}`);
  const od = cal.proxies.find((p) => p.proxy === "outcome_delta");
  assert.ok(["drop", "downweight", "insufficient_data"].includes(od.verdict),
    `noise proxy verdict: ${od.verdict}`);
});

test("calibrateProxies: sign-flipped proxy is dropped (the proxy lies)", () => {
  // A world where fast removal coincides with HIGH 30-day labels
  // (corr(removed_fast, target) > 0 while the expected sign is negative):
  // the proxy's assumed direction is wrong, so it must be dropped.
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const good = i % 2 === 0;
    rows.push(row("s", sig({
      invoked_sessions: good ? 2 : 0,
      outcome_success: good ? true : null,
      kept_30d: good,
      removed_fast: good, // lies: removals happen exactly on the good rows
      removal_reason: good ? "unused" : null,
    }), e(i)));
  }
  const cal = calibrateProxies(rows, { minN: 30 });
  const rf = cal.proxies.find((p) => p.proxy === "removed_fast");
  assert.ok(rf.corrToTarget > 0.5, `expected positive corr, got ${rf.corrToTarget}`);
  assert.equal(rf.verdict, "drop");
  assert.equal(rf.weightMultiplier, 0);
});

test("calibrateProxies: insufficient data is reported, not hidden", () => {
  const cal = calibrateProxies([row("s", sig(), e(0))], { minN: 30 });
  assert.ok(cal.proxies.every((p) => p.verdict === "insufficient_data"));
});

test("proxyScore applies calibrated multipliers without touching locked weights", () => {
  const s = sig(); // invoked=1, delta=1, installed=1
  const cal = {
    source: "simulated",
    proxies: [
      { proxy: "invoked_unique", weightMultiplier: 0.5 },
      { proxy: "outcome_delta", weightMultiplier: 1 },
      { proxy: "removed_fast", weightMultiplier: 1 },
      { proxy: "installed", weightMultiplier: 1 },
    ],
  };
  // 0.35*1*0.5 + 0.30*1*1 + 0.10*1*1 = 0.575
  const sc = proxyScore(s, cal);
  assert.ok(Math.abs(sc - 0.575) < 1e-12, `got ${sc}`);
  // dropped proxy contributes nothing
  const cal2 = { proxies: [{ proxy: "invoked_unique", weightMultiplier: 0 }] };
  assert.ok(Math.abs(proxyScore(s, cal2) - (0.30 + 0.10)) < 1e-12);
});
