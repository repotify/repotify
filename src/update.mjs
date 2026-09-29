// Update flow: catalog is always fresh; installed third-party items stay locked until the
// user approves a scanned update; Repotify's own skill refreshes itself.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkMcpSetup, installItem, installSelf, readSettings, SELF_SKILL_DIR } from "./install.mjs";
import { readLock, writeLock } from "./lock.mjs";
import { NPX_LAUNCHER } from "./config.mjs";
import { agentForMcpFile, applyMcp, mcpConfigWritable } from "./mcpconfig.mjs";

// Replaces an installed MCP server in place. Consent and config checks happen before anything is written.
function updateMcp(id, entry, item, { cwd, acceptCaution, now, catalogVersion }) {
  if (item.security?.level === "caution" && !acceptCaution) throw new Error(`${id} is marked caution; re-run with --accept-caution after reviewing its findings`);
  checkMcpSetup(item);
  // Older locks may lack `agents`; the config files recorded as targets say which agents have the server.
  const fromTargets = (entry.targets ?? []).map((t) => agentForMcpFile(String(t).split("#")[0])).filter(Boolean);
  const agents = entry.agents?.length ? entry.agents : [...new Set(fromTargets)];
  if (!agents.length) throw new Error(`${id}: the lock does not say which MCP config holds it; remove and install it again`);
  for (const a of agents) {
    const w = mcpConfigWritable(a, { cwd });
    if (!w.ok) throw new Error(`${w.file ?? a}: ${w.reason}; update it by hand`);
  }
  const results = agents.map((a) => applyMcp(item, a, { cwd, replace: true }));
  const failed = results.find((r) => !r.written);
  if (failed) throw new Error(`${failed.file}: ${failed.reason}`);
  const lock = readLock(cwd);
  lock.items[id] = { ...entry, agents, setup: item.setup, level: item.security?.level ?? entry.level, updatedAt: now.toISOString(), catalogVersion };
  writeLock(cwd, lock);
}

const DAY = 86400000;
const PUBLISHABLE = ["verified", "caution"];
const AUTO_CHECK_ARGS = "update --check --quiet --weekly";

export function checkUpdates({ lock, catalog }) {
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const items = [];
  const removedFromCatalog = [];
  for (const [id, entry] of Object.entries(lock.items ?? {})) {
    if (entry.type === "self" || entry.type === "config") continue;
    const item = byId.get(id);
    if (!item || !PUBLISHABLE.includes(item.security?.level)) {
      removedFromCatalog.push(id);
      continue;
    }
    if ((entry.type === "skill" || entry.type === "plugin") && item.commit && item.commit !== entry.commit) {
      items.push({ id, fromCommit: entry.commit, toCommit: item.commit, level: item.security.level });
    } else if (entry.type === "mcp" && JSON.stringify(item.setup?.mcp ?? null) !== JSON.stringify(entry.setup?.mcp ?? null)) {
      items.push({ id, fromCommit: (entry.setup?.mcp?.args ?? []).join(" "), toCommit: (item.setup?.mcp?.args ?? []).join(" "), level: item.security.level });
    }
  }
  return { items, removedFromCatalog };
}

export async function applyUpdates(ids, { cwd, catalog, fetchImpl = fetch, acceptCaution = false, now = new Date() }) {
  const results = [];
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  for (const id of ids) {
    const entry = readLock(cwd).items[id];
    const item = byId.get(id);
    if (!entry || !item || !PUBLISHABLE.includes(item.security?.level)) {
      results.push({ id, ok: false, error: !entry ? "not installed by Repotify" : "not in the catalog" });
      continue;
    }
    try {
      if (entry.type === "mcp") updateMcp(id, entry, item, { cwd, acceptCaution, now, catalogVersion: catalog.meta?.version ?? null });
      else await installItem(item, { cwd, agents: entry.agents ?? ["claude-code"], confirm: true, acceptCaution, fetchImpl, now, catalogVersion: catalog.meta?.version ?? null });
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error.message });
    }
  }
  return results;
}

export function selfUpdateSkill({ cwd, agents, version, sourceDir = SELF_SKILL_DIR, now = new Date() }) {
  const from = readLock(cwd).items.repotify?.version ?? null;
  const r = installSelf({ cwd, agents, version, sourceDir, now });
  return { updated: r.installed.length > 0, from, to: version };
}

export function weeklyCheckDue(config, now = new Date()) {
  return !config.lastUpdateCheckAt || now - new Date(config.lastUpdateCheckAt) >= 7 * DAY;
}

// Optional: a light weekly check when a Claude Code session starts (the user opts in).
export function enableAutoCheck({ cwd, launcher = NPX_LAUNCHER }) {
  const settings = readSettings(cwd);
  if (!settings.ok) return { written: false, reason: "unparseable" };
  const cfg = settings.value;
  cfg.hooks = cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {};
  const list = Array.isArray(cfg.hooks.SessionStart) ? cfg.hooks.SessionStart : [];
  if (!list.some((e) => (e.hooks ?? []).some((h) => String(h.command ?? "").includes(AUTO_CHECK_ARGS)))) {
    list.push({ hooks: [{ type: "command", command: `${launcher} ${AUTO_CHECK_ARGS}`, timeout: 60 }] });
  }
  cfg.hooks.SessionStart = list;
  mkdirSync(dirname(settings.path), { recursive: true });
  writeFileSync(settings.path, JSON.stringify(cfg, null, 2) + "\n");
  return { written: true };
}
