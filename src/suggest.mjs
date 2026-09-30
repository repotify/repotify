// Suggesting a repository for the catalog: a pre-filled submission form that the user reviews and sends on GitHub.
// Nothing is sent from here. A local repository is scanned first, so a skill the gate would reject gets fixed before
// anyone spends time on it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { readTree, scanFiles } from "./scan/index.mjs";
import { readJsonSafe } from "./util.mjs";

export const SUBMISSION_FORM = "https://github.com/repotify/repotify/issues/new";
// Option labels of .github/ISSUE_TEMPLATE/catalog_submission.yml; a pre-filled dropdown must match one exactly.
export const KINDS = { skill: "Skill (SKILL.md)", plugin: "Plugin (several skills)", mcp: "MCP server", tool: "Tool (CLI or app)" };
const MAX_WHY = 600;
const SKIP = new Set(["node_modules", "dist", "build", "vendor", "test", "tests", "fixtures"]);
// GitHub owners start with a letter or digit (at most 39 characters); repository names may also hold "_" and ".".
const OWNER = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const NAME = "[A-Za-z0-9_.-]+";

// owner/repo (and a folder inside it) from a GitHub URL, an SSH remote or "owner/repo".
export function parseGitHubRepo(text) {
  const t = String(text ?? "").trim();
  const https = new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER})/(${NAME}?)(?:\\.git)?(?:/tree/([^/\\s]+)(?:/(\\S+?))?)?/?$`).exec(t);
  const ssh = new RegExp(`^(?:ssh://)?git@github\\.com[:/](${OWNER})/(${NAME}?)(?:\\.git)?/?$`).exec(t);
  const short = new RegExp(`^(${OWNER})/(${NAME})$`).exec(t);
  const m = https ?? ssh ?? short;
  if (!m || m[2] === "." || m[2] === "..") return null;
  const [owner, repo, ref = null, path = null] = [m[1], m[2], https?.[3], https?.[4]];
  const url = `https://github.com/${owner}/${repo}${ref ? `/tree/${ref}${path ? `/${path}` : ""}` : ""}`;
  return { owner, repo, ref, path, url };
}

// The origin remote of a local clone, read from .git/config (no git process needed).
export function originOf(dir) {
  let config;
  try {
    config = readFileSync(join(dir, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  let section = "";
  for (const line of config.split("\n")) {
    const head = /^\s*\[(.+)\]\s*$/.exec(line);
    if (head) section = head[1].trim();
    const kv = /^\s*url\s*=\s*(\S+)/.exec(line);
    if (kv && section === 'remote "origin"') return parseGitHubRepo(kv[1]);
  }
  return null;
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Folders holding a SKILL.md: the root, its sub-folders and skills/*; hidden folders (an agent's own installed
// skills) and build or test folders are not the repository's product.
export function skillFolders(dir) {
  const found = [];
  const check = (rel) => existsSync(join(dir, rel, "SKILL.md")) && found.push(rel);
  const subdirs = (rel) => {
    try {
      return readdirSync(join(dir, rel), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)).map((e) => (rel ? `${rel}/${e.name}` : e.name));
    } catch {
      return [];
    }
  };
  check("");
  for (const sub of subdirs("")) {
    check(sub);
    if (sub === "skills" || sub.endsWith("/skills")) for (const s of subdirs(sub)) check(s);
  }
  return [...new Set(found)].sort();
}

function licenseOf(dir, pkg) {
  if (typeof pkg?.license === "string") return pkg.license;
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8").slice(0, 400);
    } catch {
      continue;
    }
    const m = /\b(MIT|Apache License|BSD|GNU (?:Affero |Lesser )?General Public License|Mozilla Public License|ISC)\b/i.exec(text);
    if (!m) return "";
    const known = { mit: "MIT", "apache license": "Apache-2.0", bsd: "BSD", isc: "ISC", "mozilla public license": "MPL-2.0" };
    return known[m[1].toLowerCase()] ?? m[1];
  }
  return "";
}

function kindOf(dir, skills, pkg) {
  if (existsSync(join(dir, ".claude-plugin", "plugin.json")) || skills.length > 1) return "plugin";
  if (skills.length === 1) return "skill";
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  let pyproject = "";
  try {
    pyproject = readFileSync(join(dir, "pyproject.toml"), "utf8");
  } catch {
    // Not a Python project.
  }
  if (deps["@modelcontextprotocol/sdk"] || /["']mcp(?:\[[^\]]*\])?\s*[<>=~!"']/.test(pyproject)) return "mcp";
  return "tool";
}

function descriptionOf(dir, skills, pkg) {
  if (skills.length === 1) {
    try {
      const fm = parseFrontmatter(readFileSync(join(dir, skills[0], "SKILL.md"), "utf8"));
      if (fm.description) return String(fm.description).replace(/\s+/g, " ").trim();
    } catch {
      // Fall through to the package description.
    }
  }
  return typeof pkg?.description === "string" ? pkg.description : "";
}

// Everything the form needs from a local repository, plus a security scan of its skill folders.
export async function inspectLocal(dir) {
  const pkg = readJsonSafe(join(dir, "package.json")).value;
  const skills = skillFolders(dir);
  const scans = [];
  for (const rel of skills) {
    try {
      const r = scanFiles(await readTree(rel ? join(dir, rel) : dir, { maxFiles: 400, maxBytes: 30 * 1024 * 1024 }));
      scans.push({ folder: rel || ".", level: r.level, findings: r.findings.filter((f) => f.severity === "critical" || f.severity === "high").slice(0, 3) });
    } catch (error) {
      scans.push({ folder: rel || ".", level: "caution", findings: [{ rule: "not-scanned", severity: "high", file: rel || ".", excerpt: error.message }] });
    }
  }
  const order = ["verified", "caution", "quarantined", "rejected"];
  const level = scans.reduce((worst, s) => (order.indexOf(s.level) > order.indexOf(worst) ? s.level : worst), "verified");
  return { origin: originOf(dir), skills, kind: kindOf(dir, skills, pkg), description: descriptionOf(dir, skills, pkg), license: licenseOf(dir, pkg), scan: { level, scans } };
}

const enc = encodeURIComponent;

export function submissionUrl({ repo, kind, why, license, own }) {
  const text = [why?.trim(), own ? "Submitted by its author." : ""].filter(Boolean).join("\n\n").slice(0, MAX_WHY);
  const fields = { template: "catalog_submission.yml", title: `[Submission]: ${repo.owner}/${repo.repo}`, repository: repo.url, kind: KINDS[kind], why: text, license: license || "" };
  return `${SUBMISSION_FORM}?${Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v)}`).join("&")}`;
}

// Builds the suggestion for a local folder or a GitHub URL. Blocks it when the local scan says the gate would reject.
export async function buildSuggestion({ cwd, target, kind, why, license, own = true }) {
  const asRepo = target ? parseGitHubRepo(target) : null;
  const localDir = !target ? cwd : isDir(join(cwd, target)) ? join(cwd, target) : null;
  if (target && !asRepo && !localDir) return { ok: false, code: "not-found", error: `Not a folder or a GitHub repository: ${target}` };
  const local = localDir ? await inspectLocal(localDir) : null;
  const repo = asRepo && !localDir ? asRepo : local?.origin;
  if (!repo) return { ok: false, code: "no-github", error: "No GitHub repository found. Push it to GitHub first, or pass its URL: repotify suggest https://github.com/owner/repo" };
  if (kind && !KINDS[kind]) return { ok: false, code: "bad-kind", error: `Unknown kind: ${kind}. Use one of: ${Object.keys(KINDS).join(", ")}` };
  const scan = local?.scan ?? null;
  if (scan && (scan.level === "rejected" || scan.level === "quarantined")) {
    return { ok: false, code: "blocked", error: `The catalog gate would reject this (${scan.level}). Fix these first, then run repotify suggest again.`, repo, scan };
  }
  const chosenKind = kind ?? local?.kind ?? "skill";
  const description = why ?? local?.description ?? "";
  const lic = license ?? local?.license ?? "";
  return { ok: true, repo, kind: chosenKind, description, license: lic, scan, url: submissionUrl({ repo, kind: chosenKind, why: description, license: lic, own }) };
}

export function formatSuggestion(s) {
  if (!s.ok) {
    const lines = [s.error];
    for (const sc of s.scan?.scans ?? []) for (const f of sc.findings) lines.push(`  ${f.severity} ${f.rule} ${sc.folder === "." ? "" : sc.folder + "/"}${f.file}${f.line ? ":" + f.line : ""}`);
    return lines.join("\n");
  }
  const scanLine = s.scan
    ? `Local security scan: ${s.scan.level} (${s.scan.scans.length} skill folder${s.scan.scans.length === 1 ? "" : "s"})`
    : "Not scanned locally; the catalog gate scans it after you submit.";
  return [
    `Suggestion: ${s.repo.owner}/${s.repo.repo} (${KINDS[s.kind]}${s.license ? `, ${s.license}` : ", license not found"})`,
    scanLine,
    ...(s.license ? [] : ["Add a LICENSE file first: items without a recognizable license are declined."]),
    "Nothing was sent. Open this link, check the form and submit it on GitHub:",
    s.url,
  ].join("\n");
}
