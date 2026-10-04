#!/usr/bin/env node
// Builds the catalog from the content store: every stored skill and MCP server that passes the rules below joins the
// hand-vetted items already in the catalog. No network and no model: the rules read observations the store already
// holds (the security scan, the decision model's answers, the research team's reputation records, installs on
// skills.sh, downloads), so a changed rule rebuilds the catalog in seconds without downloading or asking anything again.
//   node pipeline/derive.mjs --store DIR [--out catalog] [--dry-run] [--report FILE]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../src/util.mjs";
import { ID_RE, MAX_SUMMARY, PUBLISHABLE_LEVELS, validateCatalog } from "../src/catalog.mjs";
import { SCANNER_VERSION } from "../src/scan/index.mjs";
import { jevConfig } from "../lib/signals/jev.mjs";
import { createStore } from "./store.mjs";
import { scanTree, skillQuestions, repoFacts, jevKeyer } from "./observe.mjs";
import { consensusKeyer, isApproved } from "./consensus.mjs";
import { shingles, isCopy, compareRank, isOwnSource, LARGE_COLLECTION } from "./copies.mjs";
import { extendTaxonomy, needsFor } from "./jev-classify.mjs";
import { extendTaxonomyV2 } from "./taxonomy.mjs";
import { unsafeSummary } from "./run.mjs";
import { GATE_VERSION, setupSecurity } from "./gate.mjs";
import { reputationKey } from "./research.mjs";
import { writeCatalogFiles } from "./publish.mjs";
import { serverObservations, mcpSetup, startsServer } from "./mcp.mjs";
import { flag } from "./lib/cli.mjs";

// Bump when a rule changes; every derived item records it.
export const DERIVE_VERSION = "3";

// The operating points of the rules. Set by reading the store's distributions, not fitted.
// Stricter than the curated catalog's bars (jev-classify BARS): these items had no human look. Measured on the 49
// eval scenarios with the store's 4,651 skills (2026-10-02): at the curated bars, a SCIM-for-Okta skill reached
// Angular apps and an n8n skill became every Python project's "Python expert".
export const RULES = Object.freeze({
  coding: 0.8, // below: not clearly software work
  productBound: 0.5, // at or above: tied to one product; kept only when that product is a stack a project can show
  job: 0.75, // the main job counts at or above
  stack: 0.75, // the language, framework or product counts at or above
  lifecycle: 0.7,
  quality: 0.75, // "good" on the decision model's five-level scale
  qualityConfidence: 0.5,
});

// A derived item may join a default set only with evidence about the skill itself, beyond its own text: people install
// it, or the research team found its repository well regarded and named this skill among its best. A popular
// repository does not vouch for each of its skills (an agent framework's payment-protocol skill reached e-commerce
// sites that way). Without the evidence the item is still listed, as an alternate the agent can choose. For an MCP
// server the evidence is use, seen twice: downloads a month from npm or PyPI, and a repository people starred
// (downloads alone can be padded by one machine in a loop). A server written for a stack the project shows needs
// 10,000 and 200; one offered to any project needs ten times the downloads and five times the stars, because a tool
// for one bundler or one service passes for "any project" more easily than it should.
export const DEFAULT_EVIDENCE = Object.freeze({ quality: 0.85, job: 0.85, installs: 1000, reputation: 0.65, downloads: 10000, stars: 200, anyStackDownloads: 100000, anyStackStars: 1000 });

// How many derived skills the catalog lists from one repository, from one repository for one job, and for one job and
// stack in all: the most installed, then the best made. Twenty alternates for a job help nobody choose, and without a
// limit the numbers come from a few sources (measured on the store, 2026-10-04: one repository of design snippets
// supplied 63 skills, a game engine's own repository 22 for "game development", one collection 274 before that).
export const SKILL_LIMITS = Object.freeze({ perRepo: 15, perRepoJob: 3, perJob: 10 });
// Folders a repository keeps as samples, benchmark output, translations or tooling for its own contributors: not
// skills it offers. Read on the store: examples/…/my-first-skill, benchmarks/gdpval/skills/… (fifteen variants of one
// workflow), skills-contrib/contrib-pr ("open a PR against this repository"), skills/i18n/….
const NOT_OFFERED = /(^|[\/_-])(examples?|samples?|benchmarks?|contrib|contributing|maintainers?|i18n|demos?)([\/_-]|$)|(^|\/)dev(\/|$)/i;
// A skills repository says so (its name, its topics) or is mostly skill folders. Anything else is a project that
// ships a few skills about itself (a game engine's "tweens", a table library's "getting started" for each framework):
// those fit a repository only when it uses that project, which the catalog can tell for product stacks alone.
// Measured on the store (2026-10-04, 158 repositories with listable skills): skill folders hold a fifth of the files
// or more in the skills repositories read, a tenth or less in the projects.
const SKILLS_TOPICS = new Set(["skills", "agent-skills", "claude-skills", "claude-code-skills", "codex-skills", "claude-code-plugin", "claude-code-plugins"]);
const SKILLS_SHARE = 0.2;
export const isSkillsRepo = (name, { topics = [], files = null, skillFiles = 0 } = {}) =>
  /(^|[-_.])skills?([-_.]|$)/i.test(String(name).split("/")[1] ?? "") || topics.some((t) => SKILLS_TOPICS.has(t)) || !files || skillFiles / files >= SKILLS_SHARE;
// A skill whose description names the project it lives in ("Hardens LifeOS tests") works on that project, unless the
// skill is the project (a one-skill repository) or the name is a common word.
const COMMON_REPO_NAMES = new Set(["agents", "agent", "skills", "skill", "tools", "toolkit", "plugins", "plugin", "prompts", "rules", "awesome", "claude", "codex", "cursor", "gemini", "superpowers"]);
function namesOwnProject(c, description) {
  const name = c.repo.split("/")[1];
  const parts = name.split(/[-_.]+/).filter(Boolean);
  if (name.length < 5 || COMMON_REPO_NAMES.has(name) || !c.skill.path || slug(c.folder) === slug(name) || slug(c.fm.name ?? "") === slug(name)) return false;
  return new RegExp(`(^|[^a-z0-9])${parts.map((p) => p.replace(/[^a-z0-9]/gi, "")).join("[-_ .]?")}([^a-z0-9]|$)`, "i").test(description);
}
// A repository that republishes prompts and skills taken from other products has no license to give for them.
const REPUBLISHED = /(^|[^a-z])leak(s|ed)?([^a-z]|$)|system[-_ ]?prompts?|jailbreak/i;
// The catalog's text is English: a description mostly in another script cannot be shown, and the skill behind it is
// most often a translation of one already listed.
const latinShare = (text) => {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length ? (text.match(/\p{Script=Latin}/gu) ?? []).length / letters.length : 1;
};
// How many better-placed holders of the same name a skill is compared with, at most.
const NAME_COMPARISONS = 25;

export const PERMISSIVE = new Set(["MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "0BSD", "CC0-1.0", "CC-BY-4.0", "MPL-2.0", "BSL-1.0", "Zlib", "BlueOak-1.0.0"]);
export const ALL_AGENTS = ["claude-code", "cursor", "codex", "gemini-cli", "generic"];
const GENERIC_NAMES = new Set(["api", "setup", "overview", "docs", "documentation", "performance", "debugging", "testing", "tests", "architecture", "helper", "utils", "tools", "skill", "guide", "readme", "config", "deploy", "review", "code-review", "security", "frontend", "backend", "database", "git", "ci", "cd", "ci-cd", "write-tests", "browser-automation", "data-analysis", "default", "main", "core", "example", "template"]);
// Jobs the catalog does not serve: running a security operations centre is not building software.
export const OUT_OF_SCOPE = new Set(["security-operations"]);
// Jobs Repotify's own hooks do. A crawled item for one of them is out: a server that routes to skills or loads them
// at run time brings content nobody vetted.
export const OWN_JOBS = new Set(["skill-routing", "setup-tracking", "package-guard"]);
// How many crawled MCP servers the catalog lists for one job and stack, and from one publisher: the most used ones.
// A hundred memory servers help nobody choose.
export const MCP_LIMITS = Object.freeze({ perJob: 3, perOwner: 3 });
// What a crawled MCP server needs to be listed at all: use and a repository people starred. Below it the registry is
// full of experiments nobody can vouch for, and an agent reading the table should not meet them.
export const MCP_LISTING = Object.freeze({ downloads: 10000, stars: 100 });

// Jobs about the software a project ships: a skill for them must be for building that software (purpose "product").
// Jobs about the agent itself must be for the agent's work (purpose "workflow"). Documents and media may be content.
const PRODUCT_DOMAINS = new Set(["frontend", "backend", "mobile", "testing", "devops", "languages"]);
const WORKFLOW_JOBS = new Set(["agent-memory", "workflow-meta", "agent-orchestration", "skill-authoring", "implementation-planning", "design-brainstorming", "verification-gate", "debugging-method", "tdd-discipline", "code-review", "refactoring", "git-workflow"]);
const CONTENT_DOMAINS = new Set(["docs", "media"]);
// Jobs that change money or identity flows: a derived skill for them must be written for the provider the project
// uses (a product stack such as Stripe), or carry the evidence a default pick needs (an agent payment protocol is a
// "payments" skill too, and has no place in a web shop).
export const SENSITIVE_JOBS = new Set(["payments-integration", "auth-implementation"]);
export function purposeFits(job, purpose, taxonomy) {
  if (purpose === "operations") return false;
  const domain = taxonomy.capabilities[job]?.domain;
  if (WORKFLOW_JOBS.has(job)) return purpose === "workflow" || purpose === "product";
  if (purpose === "content") return CONTENT_DOMAINS.has(domain);
  if (PRODUCT_DOMAINS.has(domain)) return purpose === "product";
  return true;
}
const SERIOUS_FLAG = /\b(malware|malicious|backdoor|steal|exfiltrat|scam|phishing|credential|crypto ?miner|trojan)\w*/i;

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 64).replace(/-+$/, "");
const DAY = 86400000;

// A summary an agent can be shown: the skill's own description, plain, short, with no command or link in it.
export function summaryOf(description) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  let s = text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1).replace(/\s+\S*$/, "")}…`;
  if (s.length > MAX_SUMMARY) s = `${s.slice(0, MAX_SUMMARY - 1)}…`;
  return unsafeSummary(s) ? null : s;
}

// The skills the decision model has answered about, with what the rules need to know, and where every skill in the
// store is held (by content and by name) for the copy rule. Read from the observe index: no SKILL.md is opened for a
// skill nobody asked about, which is nearly all of a large store.
function candidates(store, { taxonomy, model }) {
  const keyOf = jevKeyer(skillQuestions(taxonomy), model);
  const answered = store.listObs("jev");
  // Consensus fallback (Is 7): when the paid model has no answer, a 2/2 consensus observation may qualify.
  // The key prefix differs from "jev", so the two never mix; each record carries source: "consensus".
  const consensusOf = consensusKeyer();
  const consensusAnswered = store.listObs("consensus");
  // Approved consensus keys: an approval overrides the paid model (two independent readers said KEEP).
  const consensusApproved = new Set();
  for (const ck of consensusAnswered) {
    const co = store.getObs("consensus", ck);
    if (co && isApproved(co)) consensusApproved.add(ck);
  }
  const out = [];
  const repos = new Map();
  const byMd = new Map();
  const byName = new Map();
  const byPath = new Map();
  const keys = new Map();
  const push = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);
  let stored = 0;
  for (const name of store.listRepos()) {
    const full = store.getRepo(name);
    if (!full || full.error || !full.head) continue;
    const facts = repoFacts(store, name, full);
    // Only what the rules read: a large collection's full record is megabytes.
    const rec = { head: full.head, license: full.license ?? null, meta: full.meta ?? null, folders: facts.skills.length };
    rec.skillsRepo = isSkillsRepo(name, { topics: full.meta?.topics ?? [], files: full.files ?? null, skillFiles: (full.skills ?? []).reduce((n, s) => n + (s.files ?? 0), 0) });
    repos.set(name, rec);
    for (const s of facts.skills) {
      if (!s.skillMd) continue;
      stored++;
      const folder = s.path.split("/").pop() || name.split("/")[1];
      const holder = { repo: name, path: s.path, skillMd: s.skillMd, hidden: s.hidden };
      push(byMd, s.skillMd, holder);
      byPath.set(`${name}/${s.path}`, holder);
      for (const n of new Set([slug(folder), slug(s.name ?? "")])) if (n) push(byName, n, holder);
      // A text held by a thousand repositories is hashed once.
      const key = keys.get(s.skillMd) ?? keys.set(s.skillMd, keyOf(s.skillMd)).get(s.skillMd);
      const hasJev = answered.has(key);
      // An approved consensus observation overrides the paid model. Otherwise paid model first:
      // consensus only fills the gap when the paid model has no answer.
      const cKey = consensusOf(s.skillMd);
      const cApproved = cKey && consensusApproved.has(cKey);
      const useConsensus = cApproved || (!hasJev && cKey && consensusAnswered.has(cKey));
      if (!hasJev && !useConsensus) continue;
      out.push({ repo: name, rec, skill: s, fm: { name: s.name, description: s.description }, folder, key, consensusKey: useConsensus ? cKey : null });
    }
  }
  const reputations = new Map();
  const reputationOf = (repo) => {
    if (!reputations.has(repo)) reputations.set(repo, store.getObs("reputation", reputationKey(repo)));
    return reputations.get(repo);
  };
  const answers = new Map();
  for (const c of out) {
    if (c.consensusKey) {
      if (!answers.has(c.consensusKey)) answers.set(c.consensusKey, store.getObs("consensus", c.consensusKey));
      c.answers = answers.get(c.consensusKey);
    } else {
      if (!answers.has(c.key)) answers.set(c.key, store.getObs("jev", c.key));
      c.answers = answers.get(c.key);
    }
    c.reputation = reputationOf(c.repo);
  }
  return { all: out.filter((c) => c.answers && (!c.consensusKey || isApproved(c.answers))), stored, repos, byMd, byName, byPath, reputationOf };
}

// An MCP server is a tool for the agent whatever it reaches, so "the agent's own work" fits every job. One for
// running systems (a cluster, a cloud account) fits when it is for a product the project shows; content only fits
// documents and media.
export function serverPurposeFits(job, purpose, stack, taxonomy) {
  if (purpose === "operations") return taxonomy.stacks[stack]?.kind === "product";
  if (purpose === "content") return CONTENT_DOMAINS.has(taxonomy.capabilities[job]?.domain);
  return true;
}

// The rules skills and MCP servers both answer to: software work, one clear job the catalog serves, for what that
// job is for, and a product scope a project can show. The stack it is scoped to, or why it does not fit.
function judgeAnswers(a, taxonomy, { fits = (job, purpose) => purposeFits(job, purpose, taxonomy) } = {}) {
  if (a.coding < RULES.coding) return { why: [`not software work (coding ${a.coding})`] };
  const stack = a.stack && a.stack !== "any" && (a.stackP ?? 0) >= RULES.stack && taxonomy.stacks[a.stack] ? a.stack : null;
  // Only a product the fingerprint can find scopes a product-bound item: "Python" does not make an n8n skill general.
  if (a.productBound >= RULES.productBound && taxonomy.stacks[stack]?.kind !== "product") return { why: [`tied to one product (${a.productBound}) a project cannot show`] };
  if (a.job === "none" || (a.jobP ?? 0) < RULES.job || !taxonomy.capabilities[a.job]) return { why: [`main job unsure: ${a.job} (${a.jobP})`], review: true };
  if (OUT_OF_SCOPE.has(a.job)) return { why: [`${a.job}: not building software`] };
  if (OWN_JOBS.has(a.job)) return { why: [`${a.job}: a job Repotify's own hooks do`] };
  // Consensus did not ask purpose: unmeasured, not a failure. productBound uses the v2 verification
  // (Is 6, 98% accuracy), so the productBound rejection above applies to consensus answers too.
  if (a.source !== "consensus" && ((a.purposeP ?? 0) < 0.5 || !fits(a.job, a.purpose, stack))) return { why: [`purpose ${a.purpose} (${a.purposeP}) does not fit ${a.job}`], review: true };
  return { stack };
}

// Skills the second human review threw out (2026-10-04): repo and path, dropped whatever the rules say.
const DENYLIST = JSON.parse(readFileSync(new URL("./denylist.json", import.meta.url), "utf8"));

// The rules, one candidate at a time: the item it becomes, or why it does not.
// Content rules from the second human review (2026-10-04): the patterns behind the skills a person threw out,
// read straight from the SKILL.md, without downloading or asking anything. `text` is the SKILL.md's full text;
// `files` is the paths the skill's package holds, for the rule about references the package does not include.
export function contentVerdict(text, { files = [] } = {}) {
  const why = [];
  // Personal infrastructure: paths into one person's agent setup, not a product name merely mentioned in prose.
  if (/~\/.claude\/(LIFEOS|USER|MEMORY|CUSTOMIZATIONS)\b|LIFEOS\//i.test(text)) why.push("hardcoded personal infrastructure paths");
  if (/\bpassword\s*=\s*(rootroot|changeme|password123?|123456|admin123?|qwerty)\b/i.test(text)) why.push("hardcodes a weak password");
  if (/copied from @|copied from https?:\/\/github\.com/i.test(text)) why.push("admits it is copied from another repository");
  if (/(^|[^a-z0-9_\/])\/[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*/i.test(text)) why.push("invokes another product's namespaced command");
  // A reference the text says the agent must read, but the package does not hold.
  const missing = new Set();
  for (const m of text.matchAll(/references\/([A-Za-z0-9._-]+\.md)/gi)) {
    const ref = `references/${m[1]}`;
    const around = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 200);
    if (/not optional|must read|required|before (writing|proceeding|step)/i.test(around) && !files.some((f) => f.endsWith(ref))) missing.add(ref);
  }
  for (const ref of missing) why.push(`requires ${ref} which its package does not include`);
  // A body too thin to be the skill, pointing at a URL the agent must fetch: the content lives elsewhere.
  const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  // A body that is only a license text, not a skill. A real skill has sections; a license does not.
  // (Is 7 trial: two "skills" were only Apache/MIT license text.)
  if (/apache license[\s,]+version 2\.0|mit license\b|gnu general public license/i.test(body.slice(0, 2000)) && !/^##\s/m.test(body)) {
    why.push("its body is only a license text, not a skill");
  }
  if (body.length < 1000 && /https?:\/\//i.test(body) && /webfetch|\.fetch\(|curl /i.test(body)) why.push("its body is nearly empty; the content is fetched from a remote URL");
  // A fill-in template: many distinct natural-language bracketed placeholders, not a usable skill. Bracketed
  // link labels ([text](url)), quoted code keys (["key"]) and short tags ([optional]) are not placeholders.
  const placeholders = new Set();
  for (const m of text.matchAll(/\[([^\[\]\n]{20,80})\](?!\()/g)) {
    const inner = m[1];
    if (/^["'\s]/.test(inner)) continue;
    if (inner.split(/\s+/).length < 3) continue;
    placeholders.add(m[0]);
  }
  if (placeholders.size >= 10) why.push("a fill-in template with placeholders, not a usable skill");
  return why.length ? { why } : null;
}
function judge(c, { taxonomy, installsOf, outOfScopeRepo, store }) {
  const a = c.answers;
  const why = [];
  if (c.skill.hidden && !installsOf(c)) why.push("kept in the repository's own agent folder");
  if (!["verified", "caution"].includes(c.skill.scan)) why.push(`security ${c.skill.scan ?? "not scanned"}`);
  if (NOT_OFFERED.test(c.skill.path.split("/").slice(0, -1).join("/"))) why.push("kept with the repository's examples or its own tooling, not offered as a skill");
  if (REPUBLISHED.test(`${c.repo} ${c.rec.meta?.description ?? ""} ${(c.rec.meta?.topics ?? []).join(" ")}`)) why.push("its repository republishes prompts taken from other products");
  if (why.length) return { why };
  const description = String(c.fm.description ?? "");
  if (latinShare(description) < 0.9) return { why: ["its description is not in English"] };
  if (description.toLowerCase().includes(c.repo)) return { why: ["about its own repository"] };
  const fit = judgeAnswers(a, taxonomy);
  if (fit.why) return fit;
  const { stack } = fit;
  if (!c.rec.skillsRepo && taxonomy.stacks[stack]?.kind !== "product" && !installsOf(c)) return { why: ["kept inside another project's repository: written for that project"] };
  // (A product's own repository is the exception: Remotion's skills are about Remotion, the stack they are listed for.)
  if (namesOwnProject(c, description) && stack !== slug(c.repo.split("/")[1]) && !installsOf(c)) return { why: ["about its own project, which a repository cannot show"] };
  if (outOfScopeRepo(c.repo) && (a.purpose !== "product" || (a.purposeP ?? 0) < 0.9)) return { why: ["most of its repository is security operations or off-topic"] };
  // Consensus has no quality measurement: the gate is skipped, but consensus items never join a default set
  // (see defaultEligible below), so an unmeasured skill is listed as an alternate, not a pick.
  if (a.source !== "consensus" && (a.quality == null || a.quality < RULES.quality || (a.qualityConfidence ?? 0) < RULES.qualityConfidence)) return { why: [`quality ${a.quality} (confidence ${a.qualityConfidence})`] };
  // The content rules from the second review: read the SKILL.md itself (see contentVerdict). The tree is read only
  // when the text mentions references/, which is nearly never.
  const text = store.getBlob(c.skill.skillMd)?.toString("utf8") ?? "";
  const files = text.includes("references/") ? store.getTree(c.skill.tree).map((e) => e.path) : [];
  const content = contentVerdict(text, { files });
  if (content) return { why: content.why };
  const rep = c.reputation;
  if (rep?.needsReview) return { why: ["popular only by its stars: needs a human look"], review: true };
  const serious = (rep?.flags ?? []).filter((f) => SERIOUS_FLAG.test(f.text));
  if (serious.length >= 2) return { why: [`research flags: ${serious.slice(0, 2).map((f) => f.text).join("; ")}`], review: true };
  const summary = summaryOf(c.fm.description);
  if (!summary) return { why: ["no description a user can be shown"] };
  return { stack, summary };
}

export function deriveItems(store, { taxonomy, curated = [], leaderboard = [], now = new Date(), model = jevConfig().model } = {}) {
  const { all, stored, repos, byMd, byName, byPath, reputationOf } = candidates(store, { taxonomy, model });
  // Installs per skill on skills.sh, by repository and skill name.
  const installs = new Map(leaderboard.map((s) => [`${s.source}/${String(s.skill).toLowerCase()}`, s.installs]));
  const installsOf = (c) => installs.get(`${c.repo}/${c.folder.toLowerCase()}`) ?? installs.get(`${c.repo}/${String(c.fm.name ?? "").toLowerCase()}`) ?? null;
  // A repository whose skills are mostly off-topic or security operations: its other skills are suspect too, since one
  // misread job is enough to put a penetration test under "mobile testing".
  const profile = new Map();
  for (const c of all) {
    const p = profile.get(c.repo) ?? { n: 0, off: 0 };
    p.n++;
    if (c.answers.coding < RULES.coding || OUT_OF_SCOPE.has(c.answers.job) || c.answers.purpose === "operations") p.off++;
    profile.set(c.repo, p);
  }
  const outOfScopeRepo = (repo) => {
    const p = profile.get(repo);
    return Boolean(p && p.n >= 5 && p.off / p.n >= 0.5);
  };
  const used = new Set(curated.map((i) => i.id));
  const curatedPaths = new Set(curated.filter((i) => i.repo).map((i) => `${i.repo.toLowerCase()}/${i.path ?? ""}`));
  const items = [];
  const dropped = [];
  const whereOf = (c) => ({ repo: c.repo, path: c.skill.path, commit: c.rec.head });
  const drop = (c, reason, level = "declined") => dropped.push({ ...whereOf(c), id: slug(c.fm.name || c.folder), level, reason });

  // Each skill on its own: license, scan, the model's answers, the research.
  const passed = [];
  for (const c of all) {
    if (curatedPaths.has(`${c.repo}/${c.skill.path}`)) continue;
    const denied = DENYLIST.find((d) => d.repo.toLowerCase() === c.repo.toLowerCase() && (d.path == null || d.path === c.skill.path));
    if (denied) { drop(c, `denylist: ${denied.reason}`); continue; }
    c.license = c.rec.license && c.rec.license !== "NOASSERTION" ? c.rec.license : c.skill.license ?? null;
    const verdict = PERMISSIVE.has(c.license) ? judge(c, { taxonomy, installsOf, outOfScopeRepo, store }) : { why: [`license ${c.license ?? "unknown"}`] };
    if (verdict.why) drop(c, verdict.why.join("; "), verdict.review ? "review" : "declined");
    else passed.push(Object.assign(c, { verdict }));
  }

  // Copies (see copies.mjs). Where a holder of a skill stands as its likely origin:
  const flagged = (repo) => {
    const rep = reputationOf(repo);
    return Boolean(rep && (rep.inflated || rep.needsReview));
  };
  const standing = (h) => ({ repo: h.repo, path: h.path, hidden: h.hidden, curated: curatedPaths.has(`${h.repo}/${h.path}`), flagged: flagged(h.repo), large: (repos.get(h.repo)?.folders ?? 0) >= LARGE_COLLECTION, stars: repos.get(h.repo)?.meta?.stars ?? 0 });
  const sets = new Map();
  const shinglesOf = (skillMd) => {
    if (!sets.has(skillMd)) sets.set(skillMd, shingles(store.getBlob(skillMd)?.toString("utf8") ?? ""));
    return sets.get(skillMd);
  };
  // A hand-vetted item whose repository the store does not hold cannot be compared with: a skill of its name waits.
  const vettedSkills = curated.filter((i) => i.repo && (i.type === undefined || i.type === "skill"));
  const heldOf = (i) => byPath.get(`${i.repo.toLowerCase()}/${i.path ?? ""}`) ?? null;
  const textOf = (i) => store.getBlob(heldOf(i)?.skillMd ?? (i.files ?? []).find((f) => f.path === "SKILL.md")?.sha256 ?? "")?.toString("utf8") ?? null;
  // The names hand-vetted skills go by: the catalog lists one skill under a name.
  const vettedNames = new Map();
  for (const i of vettedSkills) for (const n of new Set([slug(i.id), slug(i.name ?? ""), slug((i.path ?? "").split("/").pop() ?? "")])) if (n) vettedNames.set(n, i);
  const copyOf = (c) => {
    const me = c.standing;
    // The same SKILL.md, byte for byte, held where it more likely comes from.
    const origin = byMd.get(c.skill.skillMd).map(standing).sort(compareRank)[0];
    if (origin.repo !== c.repo) return `copy of a skill in ${origin.repo}`;
    if (origin.path !== c.skill.path) return `the same skill as ${origin.path} in its repository`;
    // The same name and nearly the same text, held where it more likely comes from.
    const names = [...new Set([slug(c.folder), slug(c.fm.name ?? "")])].filter(Boolean);
    // Its better-placed holders first, one per distinct text.
    const seen = new Set([c.skill.skillMd]);
    const better = names.flatMap((n) => byName.get(n) ?? []).map((h) => ({ ...standing(h), skillMd: h.skillMd })).filter((h) => compareRank(h, me) < 0).sort(compareRank)
      .filter((h) => !seen.has(h.skillMd) && seen.add(h.skillMd)).slice(0, NAME_COMPARISONS);
    const mine = shinglesOf(c.skill.skillMd);
    // A repository waiting for a human look is not replaced by its mirrors: a skill it also carries waits with it,
    // when that repository would be the likelier origin but for its flag and nobody installs the skill from here.
    // (The other way round is common too: the waiting repository is the copier, and the author's skill stays.)
    const unflagged = (h) => ({ ...standing(h), flagged: false });
    const held = (h) => h.repo !== c.repo && Boolean(reputationOf(h.repo)?.needsReview) && compareRank(unflagged(h), { ...me, flagged: false }) < 0;
    const waiting = installsOf(c) ? null : byMd.get(c.skill.skillMd).find(held) ?? names.flatMap((n) => byName.get(n) ?? []).filter(held).slice(0, NAME_COMPARISONS).find((h) => isCopy(mine, shinglesOf(h.skillMd), { sameName: true }));
    if (waiting) return `also carried by ${waiting.repo}, which waits for a human look`;
    for (const h of better) if (isCopy(mine, shinglesOf(h.skillMd), { sameName: true })) return h.repo === c.repo ? `nearly the same skill as ${h.path} in its repository` : `near copy of a skill in ${h.repo}`;
    // A large collection's skill named like one a known source keeps: collections carry old revisions whose text has
    // drifted from the original (measured: a collection's mcp-builder shares 21% of its runs with the current one).
    // Elsewhere a name that is not a common word belongs to the best-placed known source that uses it: its namesakes
    // are most often the same skill before a rewrite (a known skill's earlier text shares 3% with its current one).
    const source = better.find((h) => h.repo !== c.repo && (h.curated || isOwnSource(h)));
    if (source && me.large) return `a collection's copy of ${names[0]}, which ${source.repo} keeps`;
    if (source && !names.every((n) => GENERIC_NAMES.has(n))) return `named like a skill ${source.repo} keeps`;
    // A translation, an old revision or a namesake of a hand-vetted skill: the name is taken.
    const vetted = names.map((n) => vettedNames.get(n)).find((i) => i && i.repo.toLowerCase() !== c.repo);
    if (vetted) return `takes the name of the hand-vetted ${vetted.id}`;
    return null;
  };
  // Then against what is already in: a hand-vetted item or a better-placed skill for the same job with nearly the same
  // text, whatever its name.
  const inJob = new Map();
  const jobOf = (job) => inJob.get(job) ?? inJob.set(job, []).get(job);
  for (const i of vettedSkills) {
    const text = textOf(i);
    if (text != null) for (const job of i.capabilities ?? []) jobOf(job).push({ id: i.id, set: shingles(text) });
  }
  const unique = [];
  for (const c of passed) c.standing = standing({ repo: c.repo, path: c.skill.path, hidden: c.skill.hidden });
  for (const c of passed.sort((x, y) => compareRank(x.standing, y.standing))) {
    let why = copyOf(c);
    if (!why) {
      const mine = shinglesOf(c.skill.skillMd);
      const twin = jobOf(c.answers.job).find((o) => isCopy(mine, o.set));
      if (twin) why = `nearly the same text as ${twin.id}`;
      else jobOf(c.answers.job).push({ id: `${c.repo}/${c.skill.path}`, set: mine });
    }
    if (why) drop(c, why, /waits for a human look/.test(why) ? "review" : "declined");
    else unique.push(c);
  }

  // The limits (SKILL_LIMITS): the skills with the most to show for themselves take the places.
  const taken = new Map();
  const finalists = [];
  const starsOf = (c) => c.rec.meta?.stars ?? 0;
  const merit = (x, y) => (installsOf(y) ?? 0) - (installsOf(x) ?? 0) || (y.answers.quality ?? 0) - (x.answers.quality ?? 0) || (y.answers.jobP ?? 0) - (x.answers.jobP ?? 0) || starsOf(y) - starsOf(x)
    || (x.repo < y.repo ? -1 : x.repo > y.repo ? 1 : 0) || (x.skill.path < y.skill.path ? -1 : 1);
  for (const c of [...unique].sort(merit)) {
    const job = c.answers.job;
    const keys = { perRepoJob: `${c.repo} ${job}`, perRepo: c.repo, perJob: `${job}/${c.verdict.stack ?? "*"}` };
    const full = Object.keys(keys).find((k) => (taken.get(`${k} ${keys[k]}`) ?? 0) >= SKILL_LIMITS[k]);
    if (full) {
      drop(c, full === "perRepoJob" ? `its repository already lists ${SKILL_LIMITS.perRepoJob} better skills for ${job}` : full === "perRepo" ? `its repository already lists its ${SKILL_LIMITS.perRepo} most used and best made skills` : `${SKILL_LIMITS.perJob} more used or better made skills already do ${job}`);
      continue;
    }
    for (const k of Object.keys(keys)) taken.set(`${k} ${keys[k]}`, (taken.get(`${k} ${keys[k]}`) ?? 0) + 1);
    finalists.push(c);
  }

  for (const c of finalists.sort((x, y) => (y.rec.meta?.stars ?? 0) - (x.rec.meta?.stars ?? 0) || (x.repo < y.repo ? -1 : 1) || (x.skill.path < y.skill.path ? -1 : 1))) {
    const { verdict } = c;
    const where = whereOf(c);
    let id = slug(c.fm.name || c.folder);
    if (!ID_RE.test(id) || used.has(id) || GENERIC_NAMES.has(id)) id = slug(`${c.repo.split("/")[0]}-${id}`);
    if (!ID_RE.test(id) || used.has(id)) {
      dropped.push({ ...where, id, level: "declined", reason: "no free id" });
      continue;
    }
    used.add(id);
    const a = c.answers;
    const job = a.job;
    const stacks = verdict.stack ? [verdict.stack] : ["*"];
    const specific = !stacks.includes("*");
    const tree = store.getTree(c.skill.tree);
    const scan = scanTree(store, c.skill.tree);
    const rep = c.reputation;
    const pushed = Date.parse(c.rec.meta?.pushedAt ?? "");
    const repoSkills = c.rec.folders;
    const itemInstalls = installsOf(c);
    const named = (rep?.bestSkills ?? []).some((n) => [c.folder, c.fm.name].filter(Boolean).some((x) => String(x).toLowerCase() === String(n).toLowerCase()));
    // A repository whose stars the research found inflated vouches for nothing: only installs count for its skills.
    const evidence = (itemInstalls ?? 0) >= DEFAULT_EVIDENCE.installs || ((rep?.score ?? 0) >= DEFAULT_EVIDENCE.reputation && !rep.inflated && named);
    // Consensus-sourced items stay out of default sets for now (Is 7): listed as alternates only, until a
    // larger measurement earns them the pick. The null quality already excludes them; this is explicit.
    const defaultEligible = c.answers.source !== "consensus" && evidence && a.quality >= DEFAULT_EVIDENCE.quality && (a.jobP ?? 0) >= DEFAULT_EVIDENCE.job;
    if (SENSITIVE_JOBS.has(a.job) && !defaultEligible && taxonomy.stacks[verdict.stack]?.kind !== "product") {
      dropped.push({ ...where, id, level: "review", reason: `${a.job} needs the project's provider or proven use` });
      used.delete(id);
      continue;
    }
    items.push({
      id, type: "skill", name: String(c.fm.name || c.folder).slice(0, 80), repo: c.repo, path: c.skill.path, commit: c.rec.head,
      files: tree.filter((e) => e.sha256).map((e) => ({ path: e.path, sha256: e.sha256 })),
      license: c.license, summary: verdict.summary,
      capabilities: [job], cluster: job, needs: needsFor(job, taxonomy), stacks,
      agents: ALL_AGENTS,
      tier: /-expertise$/.test(job) && specific ? "stack" : "mission",
      conflicts: [], descriptionChars: c.skill.descriptionChars ?? 0,
      ...((a.lifecycleP ?? 0) >= RULES.lifecycle ? { lifecycle: a.lifecycle } : {}),
      origin: "lab",
      quality: a.quality,
      jury: null,
      signals: {
        stars: c.rec.meta?.stars ?? null, starVelocity30d: null, coUsage: 0,
        lastCommitDays: Number.isFinite(pushed) ? Math.max(0, Math.floor((now - pushed) / DAY)) : null,
        mentions30d: 0, installs: itemInstalls, copies: new Set(byMd.get(c.skill.skillMd).map((h) => h.repo)).size - 1, repoSkills,
      },
      defaultEligible,
      // Which classifier put this item here: "consensus" for the reconciliation protocol, absent (jev) otherwise.
      ...(c.answers.source === "consensus" ? { classifiedBy: "consensus" } : {}),
      // Only serious flags travel with the item; "no description" and the like stay in the research record.
      ...(rep ? { reputation: { score: rep.score, inflated: rep.inflated, starTrust: rep.starTrust, flags: (rep.flags ?? []).filter((f) => SERIOUS_FLAG.test(f.text)).slice(0, 3).map((f) => f.text) } } : {}),
      community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
      security: { level: scan.level, findings: scan.findings, scannedAt: now.toISOString(), scannerVersion: SCANNER_VERSION, gateVersion: GATE_VERSION },
      badges: scan.level === "caution" ? ["caution"] : [],
      setup: null,
      derive: DERIVE_VERSION,
    });
  }
  return { items, dropped, considered: stored, classified: all.length };
}

// Repotify's own hooks (`builtin` entries in the seed) belong to every catalog: one the catalog does not hold yet
// joins it here, in the shape the full pipeline gives an editorial item, with its setup gated.
export async function builtinItems(seed, curated, { now = new Date() } = {}) {
  const have = new Set(curated.map((i) => i.id));
  const out = [];
  for (const src of (seed?.items ?? []).filter((s) => s.builtin && !have.has(s.id))) {
    out.push({
      conflicts: [], badges: [], jury: null, descriptionChars: 0,
      community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
      signals: { stars: null, starVelocity30d: null, lastCommitDays: null, coUsage: 0, mentions30d: 0 },
      ...src,
      cluster: src.cluster ?? src.capabilities[0],
      origin: "curated",
      security: await setupSecurity(src.setup, { now }),
    });
  }
  return out;
}

// The agents that run MCP servers, and what a server is taken to cost in context: the registry does not list a
// server's tools, so this is an estimate between the hand-vetted servers' measured 700 and 3,200 characters.
const MCP_AGENTS = ["claude-code", "cursor", "codex", "gemini-cli"];
export const MCP_CONTEXT_CHARS = 2000;
const packageOf = (spec) => String(spec ?? "").replace(/==.*$/, "").replace(/(.)@[^@/]*$/, "$1").toLowerCase();

// MCP servers: the registry's popular local servers (pipeline/mcp.mjs) under the same rules as skills, and five of
// their own. It must be used (MCP_LISTING). The package must start a server when run (a dedicated server, or a tool
// whose publisher says how), and an npm package must have a command. Its source must be on GitHub, not archived, and
// its gate clean or cautioned.
// Of the servers left, the catalog lists the most downloaded few for each job and stack, and a few from any one
// publisher. A default pick needs real use seen twice (DEFAULT_EVIDENCE.downloads a month and a starred repository),
// a sure job and a clean gate; a server that needs an account's secret key joins a default set only when it is for
// a product the project shows. The hand-vetted catalog keeps its own entry for a package.
export function deriveMcp(store, { taxonomy, curated = [], used = new Set(), now = new Date(), model = jevConfig().model } = {}) {
  const state = store.getState("mcp");
  const vetted = new Set(curated.flatMap((i) => [i.setup?.npm, i.setup?.pypi]).filter(Boolean).map(packageOf));
  const items = [];
  const dropped = [];
  const passed = [];
  for (const s of state?.servers ?? []) {
    if (vetted.has(s.package)) continue;
    const where = { registry: s.name, package: `${s.registry}:${s.package}` };
    const { security: sec, answers: a } = serverObservations(store, s, { taxonomy, model });
    const why = [];
    if (!s.repo) why.push("no source repository on GitHub");
    else if (s.archived) why.push("its repository is archived");
    if (s.downloads < MCP_LISTING.downloads || (s.stars ?? 0) < MCP_LISTING.stars) why.push(`too little use to list (${s.downloads} downloads a month, ${s.stars ?? "unknown"} stars)`);
    if (!startsServer(s)) why.push("a general tool: the registry does not say how to start its MCP server");
    if (sec?.runnable === false) why.push("its npm package has no command to run");
    if (!sec || !PUBLISHABLE_LEVELS.includes(sec.level)) why.push(`security ${sec?.level ?? "not gated"}`);
    if (!a) why.push("not classified yet");
    const fit = why.length ? { why } : judgeAnswers(a, taxonomy, { fits: (job, purpose, stack) => serverPurposeFits(job, purpose, stack, taxonomy) });
    const summary = fit.why ? null : summaryOf(s.description);
    if (fit.why || !summary) {
      dropped.push({ ...where, level: fit.review ? "review" : "declined", reason: (fit.why ?? ["no description a user can be shown"]).join("; ") });
      continue;
    }
    const product = taxonomy.stacks[fit.stack]?.kind === "product";
    if (SENSITIVE_JOBS.has(a.job) && !product) {
      dropped.push({ ...where, level: "review", reason: `${a.job} needs the project's provider` });
      continue;
    }
    const needsKey = s.env.some((e) => e.required && e.secret);
    const bar = fit.stack ? [DEFAULT_EVIDENCE.downloads, DEFAULT_EVIDENCE.stars] : [DEFAULT_EVIDENCE.anyStackDownloads, DEFAULT_EVIDENCE.anyStackStars];
    const evidence = s.downloads >= bar[0] && (s.stars ?? 0) >= bar[1];
    const defaultEligible = evidence && (a.jobP ?? 0) >= DEFAULT_EVIDENCE.job && sec.level === "verified" && (!needsKey || product);
    passed.push({ s, a, sec, fit, where, summary, defaultEligible });
  }
  // The most used first: they take the few places each job, stack and publisher has.
  const perJob = new Map();
  const perOwner = new Map();
  for (const c of passed.sort((x, y) => y.s.downloads - x.s.downloads || (x.s.package < y.s.package ? -1 : 1))) {
    const { s, a, sec, fit, where, summary, defaultEligible } = c;
    const group = `${a.job}/${fit.stack ?? "*"}`;
    const owner = s.repo.split("/")[0];
    if ((perJob.get(group) ?? 0) >= MCP_LIMITS.perJob) {
      dropped.push({ ...where, level: "declined", reason: `more used servers already do ${a.job}` });
      continue;
    }
    if ((perOwner.get(owner) ?? 0) >= MCP_LIMITS.perOwner) {
      dropped.push({ ...where, level: "declined", reason: "its publisher already has servers listed" });
      continue;
    }
    const base = slug(s.package.replace(/^@/, "").replace("/", "-"));
    const id = [base, slug(`${owner}-${base}`)].find((x) => ID_RE.test(x) && !used.has(x) && !GENERIC_NAMES.has(x));
    if (!id) {
      dropped.push({ ...where, level: "declined", reason: "no free id" });
      continue;
    }
    used.add(id);
    perJob.set(group, (perJob.get(group) ?? 0) + 1);
    perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
    items.push({
      id, type: "mcp", name: s.title.slice(0, 80), repo: s.repo, registry: s.name, summary,
      capabilities: [a.job], cluster: a.job, needs: needsFor(a.job, taxonomy), stacks: fit.stack ? [fit.stack] : ["*"],
      agents: MCP_AGENTS,
      tier: /-expertise$/.test(a.job) && fit.stack ? "stack" : "mission",
      conflicts: [], descriptionChars: MCP_CONTEXT_CHARS,
      origin: "lab",
      jury: null,
      signals: { stars: s.stars ?? null, starVelocity30d: null, coUsage: 0, lastCommitDays: null, mentions30d: 0, downloads: s.downloads },
      defaultEligible,
      community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
      security: { level: sec.level, findings: sec.findings, scannedAt: sec.scannedAt ?? now.toISOString(), scannerVersion: sec.scannerVersion ?? SCANNER_VERSION, gateVersion: sec.gateVersion ?? GATE_VERSION },
      badges: sec.level === "caution" ? ["caution"] : [],
      setup: mcpSetup(s),
      derive: DERIVE_VERSION,
    });
  }
  return { items, dropped, considered: state?.servers?.length ?? 0 };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = resolve(flag(args, "--out", join(root, "catalog")));
  const store = createStore(resolve(flag(args, "--store", "store")));
  const read = (f) => JSON.parse(readFileSync(join(out, f), "utf8"));
  const taxonomy = extendTaxonomyV2(extendTaxonomy(read("taxonomy.json")));
  const seed = JSON.parse(readFileSync(join(root, "pipeline", "seed-sources.json"), "utf8"));
  const vetted = read("items.json").filter((i) => i.origin !== "lab" || i.derive === undefined);
  const curated = [...vetted, ...(await builtinItems(seed, vetted))];
  // The core list follows the seed, for the items the catalog holds.
  const core = seed.core.filter((c) => curated.some((i) => i.id === c.id));
  const leaderboard = store.getState("skills-sh")?.skills ?? [];
  const skills = deriveItems(store, { taxonomy, curated, leaderboard });
  const servers = deriveMcp(store, { taxonomy, curated, used: new Set([...curated, ...skills.items].map((i) => i.id)) });
  const items = [...skills.items, ...servers.items];
  const dropped = [...skills.dropped, ...servers.dropped];
  const considered = skills.considered + servers.considered;
  const reasons = {};
  for (const d of dropped) {
    const key = d.reason.replace(/\(.*?\)|[\d.]+/g, "").replace(/: .*/, "").trim();
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  const all = [...curated, ...items];
  const errors = validateCatalog({ items: all, taxonomy, loadouts: read("loadouts.json"), core });
  const summary = { considered, classified: skills.classified, derived: items.length, servers: servers.items.length, curated: curated.length, total: all.length, dropped: dropped.length, reasons, errors: errors.slice(0, 5) };
  if (flag(args, "--report", null)) writeFileSync(flag(args, "--report"), JSON.stringify({ summary, items: items.map((i) => ({ id: i.id, type: i.type, repo: i.repo, path: i.path, job: i.capabilities[0], stacks: i.stacks, quality: i.quality, installs: i.signals.installs, downloads: i.signals.downloads, defaultEligible: i.defaultEligible })), dropped }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (errors.length) process.exitCode = 1;
  else if (!args.includes("--dry-run")) {
    const meta = writeCatalogFiles(out, { items: all, taxonomy, core });
    console.log(`catalog ${meta.version}: ${all.length} items`);
  }
}
