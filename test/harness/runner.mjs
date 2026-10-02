#!/usr/bin/env node
// Eval harness runner: one scenario x one arm x N reps, agent runs, JSONL results.
// Two-phase protocol (the causal chain is explicit):
//   Phase 1 ROUTING — agent sees skill cards, declares SKILLS: ids  -> routing metric.
//   Phase 2 TASK    — agent sees the full content of the skills it chose, solves
//                     the task                                       -> task metric.
// Usage:
//   node test/harness/runner.mjs --scenario js-frontend --arms repotify,none,naive \
//     --runs 2 --driver nvidia --model z-ai/glm-5.3 --out test/harness/runs/series1.jsonl
//   node test/harness/runner.mjs --scenario all --arms repotify,none,naive,jev --runs 2 --out runs/series1.jsonl
// Flags: --dry-run (no model calls, skill sets only), --max-tokens, --temperature,
//        --max-retries, --concurrency, --content-cache <dir>, --list-scenarios
import { isMain } from "../../src/util.mjs";
import { readFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeDriver } from "./drivers.mjs";
import { ARMS, loadCatalog, resolveArmSet, skillCard } from "./arms.mjs";
import { fetchSkillContent } from "./content.mjs";
import { parseChosenSkills, extractDeliverable, scoreRubric, scoreRouting, estTokens } from "./rubric.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const SCEN_DIR = join(here, "scenarios");
const CATALOG_DIR = join(here, "..", "..", "catalog");
import { tmpdir } from "node:os";
// Default content cache lives OUTSIDE the repo tree: cached SKILL.md copies contain
// relative links (references/*.md) that would trip the repo's docs-links test.
const DEFAULT_CACHE = join(tmpdir(), "repotify-harness-cache");

export function loadScenario(id) {
  return JSON.parse(readFileSync(join(SCEN_DIR, `${id}.json`), "utf8"));
}
export function listScenarios() {
  return readdirSync(SCEN_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

const SYSTEM_ROUTE = `You are a coding agent. The skill cards below (id: description) are the only skills available to you.
Decide which skills you will use for the task. Your reply MUST be exactly one line:
SKILLS: <comma-separated skill ids from the list, or NONE if no skill helps>
No other text.`;

const SYSTEM_TASK = `You are a coding agent. You have the following skill content available; use what helps.
Your reply MUST start with exactly one line:
DELIVERABLE:
followed by your solution to the task. Keep the deliverable short. No other text before the DELIVERABLE: line.`;

export function buildRoutePrompt(scenario, armSet) {
  const cards = armSet.ids.length
    ? armSet.ids.map((id) => `- ${skillCard(globalThis.__catalog, id)}`).join("\n")
    : "(none — you have no skills; reply SKILLS: NONE)";
  return [
    `PROJECT: ${scenario.project}`,
    `TASK: ${scenario.task}`,
    ``,
    `AVAILABLE SKILLS (${armSet.ids.length}):`,
    cards,
    ``,
    `Which skills will you use? Reply with the SKILLS: line only.`,
  ].join("\n");
}

export function buildTaskPrompt(scenario, contents) {
  const body = contents.length
    ? contents.map((c) => `--- SKILL ${c.id} (source: ${c.source}) ---\n${c.text}`).join("\n\n")
    : "(no skill content — solve from your own knowledge)";
  return [
    `PROJECT: ${scenario.project}`,
    `TASK: ${scenario.task}`,
    ``,
    `SKILL CONTENT:`,
    body,
    ``,
    `Solve the task now. Reply starting with the DELIVERABLE: line.`,
  ].join("\n");
}

async function chatWithRetry(driver, { system, prompt, opts, validate }) {
  let text = "", lastErr = null, retries = 0;
  const attempts = [];
  while (true) {
    const temp = retries === 0 ? opts.temperature : Math.min(0.9, opts.temperature + 0.25 * retries);
    const t1 = Date.now();
    try {
      ({ text } = await driver.chat({ system, prompt, maxTokens: opts.maxTokens, temperature: temp }));
      attempts.push({ attempt: retries, latency_ms: Date.now() - t1, ok: true });
      const problem = validate(text);
      if (!problem) break;
      lastErr = problem;
    } catch (err) {
      lastErr = String(err?.message ?? err);
      attempts.push({ attempt: retries, ok: false, error: lastErr });
    }
    if (retries >= opts.maxRetries) break;
    retries++;
  }
  return { text, attempts, retries, lastErr };
}

export async function runOnce({ scenario, arm, repIndex, driver, opts }) {
  const rec = {
    event: "harness_run", ts: new Date().toISOString(), run_id: randomUUID(),
    scenario: scenario.id, arm, rep: repIndex,
    driver: opts.driverName, model: opts.model, protocol: "two-phase",
  };
  const t0 = Date.now();
  try {
    const tPipe = Date.now();
    const armSet = await resolveArmSet({ arm, catalog: globalThis.__catalog, scenario, repIndex });
    rec.pipeline_ms = Date.now() - tPipe; // recommender overhead: local deterministic JS, ~0 tokens
    rec.skill_set = armSet.ids;
    rec.skill_set_source = armSet.source;
    rec.skill_set_meta = armSet.meta;

    // ---- Phase 1: routing -------------------------------------------------
    const routePrompt = buildRoutePrompt(scenario, armSet);
    const p1 = await chatWithRetry(driver, {
      system: SYSTEM_ROUTE, prompt: routePrompt, opts,
      validate: (t) => (parseChosenSkills(t, armSet.ids).found ? null : "missing SKILLS: line"),
    });
    rec.phase1 = { retries: p1.retries, last_error: p1.lastErr, tokens_est_in: estTokens(SYSTEM_ROUTE.length + routePrompt.length), tokens_est_out: estTokens(p1.text.length) };
    rec.raw_route_reply = p1.text.slice(0, 2000);
    rec.contract_fail_route = !parseChosenSkills(p1.text, armSet.ids).found;
    const parsed = parseChosenSkills(p1.text, armSet.ids);
    rec.chosen = parsed.chosen;
    rec.chosen_hallucinated = parsed.hallucinated;
    const routing = scoreRouting(parsed.valid, scenario);
    rec.routing_recall = routing.recall;
    rec.routing_precision = routing.precision;
    rec.routing_f1 = routing.f1;
    rec.routing_ndcg = routing.ndcg;
    rec.routing_hits = routing.hits; rec.routing_of = routing.of;
    rec.routing_violations = routing.violations; rec.routing_violation_ids = routing.violationIds;

    // ---- Phase 2: task with the chosen skills' full content ---------------
    // Placebo arm: same format, dummy content — tests whether *content* matters
    // vs. mere prompt structure (critic #15).
    const contents = [];
    for (const id of parsed.valid) {
      if (arm === "placebo") contents.push({ id, text: `# ${id}\n[Placebo content: this skill description is intentionally blank. Solve the task from your own knowledge.]`, source: "placebo", truncated: false });
      else contents.push(await fetchSkillContent(globalThis.__catalog, id, opts.contentCache));
    }
    rec.content_sources = Object.fromEntries(contents.map((c) => [c.id, c.source]));
    const taskPrompt = buildTaskPrompt(scenario, contents);
    const p2 = await chatWithRetry(driver, {
      system: SYSTEM_TASK, prompt: taskPrompt, opts,
      validate: (t) => (extractDeliverable(t).length > 0 ? null : "empty deliverable"),
    });
    rec.phase2 = { retries: p2.retries, last_error: p2.lastErr, tokens_est_in: estTokens(SYSTEM_TASK.length + taskPrompt.length), tokens_est_out: estTokens(p2.text.length) };
    rec.raw_reply = p2.text.slice(0, 4000);
    rec.contract_fail_task = extractDeliverable(p2.text).length === 0;
    const rubric = scoreRubric(extractDeliverable(p2.text), scenario.rubric);
    rec.task_score = rubric.score; rec.task_points = rubric.earned; rec.task_max = rubric.max;
    rec.rubric = rubric.perCheck;
    rec.retries = p1.retries + p2.retries;
    rec.tokens_est_in = rec.phase1.tokens_est_in + rec.phase2.tokens_est_in;
    rec.tokens_est_out = rec.phase1.tokens_est_out + rec.phase2.tokens_est_out;
    rec.ok = true;
  } catch (err) {
    rec.ok = false; rec.error = String(err?.message ?? err);
  }
  rec.latency_ms = Date.now() - t0;
  return rec;
}

export function parseArgs(argv) {
  const o = { scenario: "all", arms: "repotify,none,naive", runs: 1, driver: "nvidia", model: "z-ai/glm-5.3", out: null, dryRun: false, maxTokens: 500, temperature: 0.2, maxRetries: 2, concurrency: 2, contentCache: DEFAULT_CACHE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--scenario") o.scenario = val();
    else if (a === "--arms") o.arms = val();
    else if (a === "--runs") o.runs = Number(val());
    else if (a === "--driver") o.driver = val();
    else if (a === "--model") o.model = val();
    else if (a === "--out") o.out = val();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--max-tokens") o.maxTokens = Number(val());
    else if (a === "--temperature") o.temperature = Number(val());
    else if (a === "--max-retries") o.maxRetries = Number(val());
    else if (a === "--concurrency") o.concurrency = Number(val());
    else if (a === "--content-cache") o.contentCache = val();
    else if (a === "--list-scenarios") o.listScenarios = true;
  }
  return o;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.listScenarios) { console.log(listScenarios().join("\n")); return; }
  const scenarioIds = o.scenario === "all" ? listScenarios() : o.scenario.split(",");
  const arms = o.arms.split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm: ${a}`);
  const catalog = loadCatalog((f) => JSON.parse(readFileSync(join(CATALOG_DIR, f), "utf8")));
  globalThis.__catalog = catalog;
  const driver = o.dryRun ? makeDriver("mock") : makeDriver(o.driver, { model: o.model });
  if (o.out) mkdirSync(dirname(o.out), { recursive: true });
  const runOpts = { driverName: o.driver, model: o.model, maxTokens: o.maxTokens, temperature: o.temperature, maxRetries: o.maxRetries, contentCache: o.contentCache };

  const jobs = [];
  for (const sid of scenarioIds) for (const arm of arms) for (let r = 0; r < o.runs; r++) jobs.push({ sid, arm, r });
  const results = await pool(jobs, o.concurrency, async ({ sid, arm, r }) => {
    const scenario = loadScenario(sid);
    console.log(`[${sid} :: ${arm} :: rep ${r}] running…`);
    const rec = await runOnce({ scenario, arm, repIndex: r, driver, opts: runOpts });
    if (o.out) appendFileSync(o.out, JSON.stringify(rec) + "\n");
    console.log(`[${sid} :: ${arm} :: rep ${r}] routing=${rec.routing_recall?.toFixed(2) ?? "ERR"} task=${rec.task_score?.toFixed(2) ?? "ERR"} retries=${rec.retries ?? "?"}`);
    return rec;
  });
  const ok = results.filter((r) => r.ok).length;
  console.log(`done: ${ok}/${results.length} ok${o.out ? ` → ${o.out}` : ""}`);
  return results;
}

if (isMain(import.meta.url)) { main().catch((e) => { console.error(e.message); process.exit(1); }); }
