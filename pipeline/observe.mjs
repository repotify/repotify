#!/usr/bin/env node
// Observations of the skills in the content store: the security scan of each skill folder and the decision model's
// answers about each SKILL.md. Both are kept in the store under a key made of the content and the observer's version,
// so nothing is scanned or asked twice, and a new scanner or a new question set only re-observes what it changes.
// Decisions (what enters the catalog, under which job) are made later from these observations (pipeline/derive.mjs).
//   JEV_API_KEY=… node pipeline/observe.mjs --store DIR [--no-jev] [--concurrency 6] [--limit N]
import { resolve } from "node:path";
import { isMain } from "../src/util.mjs";
import { parseFrontmatter } from "../src/frontmatter.mjs";
import { scanFiles, SCANNER_VERSION } from "../src/scan/index.mjs";
import { ask, jevConfig } from "../lib/signals/jev.mjs";
import { createStore, obsKey } from "./store.mjs";
import { capabilityOptions, stackOptions, LIFECYCLES, mapLimit, extendTaxonomy } from "./jev-classify.mjs";
import { extendTaxonomyV2 } from "./taxonomy.mjs";
import { readFileSync } from "node:fs";
import { flag, logStamped } from "./lib/cli.mjs";

// Findings are kept short: the rule, where, how severe and a few words; the full scan can be rerun from the store.
const slimFinding = (f) => ({ rule: f.rule, severity: f.severity, file: f.file, line: f.line, ...(f.note ? { note: f.note } : {}), excerpt: String(f.excerpt ?? "").slice(0, 120) });

export function scanTree(store, tree) {
  const key = obsKey("scan", tree, SCANNER_VERSION);
  const cached = store.getObs("scan", key);
  if (cached) return cached;
  const files = store.treeFiles(tree);
  if (!files) return null;
  const r = scanFiles(files);
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = r.findings.filter((f) => f.severity !== "low").sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 20).map(slimFinding);
  const obs = { level: r.level, findings, scannerVersion: SCANNER_VERSION };
  store.putObs("scan", key, obs);
  return obs;
}

// The questions every SKILL.md is asked, with the options of the current taxonomy. Changing them (a new job, a new
// stack) changes their hash, and the next run asks again: cheap, a few cents for the whole store.
export const QUALITY_LEVELS = ["useless, broken or empty", "weak: vague or thin", "adequate", "good: clear and practical", "excellent: expert, precise and complete"];

// What a skill is for, beyond its job: a payments skill for a web shop and one for an AI agent paying for APIs share a
// job and nothing else. Measured on the store (2026-10-02): without it, security testing reached "mobile testing" and
// an agent payment protocol reached e-commerce sites.
export const PURPOSES = Object.freeze({
  product: "building or changing the software the project ships: features, UI, APIs, data, tests, deployment",
  workflow: "how the coding agent itself works: planning, memory, review discipline, tools for the agent",
  operations: "running, auditing or attacking systems rather than building them: security testing, incident response, IT administration",
  content: "producing documents, media, marketing or business content rather than code",
});
export function skillQuestions(taxonomy) {
  const jobs = { ...capabilityOptions(taxonomy), none: "none of these: a different kind of work (for example game design, hardware, or not software at all)" };
  return {
    coding: {
      type: "noul",
      instructions: "Could a developer use this skill while working on a software project — writing code, testing, reviewing, designing, documenting, handling project files or data, or running the infrastructure?",
      criteria: {
        true: "yes: it is technical work a software project can need",
        false: "no: its subject is not software work at all, for example marketing, growth or sales, digital forensics or malware investigation, competition math, or a personal chat bot",
      },
    },
    job: { type: "choice", instructions: "Which ONE capability is this skill mainly for?", criteria: jobs },
    stack: { type: "choice", instructions: "Is this skill written for one particular language or framework? If it works in any project, answer any.", criteria: stackOptions(taxonomy) },
    lifecycle: { type: "choice", instructions: "When does this skill pay off in a project?", criteria: LIFECYCLES },
    purpose: { type: "choice", instructions: "What is this skill mainly for?", criteria: PURPOSES },
    productBound: {
      type: "noul",
      instructions: "Is this skill only useful together with one specific product, service or tool that most repositories do not use?",
      criteria: {
        true: "yes: it drives or configures one particular product (a vendor CLI, a hosted service, a bot, an editor add-on)",
        false: "no: it works in any repository that does this kind of work",
      },
    },
    quality: {
      type: "score",
      instructions: "How useful and well made are these instructions for an AI coding agent? Judge clarity, concrete steps, examples, correctness and focus.",
      criteria: QUALITY_LEVELS,
    },
  };
}

const round = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);

// The parsed answers as the store keeps them: the chosen option with its probability, and the quality as 0..1.
export function answerRecord(a) {
  return {
    coding: round(a.coding?.probability),
    job: a.job?.option ?? null,
    jobP: round(a.job?.probability),
    stack: a.stack?.option ?? null,
    stackP: round(a.stack?.probability),
    lifecycle: a.lifecycle?.option ?? null,
    lifecycleP: round(a.lifecycle?.probability),
    purpose: a.purpose?.option ?? null,
    purposeP: round(a.purpose?.probability),
    productBound: round(a.productBound?.probability),
    quality: a.quality?.score == null ? null : round(a.quality.score / (QUALITY_LEVELS.length - 1)),
    qualityConfidence: round(a.quality?.confidence),
  };
}

// What the decision model reads about a skill: its own name, description and instructions.
export function skillState(text, fallbackName) {
  const fm = parseFrontmatter(text);
  return {
    name: String(fm.name ?? fallbackName).slice(0, 120),
    description: String(fm.description ?? "").replace(/\s+/g, " ").trim().slice(0, 1000),
    skill_md: text.slice(0, 12000),
  };
}

export async function classifySkill(store, { skillMd, name }, { questions, model, env = process.env, fetchImpl } = {}) {
  const key = obsKey("jev", skillMd, questions, model);
  const cached = store.getObs("jev", key);
  if (cached) return { ...cached, cached: true };
  const blob = store.getBlob(skillMd);
  if (!blob) return null;
  const answers = await ask(skillState(blob.toString("utf8"), name), questions, { env, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!answers || Object.values(answers).some((a) => a === null)) return null;
  const obs = { ...answerRecord(answers), model };
  store.putObs("jev", key, obs);
  return { ...obs, cached: false };
}

// Every skill folder of every repository's current commit: scanned, and asked when `jev` is on.
export async function observeAll(store, { taxonomy, jev = true, concurrency = 6, limit = Infinity, env = process.env, fetchImpl, log = () => {} } = {}) {
  const questions = skillQuestions(taxonomy);
  const model = jevConfig(env).model;
  const work = [];
  for (const name of store.listRepos()) {
    const rec = store.getRepo(name);
    for (const s of rec?.skills ?? []) if (s.tree) work.push({ repo: name, ...s });
  }
  const stats = { skills: work.length, scanned: 0, asked: 0, cached: 0, failed: 0 };
  const seen = new Set();
  let done = 0;
  await mapLimit(work.slice(0, limit), concurrency, async (s) => {
    if (scanTree(store, s.tree)) stats.scanned++;
    if (!jev || !s.skillMd || seen.has(s.skillMd)) return;
    seen.add(s.skillMd);
    const r = await classifySkill(store, { skillMd: s.skillMd, name: s.path.split("/").pop() || s.repo.split("/")[1] }, { questions, model, env, fetchImpl });
    if (!r) stats.failed++;
    else if (r.cached) stats.cached++;
    else stats.asked++;
    if (++done % 100 === 0) log(`${done} asked or cached, ${stats.failed} failed`);
  });
  return stats;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const store = createStore(resolve(flag(args, "--store", "store")));
  const taxonomy = extendTaxonomyV2(extendTaxonomy(JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"))));
  const t0 = Date.now();
  const stats = await observeAll(store, {
    taxonomy, jev: !args.includes("--no-jev"), concurrency: Number(flag(args, "--concurrency", "6")), limit: Number(flag(args, "--limit", "Infinity")),
    log: logStamped,
  });
  console.log(JSON.stringify({ ...stats, seconds: Math.round((Date.now() - t0) / 1000) }));
}
