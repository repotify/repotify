#!/usr/bin/env node
// The crawler: finds repositories with agent skills on GitHub, the most popular first, and keeps their skill folders in
// the content store (pipeline/store.mjs). Only what the store lacks is downloaded: a blobless clone lists every file
// with its git id, and a sparse checkout fetches the missing skill folders in one batch. A repository whose last push
// is unchanged is not fetched again. Judging what was found (scanner, classifier, catalog rules) happens later,
// offline, from the store.
//   GITHUB_TOKEN=… node pipeline/crawl.mjs --store DIR [--max-repos 500] [--concurrency 6] [--min-stars 10]
//                                          [--discover] [--only owner/name,…]
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isMain } from "../src/util.mjs";
import { createStore, gitBlobId } from "./store.mjs";
import { githubClient, repoMeta } from "./github.mjs";
import { reposFromText } from "./discover.mjs";
import { licenseFromText } from "./collect.mjs";
import { fetchWithRetry } from "./lib/http.mjs";
import { flag, logStamped } from "./lib/cli.mjs";

const execFile = promisify(execFileCb);

// Folders that hold other projects' copies, tests or build output, never a repository's own skills.
const SKIP_DIRS = new Set(["node_modules", ".git", "test", "tests", "fixtures", "__fixtures__", "testdata", "evals", "evals-extra", "vendor", "dist", "build", ".venv", "venv"]);
export const LIMITS = Object.freeze({ maxFiles: 400, maxBytes: 30 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// Git, without a shell: every argument is passed as is.

export async function runGit(args, { cwd, input, timeout = 180000, maxBuffer = 512 * 1024 * 1024 } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  if (input === undefined) {
    const { stdout } = await execFile("git", args, { cwd, timeout, maxBuffer, env, encoding: "buffer" });
    return stdout;
  }
  return new Promise((resolvePromise, reject) => {
    const child = execFileCb("git", args, { cwd, timeout, maxBuffer, env, encoding: "buffer" }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
    child.stdin.end(input);
  });
}

// `git ls-tree -r -l -z` output: one entry per file with its mode, git id, size and path.
export function parseLsTree(buf) {
  const out = [];
  for (const rec of buf.toString("utf8").split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, type, oid, size] = rec.slice(0, tab).split(/\s+/);
    out.push({ mode, type, oid, size: size === "-" ? 0 : Number(size), path: rec.slice(tab + 1) });
  }
  return out;
}

// `git cat-file --batch` output: the exact bytes of each blob, as GitHub serves them (no checkout filters).
export function parseCatFile(buf) {
  const out = new Map();
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const [oid, type, size] = buf.subarray(at, nl).toString("utf8").split(" ");
    if (type === "missing") {
      at = nl + 1;
      continue;
    }
    const start = nl + 1;
    const end = start + Number(size);
    out.set(oid, buf.subarray(start, end));
    at = end + 1;
  }
  return out;
}

// Folders that hold a SKILL.md, each with the files that belong to it (a nested skill folder keeps its own files).
export function skillFolders(entries) {
  const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const skip = (p) => p.split("/").some((part) => SKIP_DIRS.has(part));
  // A SKILL.md that is a symbolic link is an alias of a skill kept elsewhere in the repository, not a skill of its own.
  const roots = entries.filter((e) => e.type === "blob" && e.mode !== "120000" && (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md")) && !skip(e.path)).map((e) => dirOf(e.path));
  const rootSet = new Set(roots);
  // The innermost skill folder a path belongs to.
  const ownerOf = (p) => {
    let d = dirOf(p);
    for (;;) {
      if (rootSet.has(d)) return d;
      if (d === "") return null;
      d = dirOf(d);
    }
  };
  const folders = new Map(roots.map((r) => [r, []]));
  for (const e of entries) {
    // Dependencies, tests and build output inside a skill folder are not part of the skill.
    if (e.type !== "blob" || skip(e.path)) continue;
    const owner = ownerOf(e.path);
    if (owner === null || !folders.has(owner)) continue;
    folders.get(owner).push({ ...e, rel: owner ? e.path.slice(owner.length + 1) : e.path });
  }
  return [...folders].map(([path, files]) => ({
    path,
    files,
    bytes: files.reduce((n, f) => n + f.size, 0),
    hidden: path.split("/").some((part) => part.startsWith(".")),
  })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

// A path as a sparse-checkout pattern: anchored, with the characters gitignore treats specially escaped.
const sparsePattern = (dir) => `/${dir.replace(/[\\*?[\]!#]/g, "\\$&")}/`;

// The commit a remote's default branch points at now, without cloning anything.
export async function remoteHead(url, { git = runGit } = {}) {
  const out = (await git(["ls-remote", url, "HEAD"], { timeout: 60000 })).toString();
  return /^([0-9a-f]{40})\s+HEAD$/m.exec(out)?.[1] ?? null;
}

// Every file of a commit with its git id and size, from GitHub's tree API (one request, nothing downloaded). Null when
// the listing is truncated (more than 100,000 entries): such a repository is not a skill collection.
export async function listCommit(gh, repo, commit) {
  const doc = await gh.tree(repo, commit);
  if (!doc || doc.truncated) return null;
  return (doc.tree ?? []).map((e) => ({ mode: e.mode, type: e.type, oid: e.sha, size: e.size ?? 0, path: e.path }));
}

// One repository at one commit: every skill folder in it put in the store. Only files the store lacks are downloaded,
// in one batch: a blobless fetch of that commit and a sparse checkout of the folders that need them. `listing` is the
// commit's files (listCommit). The license is read from the repository when the metadata did not name one.
export async function fetchRepo(repo, { store, workDir, commit, listing, git = runGit, urlFor = (r) => `https://github.com/${r}.git`, licenseKnown = false } = {}) {
  const folders = skillFolders(listing);
  const usable = folders.filter((f) => f.files.length <= LIMITS.maxFiles && f.bytes <= LIMITS.maxBytes);
  const missing = new Set();
  for (const f of usable) for (const e of f.files) if (!store.shaForGit(e.oid)) missing.add(e.oid);
  const licenseFiles = licenseKnown || !folders.length ? [] : listing.filter((e) => e.type === "blob" && /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i.test(e.path));
  for (const e of licenseFiles) if (!store.shaForGit(e.oid)) missing.add(e.oid);
  if (missing.size) {
    const dir = mkdtempSync(join(workDir, `${repo.replace("/", "__")}-`));
    try {
      await git(["init", "--quiet", dir]);
      await git(["-C", dir, "remote", "add", "origin", urlFor(repo)]);
      await git(["-C", dir, "fetch", "--quiet", "--no-tags", "--filter=blob:none", "--depth", "1", "origin", commit], { timeout: 300000 });
      const dirs = new Set(usable.filter((f) => f.files.some((e) => missing.has(e.oid))).map((f) => f.path));
      const patterns = [...dirs].map((d) => (d === "" ? "/*" : sparsePattern(d))).concat(licenseFiles.map((e) => `/${e.path}`));
      await git(["-C", dir, "sparse-checkout", "set", "--no-cone", "--stdin"], { input: patterns.join("\n") + "\n" });
      await git(["-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", "-C", dir, "checkout", "--quiet", commit], { timeout: 600000 });
      const blobs = parseCatFile(await git(["-C", dir, "cat-file", "--batch"], { input: [...missing].join("\n") + "\n" }));
      for (const [oid, content] of blobs) {
        if (gitBlobId(content) !== oid) throw new Error(`${repo}: blob ${oid} does not match its content`);
        store.putBlob(content);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { commit, files: listing.length, ...recordSkills(listing, store, { licenseKnown }) };
}

// The skill folders of a listing as the store records them, once their files are in the store: a tree per folder, or
// why it was left out. The license comes from the root license file when the metadata did not name one.
export function recordSkills(listing, store, { licenseKnown = false } = {}) {
  const folders = skillFolders(listing);
  const licenseFiles = licenseKnown || !folders.length ? [] : listing.filter((e) => e.type === "blob" && /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i.test(e.path));
  const skills = folders.map((f) => {
    const base = { path: f.path, files: f.files.length, bytes: f.bytes, hidden: f.hidden };
    if (f.files.length > LIMITS.maxFiles || f.bytes > LIMITS.maxBytes) return { ...base, declined: "too large" };
    const tree = [];
    for (const e of f.files) {
      const sha = store.shaForGit(e.oid);
      if (!sha) return { ...base, declined: "not fetched" };
      // A symbolic link's blob is its target.
      if (e.mode === "120000") tree.push({ path: e.rel, link: store.getBlob(sha).toString("utf8") });
      else tree.push({ path: e.rel, sha256: sha, size: e.size });
    }
    const skillMd = tree.find((t) => t.path === "SKILL.md")?.sha256 ?? null;
    return { ...base, tree: store.putTree(tree), skillMd };
  });
  // The license file at the root (first by name, as GitHub picks it).
  const licenseFile = licenseFiles.sort((a, b) => (a.path < b.path ? -1 : 1))[0];
  const licenseSha = licenseFile ? store.shaForGit(licenseFile.oid) : null;
  const license = licenseSha ? licenseFromText(store.getBlob(licenseSha).toString("utf8")) : null;
  return { skills, license };
}

// ---------------------------------------------------------------------------
// Discovery: where to look, the most popular first.

export const DISCOVERY = Object.freeze({
  topics: ["vibe-coding", "claude-code", "claude-skills", "claude-code-skills", "agent-skills", "skills", "codex", "codex-skills", "cursor", "gemini-cli", "ai-coding", "claude-code-plugin", "claude-code-plugins"],
  keywords: ['"SKILL.md" in:readme', '"agent skills" in:readme,description', '"claude skills" in:readme,description', '"claude code" skills in:readme,description', '"vibe coding" in:readme,description'],
  // Code search returns 1,000 results per query: split by file size to see more of it.
  codeShards: ["filename:SKILL.md size:<1500", "filename:SKILL.md size:1500..3000", "filename:SKILL.md size:3000..5000", "filename:SKILL.md size:5000..8000", "filename:SKILL.md size:8000..14000", "filename:SKILL.md size:>14000"],
  awesome: [
    "hesreallyhim/awesome-claude-code", "travisvn/awesome-claude-skills", "VoltAgent/awesome-agent-skills", "sickn33/agentic-awesome-skills",
    "ComposioHQ/awesome-claude-skills", "jqueryscript/awesome-claude-code", "punkpeye/awesome-mcp-servers",
  ],
});

// Repositories that matter for a coding agent, ranked: stars first, then how the lab found them.
const TOPIC_BONUS = new Set(["claude-code", "claude-skills", "claude-code-skills", "agent-skills", "vibe-coding", "codex", "codex-skills", "cursor", "claude-code-plugin"]);
export function priority(c) {
  const stars = c.meta?.stars ?? 0;
  const topical = (c.meta?.topics ?? []).some((t) => TOPIC_BONUS.has(t)) ? 1 : 0;
  const hasSkills = c.sources.some((s) => s.startsWith("code:")) ? 1 : 0;
  return Math.log10(stars + 1) + 0.5 * topical + 0.5 * hasSkills;
}

const GRAPHQL_FIELDS = "nameWithOwner stargazerCount forkCount description createdAt pushedAt isArchived isFork diskUsage licenseInfo { spdxId } defaultBranchRef { name } repositoryTopics(first: 20) { nodes { topic { name } } }";

// Metadata for repositories known only by name, fifty to a GraphQL request.
async function metaByName(gh, names, { log }) {
  const out = new Map();
  for (let i = 0; i < names.length; i += 50) {
    const batch = names.slice(i, i + 50);
    const query = `query { ${batch.map((n, k) => {
      const [owner, name] = n.split("/");
      return `r${k}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${GRAPHQL_FIELDS} }`;
    }).join(" ")} }`;
    let doc = null;
    try {
      doc = await gh.graphql(query);
    } catch (error) {
      log(`metadata batch ${i / 50 + 1}: ${error.message}`);
    }
    for (const [k, r] of Object.entries(doc?.data ?? {})) {
      if (!r) continue;
      out.set(batch[Number(k.slice(1))], repoMeta({
        full_name: r.nameWithOwner, stargazers_count: r.stargazerCount, forks_count: r.forkCount, description: r.description,
        created_at: r.createdAt, pushed_at: r.pushedAt, archived: r.isArchived, fork: r.isFork, size: r.diskUsage,
        license: r.licenseInfo ? { spdx_id: r.licenseInfo.spdxId } : null, default_branch: r.defaultBranchRef?.name ?? null,
        topics: (r.repositoryTopics?.nodes ?? []).map((n) => n.topic.name),
      }));
    }
  }
  return out;
}

export async function discover(gh, { plan = DISCOVERY, fetchImpl = fetch, log = () => {} } = {}) {
  const found = new Map();
  const add = (meta, source) => {
    const prev = found.get(meta.repo);
    if (prev) {
      if (!prev.sources.includes(source)) prev.sources.push(source);
      prev.meta = { ...prev.meta, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null)) };
    } else found.set(meta.repo, { repo: meta.repo, meta, sources: [source] });
  };
  for (const topic of plan.topics) {
    const r = await gh.search("repositories", `topic:${topic}`, { sort: "stars" });
    for (const item of r.items) add(repoMeta(item), `topic:${topic}`);
    log(`topic ${topic}: ${r.items.length} of ${r.total}`);
  }
  for (const q of plan.keywords) {
    const r = await gh.search("repositories", q, { sort: "stars" });
    for (const item of r.items) add(repoMeta(item), `keyword:${q}`);
    log(`keyword ${q}: ${r.items.length} of ${r.total}`);
  }
  const named = new Set();
  for (const q of plan.codeShards) {
    const r = await gh.search("code", q);
    for (const item of r.items) if (item.repository?.full_name) named.add(item.repository.full_name.toLowerCase());
    log(`code ${q}: ${r.items.length} of ${r.total}`);
  }
  for (const list of plan.awesome) {
    try {
      const res = await fetchWithRetry(`https://raw.githubusercontent.com/${list}/HEAD/README.md`, {}, { fetchImpl, retries: 2, timeoutMs: 30000 });
      if (res.ok) for (const r of reposFromText(await res.text())) named.add(`awesome:${r}`);
    } catch (error) {
      log(`awesome ${list}: ${error.message}`);
    }
  }
  // Names from code search and lists still need their metadata (stars, license, branch).
  const bySource = new Map();
  for (const n of named) {
    const [source, name] = n.startsWith("awesome:") ? ["awesome", n.slice(8)] : ["code:SKILL.md", n];
    if (!bySource.has(name)) bySource.set(name, new Set());
    bySource.get(name).add(source);
  }
  const unknown = [...bySource.keys()].filter((n) => !found.has(n));
  const metas = await metaByName(gh, unknown, { log });
  for (const [name, sources] of bySource) {
    const meta = found.get(name)?.meta ?? metas.get(name);
    if (meta) for (const s of sources) add(meta, s);
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// The crawl: repositories in priority order, a few at a time, each one recorded in the store as it finishes.

// Bump when what the crawler keeps from a repository changes (folders it skips, size limits): every repository is
// read again, once.
export const CRAWLER_VERSION = 2;

export async function crawl({ gh, store, workDir, candidates, concurrency = 6, maxRepos = Infinity, minStars = 0, now = () => new Date(), git = runGit, urlFor, log = () => {} }) {
  mkdirSync(workDir, { recursive: true });
  const due = (c) => {
    const prev = store.getRepo(c.repo);
    if (!prev) return true;
    // A failure is tried again the next day.
    if (prev.error) return now() - new Date(prev.checkedAt) >= 86400000;
    if (prev.crawlerVersion !== CRAWLER_VERSION) return true;
    // The same last push is the same content: nothing to fetch.
    return !(prev.meta?.pushedAt && prev.meta.pushedAt === c.meta.pushedAt);
  };
  const queue = candidates
    .filter((c) => !c.meta.fork && (c.meta.stars ?? 0) >= minStars && due(c))
    .sort((a, b) => priority(b) - priority(a) || (a.repo < b.repo ? -1 : 1))
    .slice(0, maxRepos);
  const stats = { queued: queue.length, done: 0, withSkills: 0, skills: 0, errors: 0 };
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const c = queue[next++];
      const prev = store.getRepo(c.repo);
      const base = { repo: c.repo, meta: c.meta, sources: c.sources, checkedAt: now().toISOString(), crawlerVersion: CRAWLER_VERSION };
      try {
        const url = (urlFor ?? ((r) => `https://github.com/${r}.git`))(c.repo);
        const commit = await remoteHead(url, { git });
        if (!commit) throw new Error("no default branch");
        // The same commit as last time: the record stands, only its metadata is refreshed.
        if (prev?.head === commit && !prev.error && prev.crawlerVersion === CRAWLER_VERSION) {
          store.putRepo(c.repo, { ...prev, ...base });
          stats.done++;
          continue;
        }
        const listing = await listCommit(gh, c.repo, commit);
        if (!listing) throw new Error("file listing unavailable or truncated");
        const r = await fetchRepo(c.repo, { store, workDir, commit, listing, git, urlFor: () => url, licenseKnown: Boolean(c.meta.license) });
        const history = prev?.head && prev.head !== r.commit ? [{ head: prev.head, checkedAt: prev.checkedAt, skills: prev.skills }, ...(prev.history ?? [])].slice(0, 5) : prev?.history ?? [];
        store.putRepo(c.repo, { ...base, head: r.commit, files: r.files, license: c.meta.license ?? r.license, skills: r.skills, history });
        stats.done++;
        if (r.skills.length) stats.withSkills++;
        stats.skills += r.skills.length;
        log(`${stats.done}/${queue.length} ${c.repo} ★${c.meta.stars}: ${r.skills.length} skill folder(s)`);
      } catch (error) {
        stats.errors++;
        const message = String(error.message ?? error).split("\n")[0].slice(0, 300);
        store.putRepo(c.repo, { ...(prev ?? {}), ...base, error: message });
        log(`${c.repo}: ${message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return stats;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const storeDir = resolve(flag(args, "--store", "store"));
  const store = createStore(storeDir);
  const gh = githubClient({ token: process.env.GITHUB_TOKEN || null, log: logStamped });
  let candidates;
  if (flag(args, "--only", null)) {
    const names = flag(args, "--only").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    candidates = [];
    for (const n of names) {
      const r = await gh.repo(n);
      if (r) candidates.push({ repo: n, meta: repoMeta(r), sources: ["manual"] });
    }
  } else {
    const saved = store.getState("discovery");
    if (!saved || args.includes("--discover")) {
      logStamped("discovering…");
      candidates = await discover(gh, { log: logStamped });
      store.putState("discovery", { at: new Date().toISOString(), candidates });
    } else candidates = saved.candidates;
  }
  logStamped(`${candidates.length} candidate repositories`);
  const stats = await crawl({
    gh, store, workDir: resolve(flag(args, "--work", join(storeDir, "work"))), candidates,
    maxRepos: Number(flag(args, "--max-repos", "500")), concurrency: Number(flag(args, "--concurrency", "6")), minStars: Number(flag(args, "--min-stars", "10")), log: logStamped,
  });
  console.log(JSON.stringify(stats));
}
