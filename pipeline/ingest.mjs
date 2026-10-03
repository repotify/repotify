#!/usr/bin/env node
// Imports repositories already on disk (a working tree and its .git) into the content store, without the network: the
// same records the crawler writes, built from the files as checked out. For clones the lab or a maintainer already
// has; the crawler refreshes their metadata and content on its next visit.
//   node pipeline/ingest.mjs --store DIR [--meta meta.json] <clone-dir>…
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { isMain } from "../src/util.mjs";
import { createStore, gitBlobId } from "./store.mjs";
import { recordSkills, skillFolders, LIMITS, CRAWLER_VERSION } from "./crawl.mjs";
import { flag } from "./lib/cli.mjs";

// Every file of a working tree as `git ls-tree` would list it; contents are read only for the files `want` keeps.
function listWorkingTree(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === ".git") continue;
      const st = lstatSync(join(root, path));
      if (st.isDirectory()) walk(path);
      else if (st.isSymbolicLink()) out.push({ mode: "120000", type: "blob", oid: null, size: 0, path });
      else if (st.isFile()) out.push({ mode: st.mode & 0o111 ? "100755" : "100644", type: "blob", oid: null, size: st.size, path });
    }
  };
  walk("");
  return out;
}

export function ingestWorkingTree(root, { store }) {
  const listing = listWorkingTree(root);
  const folders = skillFolders(listing);
  const wanted = new Set();
  for (const f of folders) if (f.files.length <= LIMITS.maxFiles && f.bytes <= LIMITS.maxBytes) for (const e of f.files) wanted.add(e.path);
  for (const e of listing) if (/^(licen[cs]e|copying)(\.(md|txt|rst))?$/i.test(e.path)) wanted.add(e.path);
  for (const e of listing) {
    if (!wanted.has(e.path)) continue;
    const content = e.mode === "120000" ? Buffer.from(readlinkSync(join(root, e.path))) : readFileSync(join(root, e.path));
    e.oid = gitBlobId(content);
    e.size = content.length;
    store.putBlob(content);
  }
  // Files not read keep a placeholder id: they belong to no recorded skill.
  for (const e of listing) e.oid ??= `x${e.path}`;
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { commit, files: listing.length, ...recordSkills(listing, store) };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const store = createStore(resolve(flag(args, "--store") ?? "store"));
  const metas = flag(args, "--meta") ? JSON.parse(readFileSync(flag(args, "--meta"), "utf8")) : {};
  const dirs = args.filter((a, i) => !a.startsWith("--") && !["--store", "--meta"].includes(args[i - 1]));
  let n = 0;
  for (const dir of dirs) {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const repo = /github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/.exec(url)?.[1]?.toLowerCase();
    if (!repo) continue;
    const r = ingestWorkingTree(dir, { store });
    const meta = { repo, stars: null, license: null, topics: [], pushedAt: null, fork: false, ...(metas[repo] ?? {}) };
    store.putRepo(repo, { repo, meta, sources: ["import"], checkedAt: new Date().toISOString(), crawlerVersion: CRAWLER_VERSION, head: r.commit, files: r.files, license: meta.license ?? r.license, skills: r.skills, history: [] });
    n++;
    console.error(`${n}/${dirs.length} ${repo}: ${r.skills.length} skill folder(s)`);
  }
}
