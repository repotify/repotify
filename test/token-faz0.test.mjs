// Token Phase 0 baseline measurement tests (S5, 1 Oct 2026).
// Covers: schema opt-in field (usage.model_id), metric aggregation,
// budget-violation derivation, cost estimation (honest nulls), trend,
// and the full report pipeline. Measurement only — no reward formula touched.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { validateEvent } from "../lib/telemetry/schema.mjs";
import {
  CHARS_PER_TOKEN_BASELINE,
  REFERENCE_PRICES,
  estimateCostUSD,
  groupEpisodeTasks,
  windowTasks,
  tokenTrend,
  summarizeTokenBaseline,
  renderBaselineReport,
  reportTokenBaseline,
} from "../lib/telemetry/token-faz0.mjs";

const INSTALL = randomUUID();

const mkUsage = (over = {}) => ({
  type: "usage",
  ts: new Date().toISOString(),
  install_id: INSTALL,
  episode_id: randomUUID(),
  tokens_in: 1000,
  tokens_out: 500,
  model_id: "z-ai/glm-5.3",
  ...over,
});

// --- schema: model_id opt-in on usage ---------------------------------------

test("usage event with model_id validates", () => {
  const errors = validateEvent(mkUsage());
  assert.deepEqual(errors, []);
});

test("usage event without model_id still validates (opt-in)", () => {
  const e = mkUsage();
  delete e.model_id;
  assert.deepEqual(validateEvent(e), []);
});

test("usage event rejects bad model_id", () => {
  assert.ok(validateEvent(mkUsage({ model_id: "" })).length > 0);
  assert.ok(validateEvent(mkUsage({ model_id: "x".repeat(200) })).length > 0);
  assert.ok(validateEvent(mkUsage({ model_id: 42 })).length > 0);
});

// GLM trio Q2 verdict lock: recommendation events have NO token_budget field.
test("recommendation rejects token_budget (derived from budget_chars instead)", () => {
  const e = {
    type: "recommendation",
    ts: new Date().toISOString(),
    install_id: INSTALL,
    episode_id: randomUUID(),
    candidates: [{ skill_id: "tdd-discipline", position: 0, propensity: 0.5, shown: true }],
    token_budget: 1000,
  };
  const errors = validateEvent(e);
  assert.ok(errors.some((x) => x.includes("token_budget")), `expected token_budget rejection, got: ${errors}`);
});

// --- metric aggregation ------------------------------------------------------

const mkEpisode = (i, { tokens = 1500, budgetChars = 8000, quality = 4, dayOffset = 0, model = "z-ai/glm-5.3" } = {}) => {
  const ep = randomUUID();
  const ts = new Date(Date.now() - dayOffset * 86400000).toISOString();
  return [
    {
      type: "recommendation", ts, install_id: INSTALL, episode_id: ep,
      budget_chars: budgetChars,
      candidates: [{ skill_id: `skill-${i}`, position: 0, propensity: 0.9, shown: true }],
    },
    { type: "usage", ts, install_id: INSTALL, episode_id: ep, tokens_in: tokens * 0.6, tokens_out: tokens * 0.4, model_id: model },
    { type: "outcome", ts, install_id: INSTALL, episode_id: ep, task_success: true, quality },
  ];
};

test("groupEpisodeTasks aggregates usage + budget + quality per episode", () => {
  const events = [...mkEpisode(1, { tokens: 1500, budgetChars: 8000, quality: 4 })];
  const [t] = groupEpisodeTasks(events);
  assert.equal(t.tokens_total, 1500);
  assert.equal(t.measured, true);
  assert.equal(t.quality, 4);
  assert.equal(t.budget_tokens, 8000 / CHARS_PER_TOKEN_BASELINE);
  assert.equal(t.budget_violated, false); // 1500 < 2000
});

test("budget violation derived from budget_chars with pinned ratio", () => {
  const events = [...mkEpisode(2, { tokens: 5000, budgetChars: 8000 })]; // 5000 > 2000
  const [t] = groupEpisodeTasks(events);
  assert.equal(t.budget_violated, true);
});

test("episode without usage keeps measured=false for coverage metric", () => {
  const [rec, , outc] = mkEpisode(3);
  const [t] = groupEpisodeTasks([rec, outc]);
  assert.equal(t.measured, false);
  assert.equal(t.tokens_total, 0);
});

test("multiple usage events in one episode sum up", () => {
  const ep = randomUUID();
  const events = [
    { type: "usage", ts: new Date().toISOString(), install_id: INSTALL, episode_id: ep, tokens_in: 100, tokens_out: 50, model_id: "z-ai/glm-5.3" },
    { type: "usage", ts: new Date().toISOString(), install_id: INSTALL, episode_id: ep, tokens_in: 200, tokens_out: 100, model_id: "z-ai/glm-5.3" },
  ];
  const [t] = groupEpisodeTasks(events);
  assert.equal(t.tokens_in, 300);
  assert.equal(t.tokens_total, 450);
});

// --- cost estimation ----------------------------------------------------------

test("estimateCostUSD uses reference table at report time", () => {
  const { usd, priced } = estimateCostUSD({ tokens_in: 1e6, tokens_out: 1e6, model_id: "z-ai/glm-5.3" });
  assert.equal(priced, true);
  assert.equal(usd, 0); // NVIDIA NIM free tier per reference table
  assert.ok(REFERENCE_PRICES["z-ai/glm-5.3"].source.includes("reference — verify"));
});

test("estimateCostUSD with caller prices", () => {
  const { usd, priced } = estimateCostUSD(
    { tokens_in: 1e6, tokens_out: 0.5e6, model_id: "m/custom" },
    { "m/custom": { usd_per_1m_in: 2, usd_per_1m_out: 8, provider: "x", source: "test" } },
  );
  assert.equal(priced, true);
  assert.equal(usd, 2 + 4);
});

test("estimateCostUSD honest null for unknown model (never fabricated)", () => {
  const { usd, priced } = estimateCostUSD({ tokens_in: 999, tokens_out: 999, model_id: "unknown-model-xyz" });
  assert.equal(priced, false);
  assert.equal(usd, null);
});

// --- trend ---------------------------------------------------------------------

test("tokenTrend detects rising trend", () => {
  const events = [];
  for (let i = 0; i < 8; i++) events.push(...mkEpisode(i, { tokens: 1000 + i * 500, dayOffset: 7 - i, quality: 4 }));
  const tasks = groupEpisodeTasks(events);
  const tr = tokenTrend(tasks.filter((t) => t.measured));
  assert.equal(tr.direction, "up");
  assert.ok(tr.slope_per_day > 0);
});

test("tokenTrend flat on noise", () => {
  const events = [];
  for (let i = 0; i < 6; i++) events.push(...mkEpisode(i, { tokens: 1000 + (i % 2) * 10, dayOffset: 5 - i }));
  const tr = tokenTrend(groupEpisodeTasks(events));
  assert.equal(tr.direction, "flat");
});

test("tokenTrend needs at least 2 points", () => {
  const tr = tokenTrend([]);
  assert.equal(tr.direction, "flat");
  assert.equal(tr.slope_per_day, null);
});

// --- full report -----------------------------------------------------------------

test("summarizeTokenBaseline: tokens/task, cost, quality, violation rate, trend", () => {
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push(...mkEpisode(i, {
      tokens: 1000 + i * 100,
      budgetChars: i < 5 ? 8000 : 1000, // second half violates: (1000+i*100) > 250
      quality: 4,
      dayOffset: 9 - i,
    }));
  }
  const r = reportTokenBaseline(events, { windowDays: 30 });
  assert.equal(r.n_tasks, 10);
  assert.equal(r.n_measured, 10);
  assert.equal(r.measured_coverage, 1);
  assert.equal(r.tokens_per_task.mean, 1450);
  assert.equal(r.quality.mean, 4);
  assert.equal(r.budget_violation.rate, 0.5);
  assert.equal(r.budget_violation.chars_per_token, CHARS_PER_TOKEN_BASELINE);
  // glm-5.3 is free-tier → priced but zero cost, full coverage
  assert.equal(r.cost_usd_per_task.cost_coverage, 1);
  assert.equal(r.cost_usd_per_task.mean, 0);
  assert.ok(["up", "flat", "down"].includes(r.trend.direction));
});

test("windowTasks filters to last N days", () => {
  const old = mkEpisode(1, { dayOffset: 60 });
  const fresh = mkEpisode(2, { dayOffset: 1 });
  const tasks = groupEpisodeTasks([...old, ...fresh]);
  const w = windowTasks(tasks, 30, new Date());
  assert.equal(w.length, 1);
});

test("renderBaselineReport produces the required summary lines", () => {
  const events = [...mkEpisode(1, { tokens: 1500, budgetChars: 8000, dayOffset: 1 })];
  const text = renderBaselineReport(reportTokenBaseline(events, { windowDays: 30 }));
  assert.ok(text.includes("token/görev") || text.includes("Tokens/task"));
  assert.ok(text.includes("Budget violation"));
  assert.ok(text.includes("MEASUREMENT ONLY"));
});
