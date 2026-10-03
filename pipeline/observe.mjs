#!/usr/bin/env node
// Observations of the skills in the content store: the security scan of each skill folder and the decision model's
// answers about each SKILL.md. Both are kept in the store under a key made of the content and the observer's version,
// so nothing is scanned or asked twice, and a new scanner or a new question set only re-observes what it changes.
// Decisions (what enters the catalog, under which job) are made later from these observations (pipeline/derive.mjs).
// A run reads only repositories that are new or changed since the last one, and asks within a budget (see "At scale").
//   JEV_API_KEY=… node pipeline/observe.mjs --store DIR [--no-jev] [--max-asks N] [--per-repo 100] [--concurrency 6]
//                                           [--shard i/n]   (one of n processes scanning the same store)
import { resolve } from "node:path";
import { isMain } from "../src/util.mjs";
import { parseFrontmatter } from "../src/frontmatter.mjs";
import { scanFiles, SCANNER_VERSION } from "../src/scan/index.mjs";
import { ask, jevConfig } from "../lib/signals/jev.mjs";
import { createStore, obsKey, obsKeyer } from "./store.mjs";
import { licenseFromText } from "./collect.mjs";
// derive.mjs reads observations through this module, and this module asks only about what derive's rules could list:
// the two import each other, and use each other's exports only inside functions.
import { PERMISSIVE, summaryOf } from "./derive.mjs";
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

// ---------------------------------------------------------------------------
// At scale. A store of 12,000 repositories holds 400,000 skill folders: reading every one of them on every run takes
// hours on a slow disk, and asking the model about every one costs more than the catalog can use. So what a run finds
// about a repository is kept in the store's index, and the model is asked within a budget.

// Bump when the facts kept per skill change.
export const INDEX_VERSION = 1;
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i;
const folderOf = (repo, path) => path.split("/").pop() || repo.split("/")[1];

// The key of the decision model's answer about a SKILL.md, for many skills.
export const jevKeyer = (questions, model) => obsKeyer(["jev"], [questions, model]);

// What observing a repository's skill folders found: each folder's scan level and what its SKILL.md says about itself
// (name, description, a license file of its own). Kept in the index under a key made of the folders, the scanner
// version and INDEX_VERSION: a repository with the same folders is not read again, a new commit or a new scanner is.
// A repository some of whose files the store does not hold is not indexed, so it is observed again once they arrive.
export function repoFacts(store, name, rec) {
  const folders = (rec.skills ?? []).filter((s) => s.tree);
  const key = obsKey("observe-index", INDEX_VERSION, SCANNER_VERSION, folders.map((s) => [s.path, s.tree, s.skillMd ?? null, Boolean(s.hidden)]));
  const cached = store.getIndex("observe", name);
  if (cached?.key === key) return { ...cached, fresh: false };
  let incomplete = false;
  const skills = folders.map((s) => {
    let scan = null;
    try {
      scan = scanTree(store, s.tree)?.level ?? null;
    } catch {
      // A folder the scanner cannot read is not listable; the other folders are still observed.
      scan = "unreadable";
    }
    if (!scan) incomplete = true;
    const fact = { path: s.path, tree: s.tree, skillMd: s.skillMd ?? null, hidden: Boolean(s.hidden), scan, name: null, description: "", descriptionChars: 0 };
    const text = s.skillMd ? store.getBlob(s.skillMd)?.toString("utf8") : null;
    if (text != null) {
      const fm = parseFrontmatter(text);
      if (fm.name != null && String(fm.name).trim()) fact.name = String(fm.name).slice(0, 120);
      fact.description = skillState(text, "").description;
      fact.descriptionChars = String(fm.description ?? "").length;
    }
    const licenseFile = (store.getTree(s.tree) ?? []).find((e) => e.sha256 && LICENSE_FILE.test(e.path));
    if (licenseFile) fact.license = licenseFromText(store.getBlob(licenseFile.sha256)?.toString("utf8") ?? "");
    return fact;
  });
  const index = { key, scannerVersion: SCANNER_VERSION, skills };
  if (!incomplete) store.putIndex("observe", name, index);
  return { ...index, fresh: true, incomplete };
}

// Which skills to ask the decision model about, and in what order. `repos` is [{ repo, stars, license, skills }] with
// the facts above; `installs` maps "owner/name/folder" to installs on skills.sh.
//   - Most installed first, then the best-known repositories: the budget goes where a recommendation is most likely.
//   - At most `perRepo` skills of one repository (answered ones count): a collection of 8,000 folders would take the
//     whole budget otherwise. A skill people install is asked about whatever its repository's count.
//   - A skill that could not be listed whatever the answer is not asked: failed or missing scan, no license the catalog
//     accepts, kept in the repository's own agent folder, no description a user can be shown.
//   - One question per distinct SKILL.md, and a name already answered or queued waits until every new name is asked:
//     it is most often a copy with small changes.
export function planAsks(repos, { installs = new Map(), isAnswered = () => false, perRepo = 100 } = {}) {
  const stats = { uniqueSkillMd: 0, answered: 0, askable: 0, sameName: 0, skipped: { scan: 0, license: 0, hidden: 0, description: 0, perRepo: 0 } };
  const all = new Set();
  const work = [];
  for (const r of repos) {
    for (const s of r.skills) {
      if (!s.skillMd) continue;
      all.add(s.skillMd);
      const folder = folderOf(r.repo, s.path);
      const item = { repo: r.repo, stars: r.stars ?? 0, path: s.path, skillMd: s.skillMd, folder, installs: installs.get(`${r.repo}/${folder.toLowerCase()}`) ?? 0, answered: Boolean(isAnswered(s.skillMd)) };
      if (!item.answered) {
        const license = r.license && r.license !== "NOASSERTION" ? r.license : s.license ?? null;
        if (!["verified", "caution"].includes(s.scan)) { stats.skipped.scan++; continue; }
        if (!PERMISSIVE.has(license)) { stats.skipped.license++; continue; }
        if (s.hidden && !item.installs) { stats.skipped.hidden++; continue; }
        if (!summaryOf(s.description)) { stats.skipped.description++; continue; }
      }
      work.push(item);
    }
  }
  stats.uniqueSkillMd = all.size;
  work.sort((a, b) => b.installs - a.installs || b.stars - a.stars || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const names = new Set(work.filter((s) => s.answered).map((s) => s.folder.toLowerCase()));
  const seen = new Set();
  const count = new Map();
  const todo = [];
  const sameName = [];
  for (const s of work) {
    if (seen.has(s.skillMd)) continue;
    const used = count.get(s.repo) ?? 0;
    if (s.answered) {
      seen.add(s.skillMd);
      count.set(s.repo, used + 1);
      stats.answered++;
      continue;
    }
    if (!s.installs && used >= perRepo) { stats.skipped.perRepo++; continue; }
    seen.add(s.skillMd);
    count.set(s.repo, used + 1);
    const name = s.folder.toLowerCase();
    (names.has(name) ? sameName : todo).push(s);
    names.add(name);
  }
  stats.askable = todo.length + sameName.length;
  stats.sameName = sameName.length;
  return { todo, sameName, stats };
}

// A stable share of the repositories for one of `of` processes working on the same store.
const inShard = (name, [index, of]) => parseInt(obsKey(name).slice(0, 8), 16) % of === index;

// Every repository's skill folders scanned (only the new or changed ones are read), then the decision model asked
// within `maxAsks`, in the order of planAsks (`maxAsks: 0` plans and counts without asking; `jev: false` only scans).
// Twelve failures in a row end the asking: the model or the credit is gone.
export async function observeAll(store, { taxonomy, jev = true, maxAsks = Infinity, perRepo = 100, concurrency = 6, shard = null, maxFailures = 12, env = process.env, fetchImpl, log = () => {} } = {}) {
  const stats = { repos: 0, withSkills: 0, skills: 0, scanned: 0, observed: 0, unchanged: 0, incomplete: 0 };
  const repos = [];
  for (const name of store.listRepos()) {
    if (shard && !inShard(name, shard)) continue;
    const rec = store.getRepo(name);
    if (!rec || rec.error) continue;
    stats.repos++;
    const facts = repoFacts(store, name, rec);
    if (facts.fresh) stats.observed++;
    else stats.unchanged++;
    if (facts.incomplete) stats.incomplete++;
    if (facts.skills.length) stats.withSkills++;
    stats.skills += facts.skills.length;
    stats.scanned += facts.skills.filter((s) => s.scan && s.scan !== "unreadable").length;
    if (facts.fresh && stats.observed % 200 === 0) log(`${stats.observed} repositories observed, ${stats.skills} skill folders so far`);
    if (jev) repos.push({ repo: name, stars: rec.meta?.stars ?? 0, license: rec.license ?? null, skills: facts.skills });
  }
  if (!jev) return stats;

  const questions = skillQuestions(taxonomy);
  const model = jevConfig(env).model;
  const keyOf = jevKeyer(questions, model);
  const answeredKeys = store.listObs("jev");
  const installs = new Map((store.getState("skills-sh")?.skills ?? []).map((s) => [`${String(s.source).toLowerCase()}/${String(s.skill).toLowerCase()}`, s.installs]));
  // A text held by a thousand repositories is hashed once.
  const known = new Map();
  const isAnswered = (md) => known.get(md) ?? known.set(md, answeredKeys.has(keyOf(md))).get(md);
  const plan = planAsks(repos, { installs, isAnswered, perRepo });
  Object.assign(stats, plan.stats, { asked: 0, failed: 0 });
  let streak = 0;
  await mapLimit([...plan.todo, ...plan.sameName].slice(0, maxAsks), concurrency, async (s) => {
    if (stats.stopped) return;
    let r = null;
    try {
      r = await classifySkill(store, { skillMd: s.skillMd, name: s.folder }, { questions, model, env, fetchImpl });
    } catch {
      r = null;
    }
    if (r) {
      stats.asked++;
      streak = 0;
    } else {
      stats.failed++;
      if (++streak >= maxFailures && !stats.stopped) {
        stats.stopped = true;
        log(`${maxFailures} questions in a row went unanswered: no more questions in this run`);
      }
    }
    if ((stats.asked + stats.failed) % 250 === 0) log(`${stats.asked} answered, ${stats.failed} failed`);
  });
  stats.waiting = stats.askable - stats.asked;
  return stats;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const store = createStore(resolve(flag(args, "--store", "store")));
  const taxonomy = extendTaxonomyV2(extendTaxonomy(JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"))));
  const t0 = Date.now();
  const shard = flag(args, "--shard", null)?.split("/").map(Number) ?? null;
  const stats = await observeAll(store, {
    taxonomy, jev: !args.includes("--no-jev"), maxAsks: Number(flag(args, "--max-asks", "Infinity")), perRepo: Number(flag(args, "--per-repo", "100")),
    concurrency: Number(flag(args, "--concurrency", "6")), shard, log: logStamped,
  });
  console.log(JSON.stringify({ ...stats, seconds: Math.round((Date.now() - t0) / 1000) }));
}
