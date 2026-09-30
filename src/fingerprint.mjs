import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DEP_MAP, FILE_MAP, LANG_BY_EXT, LANG_STACK, FRONTEND_STACKS } from "./stackmap.mjs";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "env",
  "__pycache__", "target", "vendor", ".turbo", "coverage", ".cache", ".gradle", "Pods", ".dart_tool", ".idea",
]);
const MANIFESTS = new Set(["package.json", "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pubspec.yaml"]);
const SKILL_DIRS = [".claude/skills", ".cursor/skills", ".agents/skills", ".gemini/skills"];
const LARGE_CODEBASE_FILES = 1500;
const MAX_MANIFEST_BYTES = 512 * 1024;

const isManifest = (name) => MANIFESTS.has(name) || /^requirements.*\.txt$/.test(name);

async function walk(root, maxFiles) {
  const files = [];
  let truncated = false;
  const queue = [""];
  while (queue.length) {
    const rel = queue.shift();
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(path);
      } else if (e.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(path);
      }
    }
    if (truncated) break;
  }
  return { files, truncated };
}

const normPy = (name) => name.trim().toLowerCase().replace(/_/g, "-").replace(/\[.*$/, "");

function pyReqName(line) {
  const t = line.replace(/#.*/, "").trim();
  if (!t || t.startsWith("-")) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(t);
  return m ? normPy(m[1]) : null;
}

function quoted(text) {
  return [...text.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

// Dependency names from each manifest type. Never throws.
export function manifestDeps(name, text) {
  const src = text.replace(/^\u{FEFF}/u, "");
  try {
    if (name === "package.json" || name === "composer.json") {
      const j = JSON.parse(src);
      const keys = name === "package.json" ? ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] : ["require", "require-dev"];
      return keys.flatMap((k) => Object.keys(j[k] ?? {}));
    }
    if (/^requirements.*\.txt$/.test(name)) return src.split("\n").map(pyReqName).filter(Boolean);
    if (name === "pyproject.toml" || name === "Pipfile" || name === "Cargo.toml") {
      const deps = [];
      let section = "";
      let inArray = false;
      for (const raw of src.split("\n")) {
        const line = raw.replace(/#.*/, "");
        const sec = /^\s*\[([^\]]+)\]/.exec(line);
        if (sec) {
          section = sec[1].trim();
          inArray = false;
          continue;
        }
        if (section === "project" && /^\s*dependencies\s*=\s*\[/.test(line)) inArray = true;
        if (inArray || section === "project.optional-dependencies" || section === "dependency-groups") {
          for (const q of quoted(line)) {
            const n = pyReqName(q);
            if (n) deps.push(n);
          }
          if (inArray && line.replace(/"[^"]*"|'[^']*'/g, "").includes("]")) inArray = false;
          continue;
        }
        if (/dependencies$|^packages$|^dev-packages$/.test(section)) {
          const kv = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
          if (kv && kv[1] !== "python") deps.push(name === "Cargo.toml" ? kv[1] : normPy(kv[1]));
        }
      }
      return deps;
    }
    if (name === "go.mod") {
      return [...src.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[\d.]/gm)].map((m) => m[1]);
    }
    if (name === "Gemfile") return [...src.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    if (name === "pubspec.yaml") {
      const deps = [];
      let inDeps = false;
      for (const line of src.split("\n")) {
        if (/^(dependencies|dev_dependencies):/.test(line)) inDeps = true;
        else if (/^\S/.test(line)) inDeps = false;
        else if (inDeps) {
          const kv = /^ {2}([a-z0-9_]+):/.exec(line);
          if (kv) deps.push(kv[1]);
        }
      }
      return deps;
    }
  } catch {
    return [];
  }
  return [];
}

function emptyFingerprint(reason) {
  return {
    empty: true, reason, truncated: false, languages: [], manifests: [], stacks: [], frameworks: [], infra: [], tests: [],
    data: [], llm: [], inferredNeeds: [], capabilityHints: [], platforms: [], size: { files: 0 }, agents: { configured: [], skills: [] },
  };
}

export async function fingerprint(dir, { maxFiles = 20000, homeDir = homedir() } = {}) {
  const root = resolve(dir);
  if (root === resolve(homeDir) || root === sep || root === resolve("/")) return emptyFingerprint("home-or-root");
  const { files, truncated } = await walk(root, maxFiles);
  const sets = {
    stacks: new Set(), frameworks: new Set(), infra: new Set(), tests: new Set(), data: new Set(), llm: new Set(), needs: new Set(),
    caps: new Set(), platforms: new Set(), agents: new Set(), skills: new Set(),
  };
  const langCounts = new Map();
  const manifests = [];

  const apply = (entry) => {
    for (const s of entry.stacks ?? []) sets.stacks.add(s);
    for (const n of entry.needs ?? []) sets.needs.add(n);
    for (const c of entry.caps ?? []) sets.caps.add(c);
    for (const p of entry.platforms ?? []) sets.platforms.add(p);
    if (entry.framework) sets.frameworks.add(entry.framework);
    if (entry.infra) sets.infra.add(entry.infra);
    if (entry.test) sets.tests.add(entry.test);
    if (entry.data) sets.data.add(entry.data);
    if (entry.llm) sets.llm.add(entry.llm);
    if (entry.agent) sets.agents.add(entry.agent);
  };

  for (const path of files) {
    const name = path.split("/").pop();
    const dot = name.lastIndexOf(".");
    const lang = dot > 0 ? LANG_BY_EXT[name.slice(dot).toLowerCase()] : undefined;
    if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    for (const [re, entry] of FILE_MAP) if (re.test(path)) apply(entry);
    for (const sd of SKILL_DIRS) {
      const m = path.startsWith(sd + "/") ? /^([^/]+)\/SKILL\.md$/.exec(path.slice(sd.length + 1)) : null;
      if (m) sets.skills.add(m[1]);
    }
    if (path.startsWith(".agents/skills/")) sets.agents.add("generic");
    if (isManifest(name)) {
      manifests.push(path);
      let text = "";
      try {
        if ((await stat(join(root, path))).size <= MAX_MANIFEST_BYTES) text = await readFile(join(root, path), "utf8");
      } catch {
        continue;
      }
      if (name === "package.json") sets.stacks.add("node");
      if (name === "go.mod") sets.stacks.add("go");
      if (name === "Cargo.toml") sets.stacks.add("rust");
      if (name === "Gemfile") sets.stacks.add("ruby");
      if (name === "composer.json") sets.stacks.add("php");
      if (name === "pubspec.yaml") sets.stacks.add("dart");
      if (name === "pyproject.toml" || name === "Pipfile" || name.startsWith("requirements")) sets.stacks.add("python");
      for (const dep of manifestDeps(name, text)) {
        const entry = DEP_MAP[dep] ?? DEP_MAP[dep.toLowerCase()];
        if (entry) apply(entry);
      }
    }
  }

  for (const [lang, count] of langCounts) if (LANG_STACK[lang] && count > 0) sets.stacks.add(LANG_STACK[lang]);
  if (sets.tests.size) sets.needs.add("testing");
  if (files.length > LARGE_CODEBASE_FILES) sets.needs.add("large-codebase");
  if ([...sets.stacks].some((s) => FRONTEND_STACKS.includes(s))) sets.needs.add("frontend-ui");

  const sourceFiles = [...langCounts.values()].reduce((a, b) => a + b, 0);
  const languages = [...langCounts].map(([lang, files]) => ({ lang, files })).sort((a, b) => b.files - a.files || (a.lang < b.lang ? -1 : 1)).slice(0, 5);
  const sorted = (s) => [...s].sort();
  return {
    empty: manifests.length === 0 && sourceFiles < 3,
    truncated,
    languages,
    manifests: manifests.sort(),
    stacks: sorted(sets.stacks),
    frameworks: sorted(sets.frameworks),
    infra: sorted(sets.infra),
    tests: sorted(sets.tests),
    data: sorted(sets.data),
    llm: sorted(sets.llm),
    inferredNeeds: sorted(sets.needs),
    capabilityHints: sorted(sets.caps),
    platforms: sorted(sets.platforms),
    size: { files: files.length },
    agents: { configured: sorted(sets.agents), skills: sorted(sets.skills) },
  };
}

const list = (arr, max = 10) => (arr.length ? arr.slice(0, max).join(", ") + (arr.length > max ? ` +${arr.length - max}` : "") : "none");

export function formatFingerprint(fp) {
  if (fp.empty) {
    return "Project fingerprint: No project detected (empty folder, home directory or filesystem root).\nAsk the user what they are building before recommending.";
  }
  const lines = [
    "Project fingerprint (local scan, code not read or sent):",
    `- Languages: ${fp.languages.map((l) => `${l.lang} ${l.files}`).join(", ") || "none"}`,
    `- Stacks: ${list(fp.stacks, 14)}${fp.platforms?.length ? ` | Platforms: ${fp.platforms.join(", ")}` : ""}`,
    `- Frameworks: ${list(fp.frameworks)}`,
    `- Tests: ${list(fp.tests)} | Data: ${list(fp.data)} | LLM SDKs: ${list(fp.llm)}`,
    `- Infra: ${list(fp.infra)}`,
    `- Inferred needs: ${list(fp.inferredNeeds, 14)}${fp.capabilityHints?.length ? ` (evidence: ${list(fp.capabilityHints, 6)})` : ""}`,
    `- Size: ${fp.size.files}${fp.truncated ? "+" : ""} files | Agent config: ${list(fp.agents.configured)}${fp.agents.skills.length ? ` (skills: ${list(fp.agents.skills, 8)})` : ""}`,
  ];
  const text = lines.join("\n");
  return text.length <= 1400 ? text : text.slice(0, 1399) + "…";
}
