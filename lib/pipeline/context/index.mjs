// Seed context collector (FAZ 3, R1): cheap project context for the
// classifier. Reads the project manifest (package.json / pyproject.toml /
// go.mod / ...), a shallow file skeleton (no deep reads), and the existing
// skill/repo inventory. Budget: <2s target; everything is bounded and the
// elapsed time is reported. When nothing is found the output is flagged
// low-confidence so the next phase knows not to trust it.
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export const CONTEXT_VERSION = "1";
export const CONTEXT_BUDGET_MS = 2000;
const MAX_SKELETON_ENTRIES = 300;
const MAX_SKELETON_DEPTH = 2;
const MAX_MANIFEST_DEPS = 60;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "target", "vendor", ".venv", "venv"]);

const MANIFESTS = [
  { file: "package.json", kind: "node", parse: parsePackageJson },
  { file: "pyproject.toml", kind: "python", parse: (t) => parseTomlNameDeps(t, "pyproject.toml") },
  { file: "requirements.txt", kind: "python", parse: parseRequirements },
  { file: "setup.py", kind: "python", parse: () => ({ deps: [] }) },
  { file: "go.mod", kind: "go", parse: parseGoMod },
  { file: "Cargo.toml", kind: "rust", parse: (t) => parseTomlNameDeps(t, "Cargo.toml") },
  { file: "Gemfile", kind: "ruby", parse: parseGemfile },
  { file: "composer.json", kind: "php", parse: parseComposerJson },
  { file: "pom.xml", kind: "java", parse: parsePomXml },
];

const SKILL_DIRS = [".agents/skills", ".claude/skills", ".cursor/skills", ".codex/skills", ".gemini/skills", "skills"];

function parsePackageJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { name: null, deps: [] };
  }
  const deps = [...Object.keys(doc.dependencies ?? {}), ...Object.keys(doc.devDependencies ?? {})];
  const scripts = Object.keys(doc.scripts ?? {});
  return { name: doc.name ?? null, deps: deps.slice(0, MAX_MANIFEST_DEPS), scripts: scripts.slice(0, 20), private: doc.private ?? null };
}

function parseTomlNameDeps(text, file) {
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null;
  const deps = [];
  const section = file === "Cargo.toml" ? "[dependencies]" : null;
  let inDeps = section == null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inDeps = section ? t === section : /dependencies/i.test(t);
      continue;
    }
    if (inDeps && /^[a-z0-9_.-]+\s*=/i.test(t)) deps.push(t.split("=")[0].trim().toLowerCase());
    if (deps.length >= MAX_MANIFEST_DEPS) break;
  }
  return { name, deps };
}

function parseRequirements(text) {
  const deps = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"))
    .map((l) => l.split(/[<>=!;\s]/)[0].toLowerCase()).filter(Boolean);
  return { name: null, deps: deps.slice(0, MAX_MANIFEST_DEPS) };
}

function parseGoMod(text) {
  const mod = /^\s*module\s+(\S+)/m.exec(text)?.[1] ?? null;
  const deps = [...text.matchAll(/^\s+([a-z0-9_.-]+\.[a-z0-9_.\/-]+)\s+v[\d]/gim)].map((m) => m[1].toLowerCase());
  return { name: mod, deps: [...new Set(deps)].slice(0, MAX_MANIFEST_DEPS) };
}

function parseGemfile(text) {
  const deps = [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gim)].map((m) => m[1].toLowerCase());
  return { name: null, deps: [...new Set(deps)].slice(0, MAX_MANIFEST_DEPS) };
}

function parseComposerJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { name: null, deps: [] };
  }
  const deps = Object.keys({ ...(doc.require ?? {}), ...(doc["require-dev"] ?? {}) }).filter((d) => d !== "php");
  return { name: doc.name ?? null, deps: deps.slice(0, MAX_MANIFEST_DEPS) };
}

function parsePomXml(text) {
  const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1] ?? null;
  const deps = [...text.matchAll(/<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g)]
    .map((m) => `${m[1]}:${m[2]}`.toLowerCase());
  return { name: artifact, deps: [...new Set(deps)].slice(0, MAX_MANIFEST_DEPS) };
}

async function readManifest(dir, { file, kind, parse }, readFile) {
  try {
    const text = await readFile(join(dir, file), "utf8");
    const { name, deps, scripts, ...rest } = parse(text);
    return { kind, file, name, deps: deps ?? [], ...(scripts ? { scripts } : {}), ...rest };
  } catch {
    return null;
  }
}

async function skeletonDir(dir, depth, budget, readdir) {
  // Returns { entries: [{name, type}], truncated } — sorted, bounded, shallow.
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return { entries: [], truncated: false };
  }
  const entries = [];
  let truncated = false;
  const sorted = names.map((d) => d.name).sort();
  for (const name of sorted) {
    if (entries.length >= MAX_SKELETON_ENTRIES) {
      truncated = true;
      break;
    }
    const full = join(dir, name);
    const isDir = names.find((d) => d.name === name)?.isDirectory() ?? false;
    if (isDir && (SKIP_DIRS.has(name) || name.startsWith("."))) {
      entries.push({ name, type: "dir", skipped: true });
      continue;
    }
    entries.push({ name, type: isDir ? "dir" : "file" });
    if (isDir && depth < MAX_SKELETON_DEPTH && budget.ok()) {
      const sub = await skeletonDir(full, depth + 1, budget, readdir);
      for (const s of sub.entries) {
        if (entries.length >= MAX_SKELETON_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ name: `${name}/${s.name}`, type: s.type });
      }
      truncated = truncated || sub.truncated;
    }
  }
  return { entries, truncated };
}

async function skillInventory(dir, home, readDir) {
  const found = [];
  for (const rel of SKILL_DIRS) {
    try {
      const names = (await readDir(join(dir, rel), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      if (names.length) found.push({ path: rel, scope: "project", skills: names.slice(0, 50) });
    } catch {
      /* absent is fine */
    }
  }
  try {
    const names = (await readDir(join(home, ".claude", "skills"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    if (names.length) found.push({ path: "~/.claude/skills", scope: "global", skills: names.slice(0, 50) });
  } catch {
    /* absent is fine */
  }
  return found;
}

// projectDir: absolute path. fs overrides ({ readFile, readdir }) keep tests offline.
export async function collectSeedContext(projectDir, { now = new Date(), budgetMs = CONTEXT_BUDGET_MS, home = homedir(), fs = null } = {}) {
  const t0 = Date.now();
  const { readFile, readdir: readDir } = fs ?? (await import("node:fs/promises"));
  const deadline = t0 + budgetMs;
  const budget = { ok: () => Date.now() < deadline };

  const manifests = [];
  for (const m of MANIFESTS) {
    if (!budget.ok()) break;
    const parsed = await readManifest(projectDir, m, readFile);
    if (parsed) manifests.push(parsed);
  }
  const { entries, truncated } = await skeletonDir(projectDir, 1, budget, readDir);
  const inventory = await skillInventory(projectDir, home, readDir);

  const durationMs = Date.now() - t0;
  const empty = !manifests.length && !entries.length && !inventory.length;
  const confidence = manifests.length ? "high" : entries.length ? "medium" : "low";
  return {
    version: CONTEXT_VERSION,
    projectDir: basename(projectDir),
    manifests,
    skeleton: { entries, truncated, depth: MAX_SKELETON_DEPTH },
    inventory,
    confidence,
    lowConfidence: empty,
    durationMs,
    withinBudget: durationMs <= budgetMs,
    collectedAt: now.toISOString(),
  };
}
