// Token Phase 0 — baseline measurement infrastructure (S5, 1 Oct 2026).
//
// MEASUREMENT ONLY. Nothing in this module enters the reward formula:
// DL-001/DL-002 stay frozen. Cost is computed at REPORT time only (D4: raw
// events never carry computed values — cost_usd never appears in telemetry).
//
// Design verdicts from the GLM trio debate (English, 2026-10-01; raw
// transcripts in transcripts/token-faz0-glm-{savunucu,elestirmen,pragmatist}.txt):
//   Q1 — token source: `usage` events stay MEASURED-ONLY. Tokenizer estimates
//        are computed at report time from char budgets, never logged (D4
//        spirit; append-only log must not bake in one tokenizer version).
//   Q2 — budget violation: NO `token_budget` event field (critic: a
//        self-reported budget is a self-grading vector). Violation is DERIVED
//        from the existing `budget_chars` on the recommendation event with the
//        single pinned 4.0 chars/token ratio below, recorded in every report.
//   Q3 — cost: in-repo reference price table, dated and labeled "reference —
//        verify"; cost_usd = null (honest null, never fabricated) when the
//        model has no known pricing.
//
// Per-task anatomy: one task = one recommendation episode. Token counts come
// from `usage` events joined by episode_id; the char budget from the
// `recommendation` event; raw quality from the `outcome` event (1..5 rating).
//
// Node 18+, no dependencies.

/**
 * Pinned char→token conversion for budget-violation derivation (Q2 verdict).
 * Same 4.0 baseline the serving pipeline uses for EN text (lib/tokenizer.mjs,
 * present.mjs). Pinned on purpose: one frozen definition beats per-episode
 * discretion. Recorded in every report so the ratio is auditable.
 */
export const CHARS_PER_TOKEN_BASELINE = 4.0;

/**
 * Reference price table, USD per 1M tokens. Entries marked "free" come from
 * public pricing comparisons showing NVIDIA NIM's GLM-5.x models as free-tier
 * (checked 2026-10-01; NVIDIA's free tier has rate/throughput limits — the
 * "Free*" asterisk applies). LABEL = "reference — verify" for every entry:
 * prices rot; never quote these externally without checking the provider's
 * billing page. Operators add their own models via `prices` overrides.
 */
export const REFERENCE_PRICES = {
  "z-ai/glm-5.3": {
    usd_per_1m_in: 0,
    usd_per_1m_out: 0,
    provider: "nvidia-nim",
    source: "reference — verify (NVIDIA NIM free tier; checked 2026-10-01)",
  },
  "z-ai/glm-5.3-flash": {
    usd_per_1m_in: 0,
    usd_per_1m_out: 0,
    provider: "nvidia-nim",
    source: "reference — verify (NVIDIA NIM free tier; checked 2026-10-01)",
  },
};

/** Default lookback for "last N days" reports. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Estimate cost (USD) for raw measured token counts. Report-time only (D4).
 * Returns { usd, priced } where usd is null when no pricing is known for the
 * model — an honest null, never a fabricated zero. Caller-supplied `prices`
 * win over REFERENCE_PRICES.
 */
export function estimateCostUSD({ tokens_in = 0, tokens_out = 0, model_id = null }, prices = REFERENCE_PRICES) {
  const entry = (model_id && prices[model_id]) || null;
  if (!entry) return { usd: null, priced: false, model_id };
  const usd = (tokens_in / 1e6) * entry.usd_per_1m_in + (tokens_out / 1e6) * entry.usd_per_1m_out;
  return { usd, priced: true, model_id, price_source: entry.source };
}

/**
 * Group raw telemetry events into per-task (per-episode) token records.
 * - `recommendation` events supply budget_chars (violation derived via
 *   CHARS_PER_TOKEN_BASELINE — Q2 verdict).
 * - `usage` events supply measured tokens_in/tokens_out (measured-only — Q1).
 * - `outcome` events supply raw quality (1..5) and task_success.
 * Episodes without any measured token count are kept with measured=false so
 * the report can show measured coverage as a first-class metric.
 */
export function groupEpisodeTasks(events) {
  const tasks = new Map();
  const task = (episode_id) => {
    let t = tasks.get(episode_id);
    if (!t) {
      t = {
        episode_id,
        ts_first: null,
        tokens_in: 0,
        tokens_out: 0,
        measured: false,
        model_ids: [],
        budget_chars: null,
        quality: null,
        task_success: null,
      };
      tasks.set(episode_id, t);
    }
    return t;
  };
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const ep = e.episode_id;
    if (typeof ep !== "string") continue;
    const t = task(ep);
    if (t.ts_first === null || (typeof e.ts === "string" && e.ts < t.ts_first)) t.ts_first = e.ts ?? t.ts_first;
    if (e.type === "recommendation") {
      if (typeof e.budget_chars === "number") t.budget_chars = e.budget_chars;
    } else if (e.type === "usage") {
      const ti = Number.isInteger(e.tokens_in) ? e.tokens_in : 0;
      const to = Number.isInteger(e.tokens_out) ? e.tokens_out : 0;
      if (ti > 0 || to > 0) t.measured = true;
      t.tokens_in += ti;
      t.tokens_out += to;
      if (typeof e.model_id === "string" && !t.model_ids.includes(e.model_id)) t.model_ids.push(e.model_id);
    } else if (e.type === "outcome") {
      if (Number.isInteger(e.quality)) t.quality = e.quality;
      if (typeof e.task_success === "boolean") t.task_success = e.task_success;
    }
  }
  const out = [];
  for (const t of tasks.values()) {
    const tokens_total = t.tokens_in + t.tokens_out;
    const budget_tokens = t.budget_chars === null ? null : t.budget_chars / CHARS_PER_TOKEN_BASELINE;
    out.push({
      ...t,
      tokens_total,
      budget_tokens,
      budget_violated: budget_tokens === null ? null : tokens_total > budget_tokens,
    });
  }
  out.sort((a, b) => String(a.ts_first ?? "").localeCompare(String(b.ts_first ?? "")));
  return out;
}

/** Filter tasks to the last `windowDays` (relative to `now`, default today). */
export function windowTasks(tasks, windowDays = DEFAULT_WINDOW_DAYS, now = new Date()) {
  const cutoff = new Date(now).getTime() - windowDays * 86400000;
  return tasks.filter((t) => t.ts_first !== null && Date.parse(t.ts_first) >= cutoff);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const medianOf = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);

/**
 * Trend over time-ordered tasks: least-squares slope of tokens_total per day
 * plus first-half vs second-half means. Direction is "flat" unless the slope
 * moves more than 5% of the mean per window-day — deliberate deadband so
 * noise doesn't read as a trend.
 */
export function tokenTrend(tasks) {
  const pts = tasks
    .filter((t) => t.ts_first !== null && Number.isFinite(t.tokens_total))
    .map((t) => ({ x: Date.parse(t.ts_first) / 86400000, y: t.tokens_total }));
  if (pts.length < 2) return { slope_per_day: null, direction: "flat", n: pts.length };
  const n = pts.length;
  const mx = mean(pts.map((p) => p.x));
  const my = mean(pts.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  const half = Math.floor(n / 2);
  const firstMean = mean(pts.slice(0, half).map((p) => p.y));
  const secondMean = mean(pts.slice(half).map((p) => p.y));
  const span = (pts[n - 1].x - pts[0].x) || 1;
  const threshold = 0.05 * (my || 1) * span;
  const drift = slope * span;
  const direction = Math.abs(drift) < threshold ? "flat" : slope > 0 ? "up" : "down";
  return {
    slope_per_day: slope,
    direction,
    n,
    first_half_mean_tokens: firstMean,
    second_half_mean_tokens: secondMean,
  };
}

/**
 * Full Phase 0 baseline report: "last N days — tokens/task, cost, quality,
 * budget violation rate, trend". Cost uses caller `prices` over
 * REFERENCE_PRICES; tasks whose model has no pricing keep cost null and count
 * into cost_coverage (honest nulls, Q3 verdict).
 */
export function summarizeTokenBaseline(tasks, { windowDays = DEFAULT_WINDOW_DAYS, prices = REFERENCE_PRICES, now = new Date() } = {}) {
  const w = windowTasks(tasks, windowDays, now);
  const measured = w.filter((t) => t.measured);
  const tokens = measured.map((t) => t.tokens_total).sort((a, b) => a - b);

  const costs = [];
  let pricedCount = 0;
  for (const t of measured) {
    const model = t.model_ids[0] ?? null;
    const { usd, priced } = estimateCostUSD({ tokens_in: t.tokens_in, tokens_out: t.tokens_out, model_id: model }, prices);
    if (priced) {
      pricedCount += 1;
      costs.push(usd);
    }
  }
  costs.sort((a, b) => a - b);

  const rated = measured.filter((t) => t.quality !== null);
  const budgeted = measured.filter((t) => t.budget_violated !== null);
  const violations = budgeted.filter((t) => t.budget_violated).length;

  const vFirst = budgeted.slice(0, Math.floor(budgeted.length / 2));
  const vSecond = budgeted.slice(Math.floor(budgeted.length / 2));
  const rate = (xs) => (xs.length ? xs.filter((t) => t.budget_violated).length / xs.length : null);

  return {
    window_days: windowDays,
    n_tasks: w.length,
    n_measured: measured.length,
    measured_coverage: w.length ? measured.length / w.length : null,
    tokens_per_task: {
      mean: mean(tokens),
      median: medianOf(tokens),
      p90: quantile(tokens, 0.9),
    },
    cost_usd_per_task: {
      mean: mean(costs),
      median: medianOf(costs),
      p90: quantile(costs, 0.9),
      priced_tasks: pricedCount,
      cost_coverage: measured.length ? pricedCount / measured.length : null,
    },
    quality: {
      mean: mean(rated.map((t) => t.quality)),
      n_rated: rated.length,
    },
    budget_violation: {
      rate: budgeted.length ? violations / budgeted.length : null,
      n_budgeted: budgeted.length,
      n_violations: violations,
      first_half_rate: rate(vFirst),
      second_half_rate: rate(vSecond),
      chars_per_token: CHARS_PER_TOKEN_BASELINE,
    },
    trend: tokenTrend(measured),
  };
}

/** One-paragraph human-readable rendering of a baseline report. */
export function renderBaselineReport(r) {
  const f = (v, d = 1) => (v === null || v === undefined ? "n/a" : Number(v).toFixed(d));
  const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const t = r.tokens_per_task;
  const c = r.cost_usd_per_task;
  const lines = [
    `Token Phase 0 baseline — last ${r.window_days}d: ${r.n_tasks} tasks, ${r.n_measured} with measured token counts (coverage ${pct(r.measured_coverage)}).`,
    `Tokens/task: mean ${f(t.mean, 0)} / median ${f(t.median, 0)} / p90 ${f(t.p90, 0)}.`,
    `Cost/task (estimated USD): mean $${f(c.mean, 4)} / median $${f(c.median, 4)} — priced for ${c.priced_tasks}/${r.n_measured} tasks (coverage ${pct(c.cost_coverage)}; null = no known pricing, never fabricated).`,
    `Quality (raw outcome rating 1..5): mean ${f(r.quality.mean, 2)} over ${r.quality.n_rated} rated tasks.`,
    `Budget violation (tokens > budget_chars/${r.budget_violation.chars_per_token}): ${pct(r.budget_violation.rate)} (${r.budget_violation.n_violations}/${r.budget_violation.n_budgeted}); 1st half ${pct(r.budget_violation.first_half_rate)} → 2nd half ${pct(r.budget_violation.second_half_rate)}.`,
    `Trend: tokens/task ${r.trend.direction} (slope ${f(r.trend.slope_per_day, 1)}/day over ${r.trend.n} tasks).`,
    `MEASUREMENT ONLY — no token term enters the reward formula (DL-001/DL-002 frozen).`,
  ];
  return lines.join("\n");
}

/** Convenience: events → grouped tasks → baseline report, in one call. */
export function reportTokenBaseline(events, opts = {}) {
  return summarizeTokenBaseline(groupEpisodeTasks(events), opts);
}
