#!/usr/bin/env node
// Nightly pipeline: discover → collect → gate → jury → graph → loadouts → community → publish.
// Usage: node pipeline/run.mjs [--out catalog] [--work pipeline/work] [--sources seed,awesome,hn,reddit,github-topics]
//        [--limit 40] [--no-jury] [--cache pipeline/cache/jury.json] [--reviewed pipeline/reviewed.json]
import { isMain } from "../src/util.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanFiles } from "../src/scan/index.mjs";
import { checkTyposquat } from "../src/scan/typosquat.mjs";
import { levelFromFindings, scanFiles as scanText } from "../src/scan/index.mjs";
import { ID_RE } from "../src/catalog.mjs";
import { collectRepo, runGit } from "./collect.mjs";
import { setupSecurity, securityRecord } from "./gate.mjs";
import { selectWorkingJurors, probeWith, judgeItem, applySuspicion, MAX_CONTENT_CHARS } from "./jury.mjs";
import { buildGraph } from "./graph.mjs";
import { buildLoadouts } from "./loadouts.mjs";
import { publishCatalog } from "./publish.mjs";
import { discover } from "./discover.mjs";
import { providersFromEnv } from "./providers/index.mjs";

const DAY = 86400000;
const ALL_AGENTS = ["claude-code", "cursor", "codex", "gemini-cli", "generic"];
const MAX_SKILLS_PER_REPO = 30;
// R6: automatically discovered items must clearly earn their place; editorial items are exempt.
export const QUALITY_BAR = { quality: 0.7, agreement: 0.6 };

// Names too generic to identify a skill on their own; discovered ones get the owner as prefix.
const GENERIC_NAMES = new Set(["api", "setup", "overview", "docs", "documentation", "performance", "debugging", "testing", "tests", "architecture", "helper", "utils", "tools", "skill", "guide", "readme", "config", "deploy", "review", "code-review", "security", "frontend", "backend", "database", "git", "ci", "cd", "ci-cd", "write-tests", "browser-automation", "data-analysis"]);
const DUPLICATE = "duplicate";

// Jury summaries come from a model that read untrusted text; they are shown to users' agents, so they
// must be plain prose: no URLs, code, shell syntax or anything the scanner would flag.
// Summaries are shown verbatim to the user's agent, so they may describe the item but never address the agent,
// name a host or carry command syntax.
const SUMMARY_CODE_RE = /https?:\/\/|www\.|`|\$\(|[<>{}]|&&|\|\||(^|\s)--?[a-z][\w-]*/i;
const SUMMARY_HOST_RE = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(sh|io|com|net|org|dev|app|xyz|ru|cn|site|top|me|co|ai|cc|tk|biz|info|online|link|click)\b(\/\S*)?/i;
const SUMMARY_ADDRESS_RE = /\b(ignore|disregard|as root|sudo|run it|execute it|download (and|then)|skip (the )?(user|prompt|confirmation|consent|review)|without (asking|telling)|note (to|for) (the )?(agent|ai|assistant|model|reviewer)|the (agent|assistant) (must|should)|always (install|run|use|accept|approve)|accept-caution|rate it|score it)\b/i;

export function unsafeSummary(summary) {
  if (SUMMARY_CODE_RE.test(summary)) return "contains code, flags or links";
  if (SUMMARY_HOST_RE.test(summary)) return "names a host";
  if (SUMMARY_ADDRESS_RE.test(summary)) return "addresses the agent";
  const r = scanText([{ path: "summary.md", content: summary }]);
  return r.level === "verified" ? null : `scanner: ${r.findings[0]?.rule}`;
}

function denied(item, denylist) {
  return denylist.find((d) => d.repo?.toLowerCase() === item.repo?.toLowerCase() && (d.path == null || d.path === item.path) && (d.commit == null || d.commit === item.commit));
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function juryText(tree) {
  const docs = tree.filter((f) => !f.isSymlink && /\.(md|txt)$/i.test(f.path));
  docs.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : 1));
  let text = "";
  for (const f of docs) {
    if (text.length >= MAX_CONTENT_CHARS) break;
    text += `\n--- ${f.path} ---\n${f.content.toString("utf8")}`;
  }
  return text.slice(0, MAX_CONTENT_CHARS);
}

// Human review list: a reviewer can approve one exact commit of a quarantined item. Rejected (critical) items stay
// out, and clients accept the approval only for the findings recorded here.
function applyReview(item, reviewed) {
  if (item.security.level !== "quarantined") return item;
  const r = reviewed.find((x) => x.repo === item.repo && x.commit === item.commit && (x.path ?? "") === (item.path ?? "") && ["verified", "caution"].includes(x.level));
  if (!r) return item;
  return { ...item, security: { ...item.security, level: r.level, review: { reviewer: r.reviewer, note: r.note ?? "" } } };
}

const dropReason = (item) => {
  const top = item.security.findings.find((f) => f.severity === "critical" || f.severity === "high");
  return top ? `${top.rule}: ${top.file}:${top.line} ${top.note ?? ""} ${top.excerpt}`.replace(/\s+/g, " ").trim() : "";
};

export async function runPipeline(opts) {
  const {
    seed, taxonomy, outDir, workDir, now = new Date(), discovered = [], urlFor, git = runGit,
    providers = {}, juryCache = {}, probe, fetchImpl = fetch, noJury = false, reviewed = [], community = null,
    concurrency = 1, denylist = [], freshClones = true, log = () => {},
  } = opts;
  const stats = { repos: 0, candidates: 0, errors: [], jurors: 0 };
  // Names new items must not imitate. A caller that passes an empty seed (to skip re-collecting it) passes them here.
  const known = opts.known ?? seed.items.map((i) => ({ id: i.id, name: i.name, repo: i.repo, stars: Infinity }));
  const discoveredMeta = new Map(discovered.map((d) => [d.repo, d]));
  const candidates = [];

  // Collect: seed repos (only the curated paths) and discovered repos (every skill folder).
  const seedByRepo = new Map();
  for (const src of seed.items) {
    if (src.type !== "skill" && src.type !== "plugin") continue;
    if (!seedByRepo.has(src.repo)) seedByRepo.set(src.repo, []);
    seedByRepo.get(src.repo).push(src);
  }
  const repos = [...seedByRepo.keys(), ...discovered.map((d) => d.repo).filter((r) => !seedByRepo.has(r) && ![...seedByRepo.keys()].some((k) => k.toLowerCase() === r))];
  const usedIds = new Set(seed.items.map((i) => i.id));
  const seenHashes = new Map();
  const declined = [];
  for (const repo of repos) {
    const srcs = seedByRepo.get(repo);
    let collected;
    try {
      collected = await collectRepo(repo, { workDir, git, urlFor, fresh: freshClones, paths: srcs ? srcs.map((s) => s.path ?? "") : null, meta: discoveredMeta.get(repo)?.meta });
    } catch (error) {
      stats.errors.push({ repo, message: String(error.message).split("\n")[0] });
      log(`collect failed: ${repo}`);
      continue;
    }
    stats.repos++;
    log(`collected ${repo} @ ${collected.commit.slice(0, 8)} (${collected.skills.length} skill folder(s))`);
    if (srcs) for (const h of collected.skillHashes) if (!seenHashes.has(h.sha256)) seenHashes.set(h.sha256, `${repo}/${h.path || "."}`);
    for (const s of collected.skipped ?? []) declined.push({ id: slug(s.path.split("/").pop() || repo.split("/")[1]), repo, commit: collected.commit, path: s.path, level: "declined", reason: s.reason });
    const meta = discoveredMeta.get(repo);
    const signals = {
      stars: collected.meta.stars,
      starVelocity30d: null,
      lastCommitDays: Math.max(0, Math.floor((now - new Date(collected.committedAt)) / DAY)),
      coUsage: 0,
      mentions30d: meta?.mentions30d ?? 0,
    };
    for (const snap of collected.skills.slice(0, opts.maxSkillsPerRepo ?? MAX_SKILLS_PER_REPO)) {
      const src = srcs?.find((s) => (s.path ?? "") === snap.path);
      let id = src?.id;
      if (!id) {
        id = slug(snap.frontmatter.name || snap.path.split("/").pop() || repo.split("/")[1]);
        if (usedIds.has(id) || GENERIC_NAMES.has(id)) id = slug(`${repo.split("/")[0]}-${id}`);
        const skillHash = snap.files.find((f) => f.path === "SKILL.md")?.sha256;
        const decline = (reason) => declined.push({ id, repo, commit: collected.commit, path: snap.path, level: "declined", reason });
        if (skillHash && seenHashes.has(skillHash)) {
          decline(`${DUPLICATE} of ${seenHashes.get(skillHash)}`);
          continue;
        }
        if (skillHash) seenHashes.set(skillHash, `${repo}/${snap.path || "."}`);
        if (!collected.meta.license || collected.meta.license === "NOASSERTION") {
          decline(`no recognizable license (${collected.meta.license ?? "none"})`);
          continue;
        }
        if (!ID_RE.test(id) || usedIds.has(id)) continue;
      }
      usedIds.add(id);
      const scan = scanFiles(snap.tree);
      const findings = [...scan.findings];
      if (!src) {
        const t = checkTyposquat({ id, name: snap.frontmatter.name, repo, createdAt: collected.meta.createdAt }, known, now);
        if (t) findings.push(t);
      }
      candidates.push({
        editorial: Boolean(src),
        text: juryText(snap.tree),
        item: {
          id,
          type: src?.type ?? "skill",
          name: src?.name ?? snap.frontmatter.name ?? id,
          repo,
          path: snap.path,
          commit: collected.commit,
          files: snap.files.map(({ path, sha256 }) => ({ path, sha256 })),
          license: src?.license ?? collected.meta.license ?? "unknown",
          summary: src?.summary ?? String(snap.frontmatter.description ?? "").slice(0, 140),
          capabilities: src?.capabilities ?? [],
          needs: src?.needs ?? [],
          stacks: src?.stacks ?? ["*"],
          agents: src?.agents ?? ALL_AGENTS,
          tier: src?.tier ?? "mission",
          cluster: src?.cluster,
          conflicts: src?.conflicts ?? [],
          descriptionChars: snap.descriptionChars,
          signals,
          jury: null,
          community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
          security: securityRecord({ level: levelFromFindings(findings), findings }, now),
          badges: [],
          setup: null,
        },
      });
    }
  }

  // Non-repository items (tools, MCP servers, config) keep editorial metadata; their setup is gated.
  for (const src of seed.items.filter((s) => s.type !== "skill" && s.type !== "plugin")) {
    const { setup, ...rest } = src;
    candidates.push({
      editorial: true,
      text: null,
      item: {
        conflicts: [], badges: [], jury: null, descriptionChars: 0,
        community: { shown: 0, selected: 0, kept7d: 0, removed: 0, rating: 0, votes: 0 },
        signals: { stars: null, starVelocity30d: null, lastCommitDays: null, coUsage: 0, mentions30d: 0 },
        ...rest,
        setup,
        security: await setupSecurity(setup, { fetchImpl, now }),
      },
    });
  }
  stats.candidates = candidates.length;

  // Jury (never for blocked items: no tokens spent on them).
  let jurors = [];
  if (!noJury && Object.keys(providers).length) {
    jurors = opts.jurors ?? (await selectWorkingJurors({ providers, n: 3, probe: probe ?? probeWith(providers) }));
  }
  stats.jurors = jurors.length;
  // Denylisted items go to the review queue whatever the scanner said (fast quarantine after a report).
  for (const c of candidates) {
    const d = denied(c.item, denylist);
    if (d) {
      const finding = { rule: "denylist", severity: "high", file: "(denylist)", line: 0, excerpt: String(d.reason ?? "reported").slice(0, 80) };
      c.item.security = { ...c.item.security, level: "quarantined", findings: [finding, ...(c.item.security.findings ?? [])] };
    }
  }

  // Judge eligible candidates with a small worker pool; results keep candidate order.
  const reviewedItems = candidates.map((c) => (denied(c.item, denylist) ? c.item : applyReview(c.item, reviewed)));
  const juries = new Array(candidates.length).fill(null);
  const eligible = candidates
    .map((c, i) => i)
    .filter((i) => candidates[i].text && jurors.length && !["rejected", "quarantined"].includes(reviewedItems[i].security.level));
  let cursor = 0;
  async function worker() {
    while (cursor < eligible.length) {
      const i = eligible[cursor++];
      const item = reviewedItems[i];
      juries[i] = await judgeItem(item, candidates[i].text, { jurors, providers, cache: juryCache, taxonomy, log });
      log(`judged ${item.id}: ${juries[i] ? `${juries[i].models.length} juror(s), quality ${juries[i].quality.toFixed(2)}` : "no verdict"}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const kept = [];
  const dropped = [...declined];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let item = reviewedItems[i];
    const jury = juries[i];
    if (jury) {
      item.jury = { quality: jury.quality, specificity: jury.specificity, maintenance: jury.maintenance, agreement: jury.agreement, models: jury.models };
      item.security = applySuspicion(item.security, jury);
      if (!c.editorial) {
        item = {
          ...item,
          summary: jury.summary,
          capabilities: jury.capabilities,
          needs: jury.needs,
          stacks: jury.stacks.length ? jury.stacks : ["*"],
          tier: jury.tier === "stack" && jury.stacks.length && !jury.stacks.includes("*") ? "stack" : "mission",
        };
      }
    }
    if (item.security.level === "rejected" || item.security.level === "quarantined") {
      dropped.push({ id: item.id, repo: item.repo ?? null, commit: item.commit ?? null, path: item.path ?? null, level: item.security.level, reason: dropReason(item) });
      continue;
    }
    const summaryProblem = !c.editorial && jury ? unsafeSummary(item.summary) : null;
    if (summaryProblem) {
      dropped.push({ id: item.id, repo: item.repo ?? null, commit: item.commit ?? null, path: item.path ?? null, level: "declined", reason: `unsafe summary (${summaryProblem})` });
      continue;
    }
    if (!c.editorial && jury && (jury.quality < QUALITY_BAR.quality || jury.agreement < QUALITY_BAR.agreement)) {
      dropped.push({ id: item.id, repo: item.repo ?? null, commit: item.commit ?? null, path: item.path ?? null, level: "declined", reason: `jury quality ${jury.quality.toFixed(2)}, agreement ${jury.agreement.toFixed(2)} (bar ${QUALITY_BAR.quality}/${QUALITY_BAR.agreement})` });
      continue;
    }
    if (!item.capabilities.length || !item.summary) {
      dropped.push({ id: item.id, repo: item.repo ?? null, commit: item.commit ?? null, path: item.path ?? null, level: "unclassified", reason: jurors.length ? "jury could not classify it" : "no jury available" });
      continue;
    }
    if (item.security.level === "caution" && !item.badges.includes("caution")) item.badges = [...item.badges, "caution"];
    for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
    kept.push(item);
  }

  let items = buildGraph(kept, taxonomy);
  if (community) items = community(items);
  const ids = new Set(items.map((i) => i.id));
  const loadouts = buildLoadouts(seed.loadouts ?? [], items);
  const core = (seed.core ?? []).filter((c) => ids.has(c.id));
  const meta = publishCatalog(
    {
      items, taxonomy, loadouts, core,
      reviewQueue: dropped.filter((d) => d.level === "quarantined"),
      rejected: dropped.filter((d) => d.level !== "quarantined"),
    },
    outDir,
    { now },
  );
  return { items, dropped, meta, stats, juryCache };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const here = fileURLToPath(new URL(".", import.meta.url));
  const outDir = resolve(opt("--out", join(here, "..", "catalog")));
  const workDir = resolve(opt("--work", join(here, "work", "repos")));
  const cachePath = resolve(opt("--cache", join(here, "cache", "jury.json")));
  const reviewedPath = resolve(opt("--reviewed", join(here, "reviewed.json")));
  const sources = opt("--sources", "seed,awesome,hn,reddit,github-topics,github-code,submissions").split(",");
  const limit = Number(opt("--limit", "40"));
  const seed = JSON.parse(readFileSync(join(here, "seed-sources.json"), "utf8"));
  const taxonomy = JSON.parse(readFileSync(join(outDir, "taxonomy.json"), "utf8"));
  const juryCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const reviewed = existsSync(reviewedPath) ? JSON.parse(readFileSync(reviewedPath, "utf8")) : [];
  const denylistPath = join(here, "denylist.json");
  const denylist = existsSync(denylistPath) ? JSON.parse(readFileSync(denylistPath, "utf8")) : [];
  const log = (m) => console.error(m);
  const t0 = Date.now();
  const found = await discover({ sources: sources.filter((s) => s !== "seed"), githubToken: process.env.GITHUB_TOKEN, submissionsRepo: process.env.REPOTIFY_SUBMISSIONS_REPO });
  for (const e of found.errors) log(`discover ${e.source}: ${e.message}`);
  const discovered = found.candidates.sort((a, b) => b.mentions30d + (b.meta?.stars ?? 0) / 1000 - (a.mentions30d + (a.meta?.stars ?? 0) / 1000)).slice(0, limit);
  const providers = Object.fromEntries(providersFromEnv(process.env).map((p) => [p.name, p]));
  let community = null;
  if (process.env.REPOTIFY_STATS_URL) {
    const { fetchCommunity, mergeCommunity } = await import("./community.mjs");
    const statsDoc = await fetchCommunity({ url: process.env.REPOTIFY_STATS_URL });
    if (statsDoc) community = (items) => mergeCommunity(items, statsDoc);
  }
  const result = await runPipeline({
    seed, taxonomy, outDir, workDir, discovered, providers, juryCache, reviewed, community, denylist,
    concurrency: Number(opt("--concurrency", "3")), noJury: args.includes("--no-jury"), log,
  });
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(result.juryCache));
  const summary = {
    catalogVersion: result.meta.version,
    items: result.items.length,
    dropped: result.dropped.length,
    repos: result.stats.repos,
    discovered: found.candidates.length,
    jurors: result.stats.jurors,
    errors: result.stats.errors.length + found.errors.length,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  console.log(JSON.stringify(summary));
}
