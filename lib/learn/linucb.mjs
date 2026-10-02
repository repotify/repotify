// LinUCB (disjoint, per-arm) — pure-JS, zero dependencies, Node 18+.
//
// FAZ 6 learning core. Locked parameters:
//   - d = 64 fixed feature dimension (DL-014)
//   - No epsilon-greedy: exploration is feature perturbation (B1, DL-007) +
//     a small blind-quota control arm (DL-049). This module is the pure
//     estimator; exploration policy lives in explore.mjs.
//   - Warm-start: new arms may be seeded from historical logs via
//     warmstart.mjs (B2, DL-019) instead of A=lambda*I, b=0.
//
// Algorithm (Li, Chu, Langford & Schapire 2010, disjoint variant):
//   per arm a: A_a in R^{d x d} (starts lambda*I), b_a in R^d (starts 0)
//   theta_hat_a = A_a^{-1} b_a
//   p_{t,a} = theta_hat_a . x_{t,a} + alpha * sqrt(x_{t,a}^T A_a^{-1} x_{t,a})
//   pick argmax p; on reward r: A_a += x x^T, b_a += r x
//
// All product-facing text in this repo is English (repo AGENTS.md).

export const FEATURE_DIM = 64; // DL-014: fixed d=64
export const DEFAULT_ALPHA = 1.0; // Li 2010 practical default
export const DEFAULT_LAMBDA = 1.0; // ridge regularizer

function assertVector(x, d, name = "x") {
  if (!Array.isArray(x) || x.length !== d) {
    throw new Error(`LinUCB: ${name} must be an Array of length ${d}`);
  }
  for (let i = 0; i < x.length; i++) {
    if (typeof x[i] !== "number" || !Number.isFinite(x[i])) {
      throw new Error(`LinUCB: ${name}[${i}] must be a finite number`);
    }
  }
}

// ---- tiny dense linear algebra (d=64; plain arrays, no deps) ----

export function dot(u, v) {
  let s = 0;
  for (let i = 0; i < u.length; i++) s += u[i] * v[i];
  return s;
}

/** A += x x^T in place. A is a d*d row-major Float64Array. */
export function addOuter(A, d, x) {
  for (let i = 0; i < d; i++) {
    const xi = x[i];
    const row = i * d;
    for (let j = 0; j < d; j++) A[row + j] += xi * x[j];
  }
}

/** y = M v, M row-major d*d. */
export function matVec(M, d, v) {
  const y = new Array(d).fill(0);
  for (let i = 0; i < d; i++) {
    let s = 0;
    const row = i * d;
    for (let j = 0; j < d; j++) s += M[row + j] * v[j];
    y[i] = s;
  }
  return y;
}

/**
 * Invert a symmetric positive-definite d*d matrix via Gauss-Jordan with
 * partial pivoting. Returns a fresh row-major Float64Array.
 * A isSPD by construction (lambda*I + sum of outer products).
 */
export function invertSPD(A, d) {
  const aug = new Float64Array(d * 2 * d);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) aug[i * 2 * d + j] = A[i * d + j];
    aug[i * 2 * d + d + i] = 1;
  }
  const W = 2 * d;
  for (let col = 0; col < d; col++) {
    // partial pivot
    let piv = col;
    let pivAbs = Math.abs(aug[col * W + col]);
    for (let r = col + 1; r < d; r++) {
      const a = Math.abs(aug[r * W + col]);
      if (a > pivAbs) { pivAbs = a; piv = r; }
    }
    if (!(pivAbs > 0)) throw new Error("LinUCB: singular design matrix");
    if (piv !== col) {
      for (let k = 0; k < W; k++) {
        const t = aug[col * W + k];
        aug[col * W + k] = aug[piv * W + k];
        aug[piv * W + k] = t;
      }
    }
    const inv = 1 / aug[col * W + col];
    for (let k = 0; k < W; k++) aug[col * W + k] *= inv;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = aug[r * W + col];
      if (f === 0) continue;
      for (let k = 0; k < W; k++) aug[r * W + k] -= f * aug[col * W + k];
    }
  }
  const inv = new Float64Array(d * d);
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) inv[i * d + j] = aug[i * W + d + j];
  return inv;
}

// ---- per-arm state ----

export class LinUCBArm {
  constructor({ d = FEATURE_DIM, lambda = DEFAULT_LAMBDA } = {}) {
    this.d = d;
    this.lambda = lambda;
    this.A = new Float64Array(d * d); // design matrix
    for (let i = 0; i < d; i++) this.A[i * d + i] = lambda;
    this.b = new Float64Array(d); // reward-weighted context sum
    this.pulls = 0;
    this._Ainv = null; // lazily computed, invalidated on update
  }

  get Ainv() {
    if (!this._Ainv) this._Ainv = invertSPD(this.A, this.d);
    return this._Ainv;
  }

  theta() {
    const Ainv = this.Ainv;
    const th = new Array(this.d);
    for (let i = 0; i < this.d; i++) {
      let s = 0;
      const row = i * this.d;
      for (let j = 0; j < this.d; j++) s += Ainv[row + j] * this.b[j];
      th[i] = s;
    }
    return th;
  }

  /** { mean, bonus, ucb } for context x (length d). */
  score(x, alpha = DEFAULT_ALPHA) {
    assertVector(x, this.d);
    const th = this.theta();
    const mean = dot(th, x);
    const AinvX = matVec(this.Ainv, this.d, x);
    const variance = Math.max(0, dot(x, AinvX)); // guard float noise
    const bonus = alpha * Math.sqrt(variance);
    return { mean, bonus, ucb: mean + bonus };
  }

  update(x, reward) {
    assertVector(x, this.d);
    if (typeof reward !== "number" || !Number.isFinite(reward)) {
      throw new Error("LinUCB: reward must be a finite number");
    }
    addOuter(this.A, this.d, x);
    for (let i = 0; i < this.d; i++) this.b[i] += reward * x[i];
    this.pulls += 1;
    this._Ainv = null; // invalidate cache
  }

  /**
   * Exponential forgetting for non-stationary worlds (pragmatist's fix):
   *   A <- gamma*A + (1-gamma)*lambda*I ;  b <- gamma*b
   * gamma=1 is the identity (default behavior: never forget). gamma=0 resets
   * to the prior. The (1-gamma)*lambda*I term keeps the regularization floor
   * so A stays well-conditioned and the UCB bonus stays bounded. Call
   * periodically (e.g. monthly) with gamma in [0.9, 0.99) when user taste or
   * the catalog drifts; `pulls` is untouched (it counts live decisions, not
   * effective sample size).
   */
  decay(gamma) {
    if (typeof gamma !== "number" || !(gamma >= 0 && gamma <= 1)) {
      throw new Error("LinUCB: decay gamma must be in [0, 1]");
    }
    if (gamma === 1) return this;
    const keep = 1 - gamma;
    for (let i = 0; i < this.d; i++) {
      for (let j = 0; j < this.d; j++) {
        const idx = i * this.d + j;
        this.A[idx] = gamma * this.A[idx] + (i === j ? keep * this.lambda : 0);
      }
      this.b[i] = gamma * this.b[i];
    }
    this._Ainv = null;
    return this;
  }

  toJSON() {
    return {
      d: this.d, lambda: this.lambda, pulls: this.pulls,
      A: Array.from(this.A), b: Array.from(this.b),
    };
  }

  static fromJSON(o) {
    const arm = new LinUCBArm({ d: o.d, lambda: o.lambda });
    arm.A.set(o.A);
    arm.b.set(o.b);
    arm.pulls = o.pulls;
    return arm;
  }
}

// ---- policy over a dynamic arm set ----

export class LinUCB {
  constructor({ d = FEATURE_DIM, alpha = DEFAULT_ALPHA, lambda = DEFAULT_LAMBDA } = {}) {
    this.d = d;
    this.alpha = alpha;
    this.lambda = lambda;
    this.arms = new Map(); // armId -> LinUCBArm
  }

  arm(armId) {
    let a = this.arms.get(armId);
    if (!a) { a = new LinUCBArm({ d: this.d, lambda: this.lambda }); this.arms.set(armId, a); }
    return a;
  }

  hasArm(armId) { return this.arms.has(armId); }

  /** UCB scores for every candidate arm. contexts: Map/object armId -> x. */
  scores(contexts, { alpha = this.alpha } = {}) {
    const out = [];
    for (const [armId, x] of Object.entries(contexts)) {
      const { mean, bonus, ucb } = this.arm(armId).score(x, alpha);
      out.push({ armId, mean, bonus, ucb });
    }
    // Descending UCB, armId tiebreak for determinism.
    out.sort((p, q) => q.ucb - p.ucb || (p.armId < q.armId ? -1 : 1));
    return out;
  }

  /** Argmax UCB arm. Returns { armId, scores }. */
  select(contexts, opts = {}) {
    const s = this.scores(contexts, opts);
    if (!s.length) throw new Error("LinUCB: no candidate arms");
    return { armId: s[0].armId, scores: s };
  }

  /** One-shot gradient update for the chosen arm (DL-005: exactly one per decision). */
  observe(armId, x, reward) {
    this.arm(armId).update(x, reward);
  }

  toJSON() {
    const arms = {};
    for (const [id, a] of this.arms) arms[id] = a.toJSON();
    return { d: this.d, alpha: this.alpha, lambda: this.lambda, arms };
  }

  static fromJSON(o) {
    const p = new LinUCB({ d: o.d, alpha: o.alpha, lambda: o.lambda });
    for (const [id, a] of Object.entries(o.arms)) p.arms.set(id, LinUCBArm.fromJSON(a));
    return p;
  }
}
