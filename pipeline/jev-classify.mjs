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

export function questionsFor(capabilities) {
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
export async function classifyItem(item, { capabilities, text, cacheDir, env = process.env, ...opts } = {}) {
  const questions = questionsFor(capabilities);
  const state = stateFor(item, text);
  const cache = cacheDir ? join(cacheDir, "answers", `${keyOf(state, questions, env.JEV_MODEL ?? "")}.json`) : null;
  if (cache && existsSync(cache)) return { ...JSON.parse(readFileSync(cache, "utf8")), cached: true };
  const r = await ask(state, questions, { env, ...opts });
  if (!r || !r.coding || !r.job || !r.lifecycle || !r.productBound) return null;
  const out = { coding: r.coding, job: r.job, lifecycle: r.lifecycle, productBound: r.productBound };
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
