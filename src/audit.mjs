// Audit of the skills already installed in a project: which ones earn their place in the agent's context, which do
// not, and why. Read-only: it suggests, the user decides, nothing is deleted here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS } from "./agents.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { readTree, scanFiles } from "./scan/index.mjs";
import { buildDemand, fitScore, platformMismatch, DEFAULT_BUDGET_CHARS } from "./recommend.mjs";
import { ID_RE } from "./catalog.mjs";
import { shownName } from "./display.mjs";

export const SKILL_DIRS = [...new Set(Object.values(AGENTS).map((a) => a.skillsDir))];
const MAX_SCAN_FILES = 400;
const MAX_SCAN_BYTES = 30 * 1024 * 1024;
// A SKILL.md this large is not an instruction file anyone should load into an agent; it is not parsed.
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const TRUST_RANK = { verified: 2, caution: 1 };

// Stack words a skill's name or first sentence may carry. A skill named for a stack the project does not use is
// dead weight; mentions deeper in the description are often examples, so they are not read.
const STACK_WORDS = {
  "react-native": /\breact[ -]?native\b|\bexpo\b/, flutter: /\bflutter\b/, solidity: /\bsolidity\b|\bsmart[ -]contracts?\b/,
  django: /\bdjango\b/, flask: /\bflask\b/, fastapi: /\bfastapi\b/, rails: /\bruby on rails\b|\brails\b/, laravel: /\blaravel\b/,
  nextjs: /\bnext\.?js\b/, nuxt: /\bnuxt\b/, vue: /\bvue(?:\.js)?\b/, angular: /\bangular\b/, svelte: /\bsvelte(?:kit)?\b/,
  astro: /\bastro\b/, swift: /\bswift(?:ui)?\b/, kotlin: /\bkotlin\b/, go: /\bgolang\b/, rust: /\brust\b/,
  java: /\bjava\b(?!script)/, php: /\bphp\b/, csharp: /\bc#|\.net\b|\bdotnet\b/, python: /\bpython\b/, ruby: /\bruby\b/,
  react: /\breact\b(?![ -]?native)/,
};
// A stack the project uses also counts for the stacks it is built on.
const IMPLIES = {
  nextjs: ["react"], "react-native": ["react"], expo: ["react-native", "react"], nuxt: ["vue"], fastapi: ["python"],
  django: ["python"], flask: ["python"], rails: ["ruby"], laravel: ["php"], flutter: ["dart"],
};
// Jobs a skill can be recognised by when it is not in the catalog. General process skills (tests first, debugging,
// planning, review) are deliberately absent: they help any project.
const CAP_WORDS = {
  presentations: /\bpptx\b|\bpowerpoint\b|\bslide ?decks?\b|\bpresentations?\b/,
  spreadsheets: /\bxlsx\b|\bexcel\b|\bspreadsheets?\b/,
  "docx-documents": /\bdocx\b|\bword documents?\b/,
  "pdf-processing": /\bpdfs?\b/,
  "smart-contract-security": /\bsolidity\b|\bsmart[ -]contracts?\b/,
  "react-native": /\breact[ -]?native\b|\bexpo\b/,
  "mcp-development": /\bmcp servers?\b|\bmodel context protocol\b/,
  "webapp-testing": /\bplaywright\b|\b(?:e2e|end-to-end) tests?\b/,
  "deploy-vercel": /\bvercel\b/,
};

// Reasons that make a skill worth questioning; "fits" and "caution" are information only.
const QUESTIONED = new Set(["delisted", "platform", "stack", "unneeded", "oversized", "spent"]);

// A skill that pays off once (mapping a codebase, onboarding, a migration; the catalog's `lifecycle`, set by the
// classifier) has likely done its job after this many days, while its description still loads every session.
// An operating point, not a measurement: telemetry on kept/removed skills should tune it.
export const ONCE_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// Rough English token count for context the agent loads (4 characters a token).
export const tokensOf = (chars) => Math.round(chars / 4);

// When was it installed: the lock records it for Repotify installs; otherwise the folder's own timestamp.
function installedAt(skill, lockId, lock) {
  const recorded = Date.parse(lock.items?.[lockId]?.installedAt ?? "");
  if (Number.isFinite(recorded)) return recorded;
  try {
    return statSync(skill.abs).mtimeMs;
  } catch {
    return null;
  }
}

function spent(skill, { item, lockId }, env) {
  if (item?.lifecycle !== "once") return null;
  const at = installedAt(skill, lockId, env.lock);
  if (at == null) return null;
  const days = Math.floor((env.now - at) / DAY_MS);
  if (days < ONCE_GRACE_DAYS) return null;
  return {
    code: "spent",
    text: `Pays off once (${inSentence(label(env.taxonomy, item.capabilities[0]))}); installed ${days} days ago, so it has likely done its job, yet its description loads every session and each use loads its ~${tokensOf(skill.bodyChars)}-token instructions. Remove it and reinstall when you need it again.`,
  };
}

const firstSentence = (text) => text.split(/(?<=[.!?])\s/, 1)[0].slice(0, 240);

// Skill folders (with a SKILL.md) under each agent's skills directory in `root`.
export function findInstalledSkills(root, { scope = "project" } = {}) {
  const found = [];
  for (const skillsDir of SKILL_DIRS) {
    const base = join(root, skillsDir);
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(base, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = statSync(abs).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir && existsSync(join(abs, "SKILL.md"))) found.push({ id: e.name, skillsDir, dir: `${skillsDir}/${e.name}`, abs, scope });
    }
  }
  return found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

function readSkill(s) {
  const size = statSync(join(s.abs, "SKILL.md")).size;
  if (size > MAX_SKILL_MD_BYTES) return { ...s, name: s.id, description: "", alwaysOnChars: 0, bodyChars: size, oversized: true };
  const text = readFileSync(join(s.abs, "SKILL.md"), "utf8");
  const fm = parseFrontmatter(text);
  const name = String(fm.name ?? s.id);
  const description = String(fm.description ?? "").replace(/\s+/g, " ").trim();
  return { ...s, name, description, alwaysOnChars: name.length + description.length, bodyChars: text.length };
}

async function securityOf(abs) {
  try {
    const r = scanFiles(await readTree(abs, { maxFiles: MAX_SCAN_FILES, maxBytes: MAX_SCAN_BYTES }));
    const worst = ["critical", "high", "medium"].map((sev) => r.findings.find((f) => f.severity === sev)).find(Boolean);
    return { level: r.level, rule: worst?.rule ?? null };
  } catch (error) {
    // The message may carry file names from the skill; the code is enough.
    return { level: "caution", rule: `not scanned (${error.code ?? "too large"})` };
  }
}

function catalogMatch(skill, { byId, bySkillDir, lock }) {
  for (const [id, entry] of Object.entries(lock.items ?? {})) {
    if ((entry.targets ?? []).includes(skill.dir)) return { item: byId.get(id) ?? null, lockId: id };
  }
  return { item: byId.get(skill.id) ?? bySkillDir.get(skill.id) ?? null, lockId: null };
}

function projectStacks(stacks) {
  const all = new Set(stacks);
  for (const s of stacks) for (const x of IMPLIES[s] ?? []) all.add(x);
  return all;
}

const label = (taxonomy, cap) => taxonomy.capabilities?.[cap]?.label ?? cap;
// Mid-sentence form of a label: "Distinctive frontend design" -> "distinctive …", but "UI and …" and "PDF …" stay.
const inSentence = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

// What a catalog item does for this project, in words: the wanted jobs it serves, else the stack or needs it helps with.
function whyItFits(item, { taxonomy, ctx, stacks }) {
  const jobs = item.capabilities.filter((c) => ctx.capabilitiesWanted.includes(c));
  if (jobs.length) return `Serves ${jobs.map((c) => inSentence(label(taxonomy, c))).join(", ")}.`;
  const used = item.stacks.filter((s) => s !== "*" && stacks.has(s));
  if (used.length) return `Expertise for ${used.join(", ")}, which this project uses.`;
  const needs = (item.needs ?? []).filter((n) => ctx.needs.includes(n));
  if (needs.length) return `Helps with ${needs.map((n) => taxonomy.needs?.[n]?.label?.toLowerCase() ?? n).join(", ")}.`;
  return "Fits this project.";
}

// Why a skill is or is not worth keeping here: [{code, text}], most important first.
function judge(skill, { item, lockId }, env) {
  const { taxonomy, ctx, stacks, coreReasons } = env;
  if (skill.id === "repotify" || lockId === "repotify") return { verdict: "keep", reasons: [{ code: "self", text: "Repotify's own skill." }] };
  if (skill.security.level === "rejected" || skill.security.level === "quarantined") {
    return { verdict: "remove", reasons: [{ code: "security", text: `Security scan: ${skill.security.level}${skill.security.rule ? ` (${skill.security.rule})` : ""}. Remove it.` }] };
  }
  const reasons = [];
  if (skill.oversized) reasons.push({ code: "oversized", text: `SKILL.md is over ${MAX_SKILL_MD_BYTES / 1024 / 1024} MiB; not read.` });
  if (lockId && !item) reasons.push({ code: "delisted", text: "No longer in the catalog (quarantined or removed upstream)." });
  if (!env.relevance) {
    // No project to judge against (home folder or filesystem root): security and overlaps only.
  } else if (item) {
    const done = spent(skill, { item, lockId }, env);
    if (done) return { verdict: "consider", reasons: [done] };
    if (item.tier === "core") return { verdict: "keep", reasons: [{ code: "core", text: coreReasons.get(item.id) ?? "Core skill that helps any project." }] };
    if (platformMismatch(item, ctx)) {
      reasons.push({ code: "platform", text: `Web-only (${item.capabilities.map((c) => label(taxonomy, c)).join(", ")}), and this project has no web target (${ctx.platforms.join(", ")}).` });
    } else if (item.tier === "stack" && !item.stacks.includes("*") && !item.stacks.some((s) => stacks.has(s))) {
      reasons.push({ code: "stack", text: `Built for ${item.stacks.join(", ")}, which this project does not use.` });
    } else if (fitScore(item, ctx).fit < 0.2) {
      reasons.push({ code: "unneeded", text: `${item.capabilities.map((c) => label(taxonomy, c)).join(", ")}: nothing in this project needs it.` });
    }
  } else {
    const head = `${skill.name} ${firstSentence(skill.description)}`.toLowerCase();
    const named = Object.entries(STACK_WORDS).filter(([, re]) => re.test(head)).map(([s]) => s);
    const text = `${skill.name} ${skill.description}`.toLowerCase();
    const jobs = Object.entries(CAP_WORDS).filter(([, re]) => re.test(text)).map(([c]) => c);
    const webOnly = jobs.length > 0 && platformMismatch({ capabilities: jobs }, ctx);
    if (named.length && !named.some((s) => stacks.has(s))) {
      reasons.push({ code: "stack", text: `Written for ${named.join(", ")}, which this project does not use.` });
    } else if (webOnly) {
      reasons.push({ code: "platform", text: `Web-only work (${jobs.map((c) => label(taxonomy, c)).join(", ")}), and this project has no web target.` });
    } else if (jobs.length && !jobs.some((c) => ctx.capabilitiesWanted.includes(c))) {
      reasons.push({ code: "unneeded", text: `${jobs.map((c) => label(taxonomy, c)).join(", ")}: nothing in this project needs it.` });
    } else if (jobs.length) {
      reasons.push({ code: "fits", text: `Serves ${jobs.filter((c) => ctx.capabilitiesWanted.includes(c)).map((c) => inSentence(label(taxonomy, c))).join(", ")}.` });
    }
  }
  if (skill.security.level === "caution") reasons.push({ code: "caution", text: `Security scan: caution${skill.security.rule ? ` (${skill.security.rule})` : ""}.` });
  const blocking = reasons.some((r) => QUESTIONED.has(r.code));
  if (!blocking && !reasons.some((r) => r.code === "fits")) reasons.unshift({ code: "fits", text: item ? whyItFits(item, env) : "No sign it is out of place here." });
  return { verdict: blocking ? "consider" : "keep", reasons };
}

const STOP = new Set([
  "this", "that", "with", "when", "from", "your", "into", "about", "should", "must", "will", "have", "them", "they", "then",
  "use", "uses", "used", "using", "skill", "skills", "agent", "agents", "code", "project", "projects", "file", "files",
  "make", "makes", "help", "helps", "work", "works", "working", "before", "after", "only", "also", "each", "every",
]);
const wordsOf = (text) => new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
const jaccard = (a, b) => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared || 1);
};
const SIMILAR = 0.6;

// Skills with no recognisable job but near-identical descriptions in the same folder do the same job.
function groupSimilar(results, texts) {
  const open = results.filter((r) => !r.job && r.verdict !== "remove");
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i];
      const b = open[j];
      if (a.skillsDir !== b.skillsDir || jaccard(texts.get(a), texts.get(b)) < SIMILAR) continue;
      const job = a.similarTo ?? `similar:${a.id}`;
      a.similarTo = job;
      b.similarTo = job;
    }
  }
  for (const r of open) {
    if (!r.similarTo) continue;
    r.job = r.similarTo;
    r.jobLabel = "near-identical description";
    delete r.similarTo;
  }
}

// Same job twice in one agent's skills folder: keep the most trusted, then the lightest; mark the rest.
function markOverlaps(results) {
  const groups = new Map();
  for (const r of results) {
    if (r.verdict === "remove" || !r.job) continue;
    const key = `${r.skillsDir}|${r.job}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (TRUST_RANK[b.trust] ?? 0) - (TRUST_RANK[a.trust] ?? 0) || a.alwaysOnChars - b.alwaysOnChars || (a.id < b.id ? -1 : 1));
    for (const r of group.slice(1)) {
      r.verdict = "consider";
      r.reasons = [{ code: "overlap", text: `Does the same job as ${shownName(group[0].id)} (${r.jobLabel}); keep one.` }, ...r.reasons.filter((x) => x.code !== "fits")];
    }
  }
}

export async function auditSkills({ root, catalog, fingerprint: fp, needs, lock = { items: {} }, extraRoots = [], now = Date.now() }) {
  const relevance = fp?.reason !== "home-or-root";
  const { taxonomy } = catalog;
  const demand = buildDemand({ taxonomy, fingerprint: fp, needs });
  const ctx = { ...demand, stacks: fp?.stacks ?? [], loadoutIds: [] };
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const bySkillDir = new Map(catalog.items.filter((i) => i.path).map((i) => [i.path.split("/").pop(), i]));
  const env = { taxonomy, ctx, relevance, lock, now: Number(now), stacks: projectStacks(fp?.stacks ?? []), coreReasons: new Map((catalog.core ?? []).map((c) => [c.id, c.reason])) };
  const skills = [...findInstalledSkills(root), ...extraRoots.flatMap((r) => findInstalledSkills(r.root, { scope: r.scope }))];
  const results = [];
  const texts = new Map();
  for (const s of skills) {
    const skill = readSkill(s);
    skill.security = await securityOf(skill.abs);
    const match = catalogMatch(skill, { byId, bySkillDir, lock });
    const { verdict, reasons } = judge(skill, match, env);
    const text = `${skill.name} ${skill.description}`.toLowerCase();
    const job = match.item?.cluster ?? Object.entries(CAP_WORDS).find(([, re]) => re.test(text))?.[0] ?? null;
    const result = {
      id: skill.id, dir: skill.dir, skillsDir: skill.skillsDir, scope: skill.scope, name: skill.name,
      catalogId: match.item?.id ?? match.lockId ?? null, trust: match.item?.security?.level ?? null,
      verdict, reasons, job, jobLabel: job ? label(taxonomy, job) : null,
      alwaysOnChars: skill.alwaysOnChars, bodyChars: skill.bodyChars, security: skill.security,
      // Lock-file keys come from the project; only a real catalog id goes into a command.
      removeWith: match.lockId && ID_RE.test(match.lockId) ? `repotify remove ${match.lockId}` : null,
    };
    results.push(result);
    texts.set(result, wordsOf(skill.description));
  }
  groupSimilar(results, texts);
  markOverlaps(results);
  const byDir = {};
  for (const r of results) {
    const t = (byDir[r.skillsDir] ??= { skills: 0, alwaysOnChars: 0, freed: 0 });
    t.skills++;
    t.alwaysOnChars += r.alwaysOnChars;
    if (r.verdict !== "keep") t.freed += r.alwaysOnChars;
  }
  return { skills: results, byDir, budget: DEFAULT_BUDGET_CHARS, platforms: demand.platforms, relevance };
}

const MARK = { keep: "keep    ", consider: "consider", remove: "REMOVE  " };

export function formatAudit(report) {
  if (!report.skills.length) return "Repotify audit: no installed skills found (.claude/skills, .cursor/skills, .agents/skills, .gemini/skills).";
  const lines = report.relevance ? [] : ["Not a project folder (home folder or filesystem root): checked security and overlaps only. Run `repotify audit` inside a project to judge relevance."];
  for (const [dir, t] of Object.entries(report.byDir)) {
    const over = t.alwaysOnChars > report.budget ? `, above the ${report.budget}-char budget` : "";
    lines.push(`${dir}: ${t.skills} skill${t.skills === 1 ? "" : "s"}, ${t.alwaysOnChars} chars (~${tokensOf(t.alwaysOnChars)} tokens) of always-on context${over}`);
    for (const r of report.skills.filter((x) => x.skillsDir === dir)) {
      lines.push(`  ${MARK[r.verdict]} ${shownName(r.id).padEnd(31)} ${r.reasons.map((x) => x.text).join(" ")}${r.verdict !== "keep" ? `  (-${r.alwaysOnChars} chars, ~${tokensOf(r.alwaysOnChars)} tokens every session; ~${tokensOf(r.bodyChars)} tokens per use)` : ""}`);
    }
    if (t.freed) lines.push(`  Removing the suggested ones frees ${t.freed} chars (~${tokensOf(t.freed)} tokens) of context in every session.`);
  }
  const acts = report.skills.filter((r) => r.verdict !== "keep");
  if (acts.length) {
    const viaRepotify = acts.filter((r) => r.removeWith).map((r) => r.removeWith);
    lines.push("", "Nothing was deleted. Ask the user before removing anything.");
    if (viaRepotify.length) lines.push(`Installed by Repotify: ${viaRepotify.join("; ")}`);
    const manual = acts.filter((r) => !r.removeWith).map((r) => shownName(r.dir));
    if (manual.length) lines.push(`Other folders to delete once the user agrees: ${manual.join(", ")}`);
  } else {
    lines.push("", "Every installed skill earns its place.");
  }
  return lines.join("\n");
}
