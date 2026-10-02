// Classify catalog items with a Jev-compatible decision model.
//
// The jury writes free-form label lists, and a taxonomy with no slot for
// databases, DevOps or data/ML pushed such skills into "implementation
// planning". Here every item gets four typed questions about its real SKILL.md,
// each answered with a probability:
//   coding       — does it help build software in a repo? (gate for off-topic collections)
//   job          — the ONE capability it is for, or "none"
//   lifecycle    — once | every_task | occasional (when it pays off; "once" skills
//                  like a codebase map earn their context early and cost it later)
//   productBound — only useful with one product most repos do not use
// The pipeline's rules decide what to do with the answers; Jev only informs.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ask } from "../lib/signals/jev.mjs";
import { rawUrl } from "../src/install.mjs";

export const LIFECYCLES = {
  once: "once, at the start of a project or for a one-off job: mapping or onboarding to a codebase, scaffolding, a migration",
  every_task: "on every coding task: a working discipline or method, or expertise in the project's main language or framework",
  occasional: "now and then, for one specific kind of task: a security scan, a PDF, a deploy, a database tuning session",
};

// Text the classifier reads: the skill's own SKILL.md when there is one, else its summary.
export async function skillText(item, { fetchImpl = fetch, cacheDir } = {}) {
  const md = (item.files ?? []).find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
  if (!md || !item.repo || !item.commit) return null;
  const cache = cacheDir ? join(cacheDir, "skill-md", `${item.repo.replace("/", "__")}__${item.commit}__${(item.path ?? "").replace(/\//g, "_")}.md`) : null;
  if (cache && existsSync(cache)) return readFileSync(cache, "utf8");
  try {
    const res = await fetchImpl(rawUrl(item, md));
    if (!res.ok) return null;
    const text = await res.text();
    if (cache) {
      mkdirSync(join(cacheDir, "skill-md"), { recursive: true });
      writeFileSync(cache, text);
    }
    return text;
  } catch {
    return null;
  }
}

// Stack id -> label, plus "any".
export function stackOptions(taxonomy) {
  const out = { any: "any language or framework: it works in any project" };
  for (const [id, st] of Object.entries(taxonomy.stacks ?? {})) out[id] = `${st.label ?? id} only`;
  return out;
}

export function questionsFor(capabilities, stacks = null) {
  const jobs = { ...capabilities, none: "none of these: a different kind of work (for example game development, embedded firmware, or not software at all)" };
  return {
    // Asked as "is it off-topic?" so technical work around code (PDFs, spreadsheets,
    // docs, design, infrastructure) is not mistaken for non-coding.
    coding: {
      type: "noul",
      instructions: "Could a developer use this skill while working on a software project — writing code, testing, reviewing, designing, documenting, handling project files or data, or running the infrastructure?",
      criteria: {
        true: "yes: it is technical work a software project can need",
        false: "no: its subject is not software work at all, for example marketing, growth or sales, digital forensics or malware investigation, competition math, or setting up a personal chat bot",
      },
    },
    job: { type: "choice", instructions: "Which ONE capability is this skill mainly for?", criteria: jobs },
    lifecycle: { type: "choice", instructions: "When does this skill pay off in a project?", criteria: LIFECYCLES },
    ...(stacks ? { stack: { type: "choice", instructions: "Is this skill written for one particular language or framework? If it works in any project, answer any.", criteria: stacks } } : {}),
    productBound: {
      type: "noul",
      instructions: "Is this skill only useful together with one specific product, service or tool that most repositories do not use?",
      criteria: {
        true: "yes: it drives or configures one particular product (a vendor CLI, a hosted service, a bot, an editor add-on)",
        false: "no: it works in any repository that does this kind of work",
      },
    },
  };
}

// Capability id -> label, from the taxonomy plus any capabilities proposed alongside it.
export function capabilityOptions(taxonomy, extra = {}) {
  const out = {};
  for (const [id, c] of Object.entries(taxonomy.capabilities ?? {})) out[id] = c.label ?? id;
  return { ...out, ...extra };
}

const MAX_TEXT = 12000;

export function stateFor(item, text) {
  return {
    name: item.name ?? item.id,
    summary: item.summary ?? "",
    type: item.type,
    skill_md: text ? text.slice(0, MAX_TEXT) : "(not available; judge from the name and summary)",
  };
}

const keyOf = (state, questions, model) => createHash("sha256").update(JSON.stringify({ state, questions, model })).digest("hex").slice(0, 32);

// One item, one request. Returns { coding, job, lifecycle, productBound, cached } or null when the call failed.
export async function classifyItem(item, { capabilities, stacks = null, text, cacheDir, env = process.env, ...opts } = {}) {
  const questions = questionsFor(capabilities, stacks);
  const state = stateFor(item, text);
  const cache = cacheDir ? join(cacheDir, "answers", `${keyOf(state, questions, env.JEV_MODEL ?? "")}.json`) : null;
  if (cache && existsSync(cache)) return { ...JSON.parse(readFileSync(cache, "utf8")), cached: true };
  const r = await ask(state, questions, { env, ...opts });
  if (!r || !r.coding || !r.job || !r.lifecycle || !r.productBound) return null;
  if (stacks && !r.stack) return null;
  const out = { coding: r.coding, job: r.job, lifecycle: r.lifecycle, productBound: r.productBound, ...(stacks ? { stack: r.stack } : {}) };
  if (cache) {
    mkdirSync(join(cacheDir, "answers"), { recursive: true });
    writeFileSync(cache, JSON.stringify(out));
  }
  return { ...out, cached: false };
}

// Run fn over items with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// From answers to catalog decisions. The rules decide; Jev's probabilities only
// count above these bars (measured on test/classify: every main-job answer at
// >= 0.75 was right, true coding skills scored >= 0.87 and off-topic <= 0.52).
export const BARS = Object.freeze({
  keepCoding: 0.8, // below: not sure it is software work -> review
  dropCoding: 0.5, // below: off-topic -> out of the catalog
  job: 0.75, // main job applied at or above
  jobAgree: 0.4, // ...or at or above this when the jury listed the same capability (two classifiers agree)
  lifecycle: 0.7, // lifecycle recorded at or above
  productBound: 0.8, // at or above: only useful with one product -> out
  stack: 0.75, // the language/framework answer applied at or above
});

// Capabilities the taxonomy lacked: without them the jury filed databases,
// DevOps, data/ML and the rest under "implementation planning".
export const NEW_CAPABILITIES = Object.freeze({
  "architecture-design": { label: "System and API architecture" },
  database: { label: "Databases: SQL, schema and query performance" },
  "devops-infra": { label: "DevOps and infrastructure: CI/CD, containers, cloud, monitoring" },
  "data-ml": { label: "Data and ML engineering: pipelines, training, RAG" },
  "agent-orchestration": { label: "Coordinating several AI agents or sessions" },
  "typescript-expertise": { label: "TypeScript expertise" },
});
// Which project needs ask for them. Infrastructure and databases only on
// evidence (a Dockerfile or Terraform, a database client in the manifest), never
// on a project-type guess: "a web app probably deploys" put a monitoring skill
// in every web app's default set.
export const NEW_NEEDS = Object.freeze({
  infra: { label: "Runs its own infrastructure (containers, Terraform)" },
  database: { label: "Works with a database" },
});
export const NEW_NEED_LINKS = Object.freeze({
  infra: ["devops-infra"],
  database: ["database"],
  "data-processing": ["data-ml"],
  "large-codebase": ["architecture-design"],
});

export function extendTaxonomy(taxonomy) {
  const t = structuredClone(taxonomy);
  for (const [id, c] of Object.entries(NEW_CAPABILITIES)) t.capabilities[id] ??= { ...c };
  for (const [id, n] of Object.entries(NEW_NEEDS)) t.needs[id] ??= { ...n, capabilities: [] };
  for (const [need, caps] of Object.entries(NEW_NEED_LINKS)) {
    const n = t.needs[need];
    n.capabilities = [...new Set([...(n.capabilities ?? []), ...caps])];
  }
  return t;
}

// Needs that ask for a capability, from the taxonomy (deterministic, no model).
export function needsFor(capability, taxonomy) {
  return Object.entries(taxonomy.needs ?? {}).filter(([, n]) => (n.capabilities ?? []).includes(capability)).map(([id]) => id).sort();
}

// "<lang>-expertise" for a stack the taxonomy knows makes a stack expert.
const expertiseStack = (job, taxonomy) => {
  const m = /^([a-z0-9]+)-expertise$/.exec(job ?? "");
  return m && taxonomy.stacks?.[m[1]] ? m[1] : null;
};

// Jev's parsed answers -> the flat record stored in pipeline/classification.json.
export function recordOf(answers, model = null) {
  const a = answers;
  return {
    model,
    coding: round(a.coding.probability),
    job: a.job.option,
    jobP: round(a.job.probability),
    lifecycle: a.lifecycle.option,
    lifecycleP: round(a.lifecycle.probability),
    productBound: round(a.productBound.probability),
    ...(a.stack ? { stack: a.stack.option, stackP: round(a.stack.probability) } : {}),
  };
}

// The rules. record: recordOf(...) or an entry of pipeline/classification.json.
// curated: labels set by hand (core and hand-written seed entries); Jev never
// rewrites those, a confident disagreement only goes to review.
// Returns { action: "keep" | "drop" | "review", reasons, item }.
export function decide(item, record, { taxonomy, curated = false } = {}) {
  const r = record;
  const reasons = [];
  const next = { ...item, origin: curated ? "curated" : "lab" };
  if ((r.lifecycleP ?? 0) >= BARS.lifecycle) next.lifecycle = r.lifecycle;
  else delete next.lifecycle;
  if (item.tier === "core") return { action: "keep", reasons, item: next };

  const jobSure = (r.jobP ?? 0) >= BARS.job || ((item.capabilities ?? []).includes(r.job) && (r.jobP ?? 0) >= BARS.jobAgree);
  if (curated) {
    if (r.coding < BARS.keepCoding) reasons.push(`off-topic? coding ${r.coding}`);
    if (r.productBound >= BARS.productBound) reasons.push(`product-bound ${r.productBound}`);
    if (jobSure && r.job !== item.capabilities?.[0] && r.job !== "none") reasons.push(`job ${r.job} (${r.jobP}) vs ${item.capabilities?.[0]}`);
    return { action: reasons.length ? "review" : "keep", reasons, item: next };
  }

  if (r.coding < BARS.dropCoding) return { action: "drop", reasons: [`off-topic: coding ${r.coding}`], item: null };
  if (r.productBound >= BARS.productBound) return { action: "drop", reasons: [`only useful with one product: ${r.productBound}`], item: null };
  if (r.coding < BARS.keepCoding) reasons.push(`not sure it is software work: coding ${r.coding}`);
  if ((r.stackP ?? 0) >= BARS.stack) next.stacks = r.stack === "any" ? ["*"] : [r.stack];
  if (jobSure && r.job === "none") reasons.push(`no capability fits (${r.jobP})`);
  else if (jobSure && taxonomy.capabilities[r.job]) {
    next.capabilities = [r.job];
    next.cluster = r.job;
    next.needs = needsFor(r.job, taxonomy);
  } else reasons.push(`main job unsure: ${r.job} (${r.jobP})`);
  // A stack expert: expertise as its job and written for specific stacks (or its expertise names one).
  const job = next.capabilities?.[0];
  const stack = expertiseStack(job, taxonomy);
  if (stack && (next.stacks ?? ["*"]).includes("*")) next.stacks = [stack];
  const specific = (next.stacks ?? []).length > 0 && !(next.stacks ?? []).includes("*");
  next.tier = /-expertise$/.test(job ?? "") && specific ? "stack" : "mission";
  return { action: reasons.length ? "review" : "keep", reasons, item: next };
}

const round = (x) => (x == null ? null : Math.round(x * 100) / 100);
