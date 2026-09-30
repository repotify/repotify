import { join } from "node:path";
import { readTree } from "../src/scan/index.mjs";
import { sha256 } from "../src/util.mjs";

export { parseFrontmatter } from "../src/frontmatter.mjs";
import { parseFrontmatter } from "../src/frontmatter.mjs";

export const MAX_SKILL_FILES = 400;
export const MAX_SKILL_BYTES = 30 * 1024 * 1024;

export async function snapshotSkill(repoDir, skillPath) {
  const dir = skillPath ? join(repoDir, skillPath) : repoDir;
  const tree = await readTree(dir, { maxFiles: MAX_SKILL_FILES, maxBytes: MAX_SKILL_BYTES });
  const files = tree.filter((f) => !f.isSymlink).map((f) => ({ path: f.path, sha256: sha256(f.content), size: f.size }));
  const skillMd = tree.find((f) => f.path === "SKILL.md");
  const frontmatter = skillMd ? parseFrontmatter(skillMd.content.toString("utf8")) : {};
  return { files, frontmatter, descriptionChars: (frontmatter.description ?? "").length, tree };
}

// ---------------------------------------------------------------------------
// Cloning and skill discovery inside a repository.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";

const SKIP_SKILL_DIRS = new Set([".git", "node_modules", "test", "tests", "fixtures", "__fixtures__", "examples", "example", "evals", "evals-extra", "template", "templates", ".github"]);

export function runGit(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000, ...opts }).trim();
}

export async function findSkillDirs(repoDir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(repoDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) out.push(rel);
    for (const e of entries) if (e.isDirectory() && !SKIP_SKILL_DIRS.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name);
  };
  walk("");
  return out.sort();
}

export function cloneRepo(repo, workDir, { git = runGit, urlFor = (r) => `https://github.com/${r}.git`, fresh = true } = {}) {
  const dir = join(workDir, repo.replace("/", "_"));
  if (fresh) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(workDir, { recursive: true });
    const url = urlFor(repo);
    const remote = /^[a-z]+:\/\//.test(url);
    git(["clone", "--quiet", "--depth", "1", ...(remote ? ["--filter=blob:limit=5m"] : []), url, dir]);
  }
  return { dir, commit: git(["-C", dir, "rev-parse", "HEAD"]), committedAt: git(["-C", dir, "log", "-1", "--format=%cI"]) };
}

const LICENSE_RULES = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, "AGPL-3.0"],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, "LGPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 3/i, "GPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 2/i, "GPL-2.0"],
  [/Apache License[\s\S]{0,200}Version 2\.0/i, "Apache-2.0"],
  [/Mozilla Public License[\s\S]{0,50}2\.0/i, "MPL-2.0"],
  [/Attribution-ShareAlike 4\.0/i, "CC-BY-SA-4.0"],
  [/Permission is hereby granted, free of charge/i, "MIT"],
  [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i, "ISC"],
  [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
  [/Redistribution and use in source and binary forms[\s\S]*Neither the name/i, "BSD-3-Clause"],
  [/Redistribution and use in source and binary forms/i, "BSD-2-Clause"],
];

// SPDX id from the repository's license file; "NOASSERTION" when a file exists but is not recognized.
export function detectLicense(repoDir) {
  let names = [];
  try {
    names = readdirSync(repoDir).filter((n) => /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i.test(n));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const text = readFileSync(join(repoDir, names.sort()[0]), "utf8").slice(0, 20000);
  for (const [re, spdx] of LICENSE_RULES) if (re.test(text)) return spdx;
  return "NOASSERTION";
}

export async function collectRepo(repo, { workDir, git = runGit, urlFor, paths = null, meta = null, fresh = true } = {}) {
  const clone = cloneRepo(repo, workDir, { git, urlFor, fresh });
  const dirs = paths ?? (await findSkillDirs(clone.dir));
  const skills = [];
  const skipped = [];
  for (const path of dirs) {
    if (!existsSync(join(clone.dir, path, "SKILL.md")) && paths === null) continue;
    try {
      skills.push({ path, ...(await snapshotSkill(clone.dir, path)) });
    } catch (error) {
      skipped.push({ path, reason: error.message });
    }
  }
  // Hashes of every SKILL.md in the repo, used to recognize copies elsewhere.
  const skillHashes = [];
  for (const path of paths === null ? dirs : await findSkillDirs(clone.dir)) {
    try {
      skillHashes.push({ path, sha256: sha256(readFileSync(join(clone.dir, path, "SKILL.md"))) });
    } catch {
      // Not a skill folder.
    }
  }
  return {
    repo,
    dir: clone.dir,
    commit: clone.commit,
    committedAt: clone.committedAt,
    skills,
    skipped,
    skillHashes,
    meta: {
      stars: meta?.stars ?? null,
      license: meta?.license ?? detectLicense(clone.dir),
      createdAt: meta?.createdAt ?? null,
      pushedAt: meta?.pushedAt ?? null,
    },
  };
}
