import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENTS, skillTargets } from "./agents.mjs";
import { readLock, writeLock } from "./lock.mjs";
import { scanFiles } from "./scan/index.mjs";
import { safeRelPath, sha256, compareSemver } from "./util.mjs";
import { applyMcp, mcpSnippet, removeMcp, agentForMcpFile } from "./mcpconfig.mjs";

export const RAW_BASE = "https://raw.githubusercontent.com";
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

export class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function rawUrl(item, file, base = RAW_BASE) {
  const prefix = item.path ? `${item.path.replace(/\/$/, "")}/` : "";
  return `${base.replace(/\/$/, "")}/${item.repo}/${item.commit}/${prefix}${file.path}`;
}

// Skill folders an item occupies inside one agent skills directory.
function folderNames(item) {
  if (item.type !== "plugin") return [item.id];
  return [...new Set(item.files.map((f) => f.path.split("/")[0]))];
}

function targetsFor(item, agents) {
  return skillTargets(agents).flatMap((dir) => folderNames(item).map((name) => `${dir}/${name}`));
}

async function download(item, { fetchImpl, rawBase }) {
  const files = [];
  for (const f of item.files) {
    const url = rawUrl(item, f, rawBase);
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    } catch (error) {
      throw new InstallError("DOWNLOAD", `Could not download ${f.path}: ${error.message}`);
    }
    if (!res.ok) throw new InstallError("DOWNLOAD", `Could not download ${f.path}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new InstallError("DOWNLOAD", `${f.path} is larger than 5 MB`);
    if (sha256(buf) !== f.sha256) throw new InstallError("INTEGRITY", `Hash mismatch for ${f.path}: the upstream file changed since it was scanned`);
    files.push({ path: f.path, content: buf });
  }
  return files;
}

// Writes `files` into `dir`, which must not exist yet.
function writeTree(dir, files) {
  for (const f of files) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }
}

// A reviewer approved this exact commit (pipeline/reviewed.json). The approval covers only the findings recorded in the
// catalog entry: a high finding the reviewer never saw still blocks, and a critical one never reaches this point.
function reviewedFindingsOnly(item, scan) {
  if (!item.security?.review || item.security.level !== "caution") return false;
  const key = (f) => `${f.rule}|${f.file}|${f.line}`;
  const recorded = new Set((item.security.findings ?? []).map(key));
  return scan.findings.filter((f) => f.severity === "high").every((f) => recorded.has(key(f)));
}

export async function installSkill(item, opts) {
  const { cwd, agents, fetchImpl = fetch, now = new Date(), acceptCaution = false, catalogVersion = null } = opts;
  const rawBase = opts.rawBase ?? process.env.REPOTIFY_RAW_BASE ?? RAW_BASE;
  for (const f of item.files ?? []) {
    if (safeRelPath(f.path) !== f.path) throw new InstallError("UNSAFE_PATH", `Refusing unsafe path in catalog: ${f.path}`);
  }
  if (item.security?.level === "caution" && !acceptCaution) {
    throw new InstallError("CONSENT_REQUIRED", `${item.id} is marked caution; re-run with --accept-caution after reviewing its findings`);
  }
  const lock = readLock(cwd);
  const targets = targetsFor(item, agents);
  for (const t of targets) {
    if (existsSync(join(cwd, t)) && !(lock.items[item.id]?.targets ?? []).includes(t)) {
      throw new InstallError("TARGET_EXISTS", `${t} already exists and was not installed by Repotify; leaving it untouched`);
    }
  }

  const files = await download(item, { fetchImpl, rawBase });
  const staging = mkdtempSync(join(tmpdir(), "repotify-stage-"));
  try {
    writeTree(join(staging, "item"), files);
    // Scan exactly what was downloaded (a directory walk would skip node_modules/ and .git/).
    const scan = scanFiles(files.map((f) => ({ path: f.path, content: f.content, size: f.content.length })));
    if (scan.level === "rejected" || (scan.level === "quarantined" && !reviewedFindingsOnly(item, scan))) {
      const top = scan.findings.find((f) => f.severity === "critical" || f.severity === "high");
      throw new InstallError("BLOCKED", `${item.id} failed the local security re-scan (${scan.level}: ${top?.rule} in ${top?.file})`);
    }
    if (scan.level === "caution" && item.security?.level !== "caution" && !acceptCaution) {
      throw new InstallError("CONSENT_REQUIRED", `${item.id} has caution findings on re-scan; re-run with --accept-caution`);
    }
    for (const t of targets) {
      const folder = t.split("/").pop();
      const src = item.type === "plugin" ? join(staging, "item", folder) : join(staging, "item");
      const dest = join(cwd, t);
      // Staged next to the agent folder, not inside skills/, so a crash never leaves a loadable duplicate.
      const incoming = join(cwd, dirname(dirname(t)), ".repotify-staging", t.split("/").pop());
      rmSync(incoming, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      mkdirSync(dirname(incoming), { recursive: true });
      cpSync(src, incoming, { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      renameSync(incoming, dest);
      removeEmptyStaging(dirname(incoming));
    }
    const entry = {
      type: item.type,
      repo: item.repo,
      path: item.path ?? "",
      commit: item.commit,
      files: item.files.map(({ path, sha256: h }) => ({ path, sha256: h })),
      targets,
      agents,
      installedAt: now.toISOString(),
      catalogVersion,
      level: scan.level === "verified" ? item.security?.level ?? "verified" : scan.level,
    };
    lock.items[item.id] = entry;
    if (catalogVersion) lock.catalogVersion = catalogVersion;
    writeLock(cwd, lock);
    return entry;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Package guard (a `config` item): standalone hook file + Claude Code settings entry.

const GUARD_SOURCE = fileURLToPath(new URL("./guard.mjs", import.meta.url));
export const GUARD_HOOK_PATH = ".claude/hooks/repotify-guard.mjs";
const GUARD_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/repotify-guard.mjs"';
const isGuardEntry = (entry) => (entry?.hooks ?? []).some((h) => String(h.command ?? "").includes("repotify-guard.mjs"));

export function readSettings(cwd) {
  const path = join(cwd, ".claude", "settings.json");
  if (!existsSync(path)) return { ok: true, path, value: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8").replace(/^\u{FEFF}/u, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, path, value } : { ok: false, path };
  } catch {
    return { ok: false, path };
  }
}

export function installGuard({ cwd }) {
  const settings = readSettings(cwd);
  if (!settings.ok) return { written: false, reason: "unparseable", file: ".claude/settings.json" };
  mkdirSync(join(cwd, ".claude", "hooks"), { recursive: true });
  copyFileSync(GUARD_SOURCE, join(cwd, GUARD_HOOK_PATH));
  const cfg = settings.value;
  cfg.hooks = cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {};
  const pre = Array.isArray(cfg.hooks.PreToolUse) ? cfg.hooks.PreToolUse : [];
  if (!pre.some(isGuardEntry)) pre.push({ matcher: "Bash", hooks: [{ type: "command", command: GUARD_COMMAND, timeout: 30 }] });
  cfg.hooks.PreToolUse = pre;
  writeFileSync(settings.path, JSON.stringify(cfg, null, 2) + "\n");
  return { written: true, targets: [GUARD_HOOK_PATH, ".claude/settings.json#hooks.PreToolUse"] };
}

export function removeGuard({ cwd }) {
  rmSync(join(cwd, GUARD_HOOK_PATH), { force: true });
  const settings = readSettings(cwd);
  if (!settings.ok || !existsSync(settings.path)) return;
  const cfg = settings.value;
  if (Array.isArray(cfg.hooks?.PreToolUse)) {
    cfg.hooks.PreToolUse = cfg.hooks.PreToolUse.filter((e) => !isGuardEntry(e));
    if (!cfg.hooks.PreToolUse.length) delete cfg.hooks.PreToolUse;
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  }
  writeFileSync(settings.path, JSON.stringify(cfg, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// One entry point for every item type. Tools are only described, never executed.

function recordLock(cwd, id, entry, catalogVersion) {
  const lock = readLock(cwd);
  lock.items[id] = entry;
  if (catalogVersion) lock.catalogVersion = catalogVersion;
  writeLock(cwd, lock);
}

// The staging folder is only a waypoint; leave nothing behind in the user's project once it is empty.
function removeEmptyStaging(dir) {
  try {
    rmdirSync(dir);
  } catch {
    // Not empty (another install in progress) or already gone.
  }
}

// Local scan of an MCP server's setup steps and command line, before anything is written (install and update).
export function checkMcpSetup(item) {
  const m = item.setup?.mcp ?? {};
  const setupScan = scanFiles([{ path: "setup.sh", content: [...(item.setup?.steps ?? []), [m.command, ...(m.args ?? [])].join(" ")].join("\n") + "\n" }]);
  if (setupScan.level === "rejected" || setupScan.level === "quarantined") {
    throw new InstallError("BLOCKED", `${item.id}: its MCP command failed the local security scan (${setupScan.findings[0]?.rule})`);
  }
}

export async function installItem(item, opts) {
  const { cwd, agents, confirm = false, now = new Date(), catalogVersion = null } = opts;
  if (item.type === "skill" || item.type === "plugin") {
    const entry = await installSkill(item, opts);
    return { type: item.type, written: true, entry };
  }
  if (item.type === "tool") {
    return { type: "tool", written: false, executed: false, steps: item.setup?.steps ?? [], verify: item.setup?.verify ?? null };
  }
  if (item.security?.level === "caution" && !opts.acceptCaution && confirm) {
    throw new InstallError("CONSENT_REQUIRED", `${item.id} is marked caution; re-run with --accept-caution after reviewing its findings`);
  }
  if (item.type === "mcp") {
    checkMcpSetup(item);
    const mcpAgents = agents.filter((a) => AGENTS[a]?.mcp);
    const steps = item.setup?.steps ?? [];
    if (!confirm) return { type: "mcp", written: false, steps, snippets: mcpAgents.map((a) => ({ agent: a, ...mcpSnippet(item, a) })) };
    const results = mcpAgents.map((a) => ({ agent: a, ...applyMcp(item, a, { cwd }) }));
    const targets = results.filter((r) => r.written).map((r) => r.target);
    if (targets.length) {
      recordLock(cwd, item.id, { type: "mcp", repo: item.repo ?? null, targets, agents: mcpAgents, installedAt: now.toISOString(), catalogVersion, level: item.security?.level ?? "verified", setup: item.setup }, catalogVersion);
    }
    return { type: "mcp", written: targets.length > 0, steps, results };
  }
  if (item.type === "config" && item.id === "repotify-guard") {
    if (!confirm) return { type: "config", written: false, preview: `Adds ${GUARD_HOOK_PATH} and a PreToolUse hook in .claude/settings.json` };
    const r = installGuard({ cwd });
    if (r.written) recordLock(cwd, item.id, { type: "config", repo: null, targets: r.targets, agents: ["claude-code"], installedAt: now.toISOString(), catalogVersion, level: "verified" }, catalogVersion);
    return { type: "config", ...r };
  }
  throw new InstallError("UNSUPPORTED", `Don't know how to install ${item.type} item ${item.id}`);
}

// Lock targets are only trusted when they look like "<agent skills dir>/<one folder>".
function isSkillTarget(t) {
  if (safeRelPath(t) !== t) return false;
  return [...new Set(Object.values(AGENTS).map((a) => a.skillsDir))].some((d) => t.startsWith(d + "/") && !t.slice(d.length + 1).includes("/"));
}

export function removeItem(id, { cwd }) {
  const lock = readLock(cwd);
  const entry = lock.items[id];
  if (!entry) throw new InstallError("NOT_INSTALLED", `${id} was not installed by Repotify`);
  if (entry.type === "mcp") {
    for (const t of entry.targets ?? []) {
      const agent = agentForMcpFile(t.split("#")[0]);
      if (agent) removeMcp(id, agent, { cwd });
    }
  } else if (entry.type === "config") {
    removeGuard({ cwd });
  } else {
    for (const t of entry.targets ?? []) if (isSkillTarget(t)) rmSync(join(cwd, t), { recursive: true, force: true });
  }
  delete lock.items[id];
  writeLock(cwd, lock);
  return entry;
}

// ---------------------------------------------------------------------------
// Self-install: copy this package's own skill into each agent's skills folder.

export const SELF_SKILL_DIR = fileURLToPath(new URL("../skill/repotify/", import.meta.url));

function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile() || e.isSymbolicLink()) out.push(rel);
  }
  return out.sort();
}

function treeHash(dir) {
  if (!existsSync(dir)) return null;
  try {
    return sha256(listFiles(dir).map((f) => {
      const full = join(dir, f);
      // A symlink is hashed by its target string and never followed.
      if (lstatSync(full).isSymbolicLink()) return `${f}:link:${readlinkSync(full)}`;
      return `${f}:${sha256(readFileSync(full))}`;
    }).join("\n"));
  } catch {
    return null;
  }
}

export function installSelf({ cwd, agents, version, now = new Date(), sourceDir = SELF_SKILL_DIR, launcher = null }) {
  const lock = readLock(cwd);
  const managed = lock.items.repotify?.targets ?? [];
  const wanted = treeHash(sourceDir);
  if (wanted === null) {
    // The skill source is unreadable: never report "up to date" for something that was not verified.
    throw new InstallError("SOURCE_MISSING", `Cannot install the repotify skill: the source folder is missing or unreadable (${sourceDir})`);
  }
  const result = { installed: [], upToDate: [], untouched: [] };
  // Never let an older Repotify overwrite the skill written by a newer one.
  const newerInstalled = lock.items.repotify?.version && compareSemver(lock.items.repotify.version, version) > 0;
  for (const dir of skillTargets(agents)) {
    const t = `${dir}/repotify`;
    const dest = join(cwd, t);
    if (existsSync(dest) && !managed.includes(t)) {
      result.untouched.push(t);
      continue;
    }
    if (treeHash(dest) === wanted || (newerInstalled && existsSync(dest))) {
      result.upToDate.push(t);
      continue;
    }
    const incoming = join(cwd, dirname(dirname(t)), ".repotify-staging", "repotify");
    rmSync(incoming, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    mkdirSync(dirname(incoming), { recursive: true });
    cpSync(sourceDir, incoming, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(incoming, dest);
    removeEmptyStaging(dirname(incoming));
    result.installed.push(t);
  }
  const targets = [...new Set([...managed, ...result.installed, ...result.upToDate])];
  const previous = lock.items.repotify;
  if (newerInstalled && !result.installed.length) {
    // The newer copy's version and launcher stay on record, so the next run of this older copy is refused too.
    if (targets.length !== managed.length) {
      lock.items.repotify = { ...previous, targets };
      writeLock(cwd, lock);
    }
    return result;
  }
  if (result.installed.length || !previous || (launcher && previous.launcher !== launcher)) {
    lock.items.repotify = { type: "self", version, targets, installedAt: now.toISOString(), contentHash: wanted, launcher: launcher ?? previous?.launcher ?? null };
    writeLock(cwd, lock);
  }
  return result;
}

export { AGENTS };
