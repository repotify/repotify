import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, gitBlobId, obsKey } from "../pipeline/store.mjs";
import { githubClient, repoMeta } from "../pipeline/github.mjs";
import { fetchRepo, crawl, discover, parseLsTree, parseCatFile, skillFolders, priority, runGit, remoteHead, listCommit, CRAWLER_VERSION } from "../pipeline/crawl.mjs";

const tempDirs = [];
const mkTemp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("the store keeps each file once, maps git ids to it and hashes trees canonically", () => {
  const store = createStore(mkTemp("rp-store-"));
  const a = store.putBlob("hello\n");
  assert.equal(store.putBlob(Buffer.from("hello\n")), a);
  assert.equal(store.getBlob(a).toString(), "hello\n");
  assert.equal(store.shaForGit(gitBlobId("hello\n")), a);
  assert.equal(gitBlobId("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a"); // `git hash-object` of the same text
  assert.equal(store.shaForGit("0".repeat(40)), null);
  const t1 = store.putTree([{ path: "b.md", sha256: a, size: 6 }, { path: "a", link: "b.md" }]);
  const t2 = store.putTree([{ path: "a", link: "b.md" }, { size: 6, sha256: a, path: "b.md" }]);
  assert.equal(t1, t2);
  assert.deepEqual(store.treeFiles(t1).map((f) => [f.path, f.isSymlink ?? false, f.linkTarget ?? f.content.toString()]), [["a", true, "b.md"], ["b.md", false, "hello\n"]]);
  store.putRepo("Acme/Tools", { repo: "acme/tools", head: "x" });
  assert.deepEqual(store.listRepos(), ["acme/tools"]);
  assert.equal(store.getRepo("acme/tools").head, "x");
  const key = obsKey("scan", t1, "1.4.0");
  store.putObs("scan", key, { level: "verified" });
  assert.deepEqual(store.getObs("scan", key), { level: "verified" });
  assert.equal(store.getObs("scan", obsKey("scan", t1, "1.5.0")), null);
  assert.throws(() => store.getBlob("../../etc/passwd") ?? store.putObs("scan", "../x", {}), /not a hash/);
});

test("ls-tree and cat-file output is read exactly", () => {
  const ls = Buffer.from("100644 blob aaa      12\tskills/a/SKILL.md\u0000120000 blob bbb       5\tskills/a/link\u0000160000 commit ccc       -\tvendor/sub\u0000");
  assert.deepEqual(parseLsTree(ls), [
    { mode: "100644", type: "blob", oid: "aaa", size: 12, path: "skills/a/SKILL.md" },
    { mode: "120000", type: "blob", oid: "bbb", size: 5, path: "skills/a/link" },
    { mode: "160000", type: "commit", oid: "ccc", size: 0, path: "vendor/sub" },
  ]);
  const cat = Buffer.concat([Buffer.from("aaa blob 3\nabc\n"), Buffer.from("zzz missing\n"), Buffer.from("bbb blob 4\nx\ny\n\n")]);
  const blobs = parseCatFile(cat);
  assert.equal(blobs.get("aaa").toString(), "abc");
  assert.equal(blobs.get("bbb").toString(), "x\ny\n");
  assert.equal(blobs.has("zzz"), false);
});

test("skill folders: nested skills keep their own files; tests, fixtures and dependencies are not skills", () => {
  const e = (path, size = 1) => ({ mode: "100644", type: "blob", oid: path, size, path });
  const folders = skillFolders([
    e("SKILL.md"), e("README.md"), e("skills/a/SKILL.md"), e("skills/a/ref.md"), e("skills/a/inner/SKILL.md"), e("skills/a/inner/x.md"),
    e("tests/fixtures/b/SKILL.md"), e("node_modules/c/SKILL.md"), e(".claude/skills/h/SKILL.md"),
    { mode: "120000", type: "blob", oid: "l", size: 9, path: "plugins/p/alias/SKILL.md" },
  ]);
  assert.deepEqual(folders.map((f) => [f.path, f.files.map((x) => x.rel), f.hidden]), [
    ["", ["SKILL.md", "README.md", "plugins/p/alias/SKILL.md"], false],
    [".claude/skills/h", ["SKILL.md"], true],
    ["skills/a", ["SKILL.md", "ref.md"], false],
    ["skills/a/inner", ["SKILL.md", "x.md"], false],
  ]);
});

// A repository on disk that clones like a GitHub one: blobless, shallow, sparse.
function makeRepo({ files, links = {} }) {
  const dir = mkTemp("rp-src-");
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "uploadpack.allowFilter", "true");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  for (const [p, target] of Object.entries(links)) symlinkSync(target, join(dir, p));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, url: `file://${dir}`, git };
}

// GitHub's tree API for repositories on disk: the same entries, read with ls-tree.
const localGh = (dirFor) => ({
  async tree(repo, sha) {
    const out = execFileSync("git", ["-C", dirFor(repo), "ls-tree", "-r", "-l", "-z", "--full-tree", sha]);
    return { truncated: false, tree: parseLsTree(out).map((e) => ({ mode: e.mode, type: e.type, sha: e.oid, size: e.size, path: e.path })) };
  },
});
async function snapshot(src) {
  const commit = await remoteHead(src.url);
  return { commit, listing: await listCommit(localGh(() => src.dir), "x/y", commit) };
}

const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software\n";

test("a repository's skill folders land in the store; a second fetch downloads nothing it already has", { skip: process.platform === "win32" && "symlinks" }, async () => {
  const src = makeRepo({
    files: {
      "LICENSE": MIT, "README.md": "# tools\n",
      "skills/a/SKILL.md": "---\nname: a\ndescription: A.\n---\nDo a.\n", "skills/a/ref.md": "ref\n", "skills/a/scripts/run.sh": "#!/bin/sh\necho a\n",
      "skills/a/nested/SKILL.md": "---\nname: n\ndescription: N.\n---\n", "skills/b c/SKILL.md": "---\nname: b\ndescription: B.\n---\n",
      "tests/fixtures/x/SKILL.md": "fixture\n",
    },
    links: { "skills/a/link": "ref.md" },
  });
  const store = createStore(mkTemp("rp-store-"));
  const calls = [];
  const git = (args, opts) => {
    calls.push(args.find((a) => ["clone", "checkout", "sparse-checkout", "cat-file", "ls-tree"].includes(a)) ?? args[2]);
    return runGit(args, opts);
  };
  const workDir = mkTemp("rp-work-");
  const r = await fetchRepo("acme/tools", { store, workDir, git, urlFor: () => src.url, ...(await snapshot(src)) });
  assert.match(r.commit, /^[0-9a-f]{40}$/);
  assert.equal(r.license, "MIT");
  assert.deepEqual(r.skills.map((s) => s.path), ["skills/a", "skills/a/nested", "skills/b c"]);
  const a = r.skills[0];
  const files = store.treeFiles(a.tree);
  assert.deepEqual(files.map((f) => f.path), ["SKILL.md", "link", "ref.md", "scripts/run.sh"]);
  assert.equal(files.find((f) => f.path === "link").linkTarget, "ref.md");
  assert.equal(files.find((f) => f.path === "scripts/run.sh").content.toString(), "#!/bin/sh\necho a\n");
  assert.equal(store.getBlob(a.skillMd).toString(), "---\nname: a\ndescription: A.\n---\nDo a.\n");
  assert.ok(calls.includes("checkout"));
  // Everything is in the store now: the same commit fetches no file.
  calls.length = 0;
  const again = await fetchRepo("acme/tools", { store, workDir, git, urlFor: () => src.url, licenseKnown: true, ...(await snapshot(src)) });
  assert.deepEqual(again.skills.map((s) => s.tree), r.skills.map((s) => s.tree));
  assert.deepEqual(calls, []);
  assert.equal(again.license, null);
  // One changed file: only that folder is checked out again.
  writeFileSync(join(src.dir, "skills/b c/SKILL.md"), "---\nname: b\ndescription: B, better.\n---\n");
  src.git("commit", "-q", "-am", "b");
  calls.length = 0;
  const third = await fetchRepo("acme/tools", { store, workDir, git, urlFor: () => src.url, ...(await snapshot(src)) });
  assert.ok(calls.includes("checkout"));
  assert.notEqual(third.skills[2].tree, r.skills[2].tree);
  assert.equal(third.skills[0].tree, r.skills[0].tree);
  assert.equal(existsSync(join(workDir, "acme__tools")), false);
});

test("a skill folder above the size limits is recorded as declined and never downloaded", async () => {
  const files = { "big/SKILL.md": "---\nname: big\ndescription: Big.\n---\n" };
  for (let i = 0; i < 401; i++) files[`big/data/${i}.txt`] = `${i}\n`;
  const src = makeRepo({ files });
  const store = createStore(mkTemp("rp-store-"));
  const r = await fetchRepo("acme/big", { store, workDir: mkTemp("rp-work-"), urlFor: () => src.url, licenseKnown: true, ...(await snapshot(src)) });
  assert.deepEqual(r.skills.map((s) => [s.path, s.declined, s.files]), [["big", "too large", 402]]);
  assert.equal(store.shaForGit(gitBlobId("0\n")), null);
});

test("the crawl visits the most popular repositories first, records each one and skips unchanged ones", async () => {
  const src = makeRepo({ files: { "SKILL.md": "---\nname: solo\ndescription: Solo.\n---\n" } });
  const store = createStore(mkTemp("rp-store-"));
  const workDir = mkTemp("rp-work-");
  const meta = (repo, stars, pushedAt = "2026-10-01T00:00:00Z") => ({ repo, meta: { repo, stars, pushedAt, license: "MIT", topics: [], fork: false, defaultBranch: null }, sources: ["topic:claude-code"] });
  const candidates = [meta("acme/small", 12), meta("acme/popular", 900), meta("acme/fork", 5000), meta("acme/tiny", 3)];
  candidates[2].meta.fork = true;
  const order = [];
  const gh = localGh(() => src.dir);
  const stats = await crawl({ gh, store, workDir, candidates, concurrency: 1, minStars: 10, urlFor: (r) => (order.push(r), src.url) });
  assert.deepEqual(order, ["acme/popular", "acme/small"]);
  assert.equal(stats.done, 2);
  const rec = store.getRepo("acme/popular");
  assert.equal(rec.crawlerVersion, CRAWLER_VERSION);
  assert.deepEqual(rec.skills.map((s) => s.path), [""]);
  order.length = 0;
  const unchanged = await crawl({ gh, store, workDir, candidates, concurrency: 1, minStars: 10, urlFor: (r) => (order.push(r), src.url) });
  assert.equal(unchanged.queued, 0);
  candidates[0].meta.pushedAt = "2026-10-02T00:00:00Z";
  await crawl({ gh, store, workDir, candidates, concurrency: 1, minStars: 10, urlFor: (r) => (order.push(r), src.url) });
  assert.deepEqual(order, ["acme/small"]);
  // A push to another branch: same head commit, nothing listed or fetched, the record keeps its skills.
  assert.deepEqual(store.getRepo("acme/small").skills.map((x) => x.path), [""]);
  // A repository that cannot be fetched is recorded with the error and tried again a day later.
  const broken = [meta("acme/gone", 50)];
  const s = await crawl({ gh, store, workDir, candidates: broken, urlFor: () => "file:///nonexistent/repo", log: () => {} });
  assert.equal(s.errors, 1);
  assert.match(store.getRepo("acme/gone").error, /./);
  assert.equal((await crawl({ gh, store, workDir, candidates: broken, urlFor: () => src.url })).queued, 0);
  assert.ok(priority({ meta: { stars: 1000, topics: ["claude-code"] }, sources: [] }) > priority({ meta: { stars: 1000, topics: [] }, sources: [] }));
});

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("the GitHub client pages through search results and waits out rate limits", async () => {
  const slept = [];
  let t = 1_000_000;
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (seen.length === 1) return json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(t / 1000) + 30) });
    const page = Number(new URL(url).searchParams.get("page"));
    const items = Array.from({ length: page === 1 ? 100 : 20 }, (_, i) => ({ full_name: `Acme/R${page}-${i}`, stargazers_count: i, license: { spdx_id: "MIT" }, topics: ["claude-code"] }));
    return json({ total_count: 120, items });
  };
  const gh = githubClient({ token: "t", fetchImpl, sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t });
  const r = await gh.search("repositories", "topic:claude-code", { sort: "stars" });
  assert.equal(r.items.length, 120);
  assert.equal(r.total, 120);
  assert.ok(slept.some((ms) => ms >= 30000), `waited ${slept}`);
  assert.equal(new URL(seen[1]).searchParams.get("sort"), "stars");
  assert.deepEqual(repoMeta(r.items[0]), {
    repo: "acme/r1-0", stars: 0, forks: 0, license: "MIT", topics: ["claude-code"], description: "", defaultBranch: null,
    pushedAt: null, createdAt: null, archived: false, fork: false, size: null,
  });
  assert.equal(await githubClient({ fetchImpl: async () => json({}, 404) }).repo("acme/missing"), null);
});

test("discovery merges topic, keyword, code-search and list sources into one candidate per repository", async () => {
  const gh = {
    async search(type, q) {
      if (type === "code") return { items: [{ repository: { full_name: "Solo/Skill" } }, { repository: { full_name: "Acme/Tools" } }], total: 2 };
      return { items: [{ full_name: "Acme/Tools", stargazers_count: 500, topics: ["claude-code"], pushed_at: "p" }], total: 1 };
    },
    async graphql(query) {
      assert.match(query, /repository\(owner: "solo", name: "skill"\)/);
      assert.ok(!query.includes("acme"), "known repositories are not looked up again");
      return { data: { r0: { nameWithOwner: "Solo/Skill", stargazerCount: 42, forkCount: 1, licenseInfo: { spdxId: "MIT" }, defaultBranchRef: { name: "main" }, repositoryTopics: { nodes: [] }, isFork: false, isArchived: false } } };
    },
  };
  const fetchImpl = async () => new Response("See https://github.com/Solo/Skill and https://github.com/topics/x\n");
  const found = await discover(gh, { plan: { topics: ["claude-code"], keywords: [], codeShards: ["filename:SKILL.md"], awesome: ["x/list"] }, fetchImpl });
  const byRepo = Object.fromEntries(found.map((c) => [c.repo, c]));
  assert.deepEqual(Object.keys(byRepo).sort(), ["acme/tools", "solo/skill"]);
  assert.deepEqual(byRepo["acme/tools"].sources.sort(), ["code:SKILL.md", "topic:claude-code"]);
  assert.deepEqual(byRepo["solo/skill"].sources.sort(), ["awesome", "code:SKILL.md"]);
  assert.equal(byRepo["solo/skill"].meta.stars, 42);
  assert.equal(byRepo["solo/skill"].meta.defaultBranch, "main");
});
