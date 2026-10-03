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
import { parseFrontmatter } from "../src/frontmatter.mjs";
import { ID_RE, MAX_SUMMARY, PUBLISHABLE_LEVELS, validateCatalog } from "../src/catalog.mjs";
import { SCANNER_VERSION } from "../src/scan/index.mjs";
import { jevConfig } from "../lib/signals/jev.mjs";
import { createStore, obsKey } from "./store.mjs";
import { scanTree, skillQuestions } from "./observe.mjs";
import { licenseFromText } from "./collect.mjs";
import { extendTaxonomy, needsFor } from "./jev-classify.mjs";
import { extendTaxonomyV2 } from "./taxonomy.mjs";
import { unsafeSummary } from "./run.mjs";
import { GATE_VERSION, setupSecurity } from "./gate.mjs";
import { reputationKey } from "./research.mjs";
import { writeCatalogFiles } from "./publish.mjs";
import { serverObservations, mcpSetup, startsServer } from "./mcp.mjs";
import { flag } from "./lib/cli.mjs";

// Bump when a rule changes; every derived item records it.
export const DERIVE_VERSION = "1";

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

// The license of one skill folder: the repository's, or a license file inside the folder.
function skillLicense(store, rec, tree) {
  if (rec.license && rec.license !== "NOASSERTION") return rec.license;
  const file = (store.getTree(tree) ?? []).find((e) => e.sha256 && /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i.test(e.path));
  return file ? licenseFromText(store.getBlob(file.sha256)?.toString("utf8") ?? "") : null;
}

// A summary an agent can be shown: the skill's own description, plain, short, with no command or link in it.
export function summaryOf(description) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  let s = text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1).replace(/\s+\S*$/, "")}…`;
  if (s.length > MAX_SUMMARY) s = `${s.slice(0, MAX_SUMMARY - 1)}…`;
  return unsafeSummary(s) ? null : s;
}

// Every stored skill with what the rules need to know about it.
function candidates(store, { taxonomy, model }) {
  const questions = skillQuestions(taxonomy);
  const out = [];
  for (const name of store.listRepos()) {
    const rec = store.getRepo(name);
    if (!rec || rec.error || !rec.head) continue;
    for (const s of rec.skills ?? []) {
      if (!s.tree || !s.skillMd) continue;
      const md = store.getBlob(s.skillMd)?.toString("utf8") ?? "";
      const fm = parseFrontmatter(md);
      out.push({
        repo: name, rec, skill: s, fm, folder: s.path.split("/").pop() || name.split("/")[1],
        scan: scanTree(store, s.tree),
        answers: store.getObs("jev", obsKey("jev", s.skillMd, questions, model)),
        reputation: store.getObs("reputation", reputationKey(name)),
      });
    }
  }
  return out;
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
  if ((a.purposeP ?? 0) < 0.5 || !fits(a.job, a.purpose, stack)) return { why: [`purpose ${a.purpose} (${a.purposeP}) does not fit ${a.job}`], review: true };
  return { stack };
}

// The rules, one candidate at a time: the item it becomes, or why it does not.
function judge(c, { taxonomy, installsOf, originalOf, outOfScopeRepo }) {
  const a = c.answers;
  const why = [];
  if (c.skill.hidden && !installsOf(c)) why.push("kept in the repository's own agent folder");
  if (!c.scan || !["verified", "caution"].includes(c.scan.level)) why.push(`security ${c.scan?.level ?? "not scanned"}`);
  if (!a) why.push("not classified yet");
  if (why.length) return { why };
  const original = originalOf(c);
  if (original !== c.repo) return { why: [`copy of a skill in ${original}`] };
  const fit = judgeAnswers(a, taxonomy);
  if (fit.why) return fit;
  const { stack } = fit;
  if (outOfScopeRepo(c.repo) && (a.purpose !== "product" || (a.purposeP ?? 0) < 0.9)) return { why: ["most of its repository is security operations or off-topic"] };
  if (a.quality == null || a.quality < RULES.quality || (a.qualityConfidence ?? 0) < RULES.qualityConfidence) return { why: [`quality ${a.quality} (confidence ${a.qualityConfidence})`] };
  const rep = c.reputation;
  if (rep?.needsReview) return { why: ["popular only by its stars: needs a human look"], review: true };
  const serious = (rep?.flags ?? []).filter((f) => SERIOUS_FLAG.test(f.text));
  if (serious.length >= 2) return { why: [`research flags: ${serious.slice(0, 2).map((f) => f.text).join("; ")}`], review: true };
  const summary = summaryOf(c.fm.description);
  if (!summary) return { why: ["no description a user can be shown"] };
  return { stack, summary };
}

export function deriveItems(store, { taxonomy, curated = [], leaderboard = [], now = new Date(), model = jevConfig().model } = {}) {
  const all = candidates(store, { taxonomy, model });
  // Installs per skill on skills.sh, by repository and skill name.
  const installs = new Map(leaderboard.map((s) => [`${s.source}/${String(s.skill).toLowerCase()}`, s.installs]));
  const installsOf = (c) => installs.get(`${c.repo}/${c.folder.toLowerCase()}`) ?? installs.get(`${c.repo}/${String(c.fm.name ?? "").toLowerCase()}`) ?? null;
  // A skill held by several repositories belongs to the oldest of them.
  const holders = new Map();
  for (const c of all) (holders.get(c.skill.skillMd) ?? holders.set(c.skill.skillMd, []).get(c.skill.skillMd)).push(c);
  const created = (c) => Date.parse(c.rec.meta?.createdAt ?? "") || Infinity;
  const originalOf = (c) => {
    const hs = holders.get(c.skill.skillMd);
    return hs.length < 2 ? c.repo : [...hs].sort((x, y) => created(x) - created(y) || (y.rec.meta?.stars ?? 0) - (x.rec.meta?.stars ?? 0) || (x.repo < y.repo ? -1 : 1))[0].repo;
  };
  // A repository whose skills are mostly off-topic or security operations: its other skills are suspect too, since one
  // misread job is enough to put a penetration test under "mobile testing".
  const profile = new Map();
  for (const c of all) {
    if (!c.answers) continue;
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
  for (const c of all.sort((x, y) => (y.rec.meta?.stars ?? 0) - (x.rec.meta?.stars ?? 0) || (x.repo < y.repo ? -1 : 1) || (x.skill.path < y.skill.path ? -1 : 1))) {
    if (curatedPaths.has(`${c.repo}/${c.skill.path}`)) continue;
    const license = skillLicense(store, c.rec, c.skill.tree);
    const verdict = PERMISSIVE.has(license) ? judge(c, { taxonomy, installsOf, originalOf, outOfScopeRepo }) : { why: [`license ${license ?? "unknown"}`] };
    const where = { repo: c.repo, path: c.skill.path, commit: c.rec.head };
    if (verdict.why) {
      dropped.push({ ...where, id: slug(c.fm.name || c.folder), level: verdict.review ? "review" : "declined", reason: verdict.why.join("; ") });
      continue;
    }
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
    const rep = c.reputation;
    const pushed = Date.parse(c.rec.meta?.pushedAt ?? "");
    const repoSkills = (c.rec.skills ?? []).filter((x) => x.tree).length;
    const itemInstalls = installsOf(c);
    const named = (rep?.bestSkills ?? []).some((n) => [c.folder, c.fm.name].filter(Boolean).some((x) => String(x).toLowerCase() === String(n).toLowerCase()));
    const evidence = (itemInstalls ?? 0) >= DEFAULT_EVIDENCE.installs || ((rep?.score ?? 0) >= DEFAULT_EVIDENCE.reputation && named);
    const defaultEligible = evidence && a.quality >= DEFAULT_EVIDENCE.quality && (a.jobP ?? 0) >= DEFAULT_EVIDENCE.job;
    if (SENSITIVE_JOBS.has(a.job) && !defaultEligible && taxonomy.stacks[verdict.stack]?.kind !== "product") {
      dropped.push({ ...where, id, level: "review", reason: `${a.job} needs the project's provider or proven use` });
      used.delete(id);
      continue;
    }
    items.push({
      id, type: "skill", name: String(c.fm.name || c.folder).slice(0, 80), repo: c.repo, path: c.skill.path, commit: c.rec.head,
      files: tree.filter((e) => e.sha256).map((e) => ({ path: e.path, sha256: e.sha256 })),
      license, summary: verdict.summary,
      capabilities: [job], cluster: job, needs: needsFor(job, taxonomy), stacks,
      agents: ALL_AGENTS,
      tier: /-expertise$/.test(job) && specific ? "stack" : "mission",
      conflicts: [], descriptionChars: String(c.fm.description ?? "").length,
      ...((a.lifecycleP ?? 0) >= RULES.lifecycle ? { lifecycle: a.lifecycle } : {}),
      origin: "lab",
      quality: a.quality,
      jury: null,
      signals: {
        stars: c.rec.meta?.stars ?? null, starVelocity30d: null, coUsage: 0,
        lastCommitDays: Number.isFinite(pushed) ? Math.max(0, Math.floor((now - pushed) / DAY)) : null,
        mentions30d: 0, installs: itemInstalls, copies: holders.get(c.skill.skillMd).length - 1, repoSkills,
      },
      defaultEligible,
      // Only serious flags travel with the item; "no description" and the like stay in the research record.
      ...(rep ? { reputation: { score: rep.score, inflated: rep.inflated, starTrust: rep.starTrust, flags: (rep.flags ?? []).filter((f) => SERIOUS_FLAG.test(f.text)).slice(0, 3).map((f) => f.text) } } : {}),
      community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
      security: { level: c.scan.level, findings: c.scan.findings, scannedAt: now.toISOString(), scannerVersion: SCANNER_VERSION, gateVersion: GATE_VERSION },
      badges: c.scan.level === "caution" ? ["caution"] : [],
      setup: null,
      derive: DERIVE_VERSION,
    });
  }
  return { items, dropped, considered: all.length };
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
      security: { level: sec.level, findings: sec.findings, scannedAt: sec.scannedAt ?? now.toISOString(), scannerVersion: SCANNER_VERSION, gateVersion: GATE_VERSION },
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
  const summary = { considered, derived: items.length, servers: servers.items.length, curated: curated.length, total: all.length, dropped: dropped.length, reasons, errors: errors.slice(0, 5) };
  if (flag(args, "--report", null)) writeFileSync(flag(args, "--report"), JSON.stringify({ summary, items: items.map((i) => ({ id: i.id, type: i.type, repo: i.repo, path: i.path, job: i.capabilities[0], stacks: i.stacks, quality: i.quality, installs: i.signals.installs, downloads: i.signals.downloads, defaultEligible: i.defaultEligible })), dropped }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (errors.length) process.exitCode = 1;
  else if (!args.includes("--dry-run")) {
    const meta = writeCatalogFiles(out, { items: all, taxonomy, core });
    console.log(`catalog ${meta.version}: ${all.length} items`);
  }
}
