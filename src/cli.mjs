import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanDir } from "./scan/index.mjs";
import { fingerprint, formatFingerprint } from "./fingerprint.mjs";
import { questionBank, formatQuestions, resolveNeeds } from "./needs.mjs";
import { recommend, formatTable } from "./recommend.mjs";
import { loadCatalog, BUNDLED_DIR } from "./catalog.mjs";
import { catalogUrl, homeDir, NPX_LAUNCHER } from "./config.mjs";
import { readJsonSafe } from "./util.mjs";
import { detectAgents, parseAgentList, skillTargets } from "./agents.mjs";
import { installItem, removeItem, installSelf } from "./install.mjs";
import { runHook, parseInstallCommands } from "./guard.mjs";
import { createTelemetry, NOTICE } from "./telemetry.mjs";
import { voteDue, keptEvents } from "./feedback.mjs";
import { checkUpdates, applyUpdates, selfUpdateSkill, enableAutoCheck, weeklyCheckDue } from "./update.mjs";
import { AGENTS } from "./agents.mjs";
import { readConfig, writeConfig } from "./config.mjs";
import { readLock } from "./lock.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = pkg.version;

// Minimal argv parser: positionals, `--flag`, `--key value`, `--key=value`.
export function parseArgv(argv, valueFlags = []) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (valueFlags.includes(a.slice(2)) && i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a === "-v") {
      flags.version = true;
    } else if (a === "-h") {
      flags.help = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const BIN_PATH = fileURLToPath(new URL("../bin/repotify.mjs", import.meta.url));

// How this copy of Repotify was started, so the skill and hooks call the same code again.
// A clone is referenced by its absolute path; an npx run by the published package name.
// Decided by where this file lives: npm_command and similar variables leak into children of any npx run.
export function detectLauncher(binPath = BIN_PATH) {
  const parts = binPath.split(/[\\/]/);
  if (parts.includes("_npx") || parts.includes("node_modules")) return NPX_LAUNCHER;
  return `node "${binPath}"`;
}

const VALUE_FLAGS = ["agent", "needs", "type", "priorities", "budget", "answers", "apply"];
const out = (io, text) => io.stdout.write(text.endsWith("\n") ? text : text + "\n");
const err = (io, text) => io.stderr.write(text.endsWith("\n") ? text : text + "\n");
const csv = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function telemetry(io) {
  return createTelemetry({ env: io.env ?? {}, fetchImpl: io.fetchImpl ?? fetch, version: VERSION });
}

// Queues anonymous events and flushes; flushing is a no-op while no endpoint is configured.
async function track(io, events) {
  const t = telemetry(io);
  if (!t.enabled) return;
  let agent = "unknown";
  try {
    agent = detectAgents({ env: io.env ?? {}, cwd: io.cwd })[0] ?? "unknown";
  } catch {
    // Detection problems never block the command.
  }
  for (const e of events) t.track({ agent, ...e });
  await t.flush();
}

function bundledTaxonomy() {
  return readJsonSafe(resolve(BUNDLED_DIR, "taxonomy.json")).value;
}

export async function getCatalog(io, flags = {}) {
  const env = io.env ?? {};
  return loadCatalog({
    url: catalogUrl(env),
    cacheDir: join(homeDir(env), "cache", "catalog"),
    fetchImpl: io.fetchImpl ?? fetch,
    offline: Boolean(flags.offline) || env.REPOTIFY_OFFLINE === "1",
  });
}

function answersFrom(flags) {
  let answers = {};
  if (typeof flags.answers === "string") {
    try {
      answers = JSON.parse(flags.answers);
    } catch {
      answers = {};
    }
  }
  if (flags.type) answers.projectType = flags.type;
  if (flags.needs) answers.needs = [...(answers.needs ?? []), ...csv(flags.needs)];
  if (flags.priorities) answers.priorities = [...(answers.priorities ?? []), ...csv(flags.priorities)];
  return answers;
}

async function cmdFingerprint(args, io) {
  const fp = await fingerprint(io.cwd);
  out(io, args.flags.json ? JSON.stringify(fp, null, 2) : formatFingerprint(fp));
  return 0;
}

async function cmdQuestions(args, io) {
  const qs = questionBank(bundledTaxonomy(), await fingerprint(io.cwd));
  out(io, args.flags.json ? JSON.stringify(qs, null, 2) : formatQuestions(qs));
  return 0;
}

async function cmdRecommend(args, io) {
  const { catalog, notice } = await getCatalog(io, args.flags);
  const fp = await fingerprint(io.cwd);
  const resolved = resolveNeeds({ fingerprint: fp, answers: answersFrom(args.flags), taxonomy: catalog.taxonomy });
  const budget = Number(args.flags.budget) > 0 ? Number(args.flags.budget) : undefined;
  const installed = Object.keys(readJsonSafe(join(io.cwd, "repotify.lock.json")).value?.items ?? {});
  const rec = recommend({ catalog, fingerprint: fp, needs: resolved, installed, ...(budget ? { budgetChars: budget } : {}) });
  await track(io, [{ type: "shown", items: rec.rows.map((r) => r.id), stacks: fp.stacks, needs: resolved.needs, projectType: resolved.projectType, catalogVersion: catalog.meta.version }]);
  if (args.flags.json) {
    out(io, JSON.stringify({ ...rec, projectType: resolved.projectType, needs: resolved.needs, catalogVersion: catalog.meta.version, notice: notice ?? null }, null, 2));
  } else {
    if (notice) out(io, notice);
    out(io, formatTable(rec));
  }
  return 0;
}

function agentsFrom(flags, io) {
  return flags.agent ? parseAgentList(flags.agent) : detectAgents({ env: io.env ?? {}, cwd: io.cwd });
}

const MAX_INSTALL_SUMMARY = 1050;

function summaryLine(r) {
  if (!r.ok) return `✗ ${r.id}: ${r.error}`;
  const warn = r.level === "caution" ? " ⚠ caution" : "";
  if (r.type === "tool") return `• ${r.id} (tool, run it yourself${warn}): ${r.steps.map((s, i) => `${i + 1}) ${s}`).join(" ")}${r.verify ? ` | verify: ${r.verify}` : ""}`;
  if (r.type === "mcp") {
    const next = (r.steps ?? []).filter((s) => !/MCP config/i.test(s));
    if (r.written) return `✓ ${r.id} → ${r.results.filter((x) => x.written).map((x) => x.file).join(", ")}${warn}${next.length ? ` (next: ${next.join("; ")})` : ""}`;
    if (r.results) return `• ${r.id} (mcp): ${r.results.map((x) => `${x.file}: ${x.reason}`).join("; ")}`;
    return `• ${r.id} (mcp): re-run with --yes to write ${r.snippets.map((x) => x.file).join(", ")}`;
  }
  if (r.type === "config") return r.written ? `✓ ${r.id} → ${r.targets[0]}` : `• ${r.id}: ${r.preview ? r.preview + " (re-run with --yes)" : r.reason}`;
  return `✓ ${r.id}${r.entry?.level === "caution" ? " ⚠" : ""}`;
}

// Short, line-safe summary for the agent (≈300 tokens max).
export function formatInstallSummary({ agents, results, notice }) {
  const head = [...(notice ? [notice] : []), `Agents: ${agents.join(", ")}`, `Skills folder: ${skillTargets(agents).join(", ")}`];
  const body = results.map(summaryLine);
  const lines = [...head];
  let length = head.join("\n").length;
  for (let i = 0; i < body.length; i++) {
    const tail = `… ${body.length - i} more (use --json)`;
    const room = MAX_INSTALL_SUMMARY - length - 1 - (i < body.length - 1 ? tail.length + 1 : 0);
    if (body[i].length > room) {
      lines.push(tail);
      return lines.join("\n");
    }
    lines.push(body[i]);
    length += body[i].length + 1;
  }
  return lines.join("\n");
}

async function cmdInstall(args, io) {
  const ids = args.positionals.flatMap((p) => p.split(",")).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    err(io, "Usage: repotify install <id...> [--agent claude-code,cursor,codex] [--yes] [--accept-caution]");
    return 2;
  }
  let agents;
  try {
    agents = agentsFrom(args.flags, io);
  } catch (e) {
    err(io, e.message);
    return 2;
  }
  const { catalog, notice } = await getCatalog(io, args.flags);
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const results = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) {
      results.push({ id, ok: false, error: "not in the catalog (only listed ids can be installed)" });
      continue;
    }
    try {
      const r = await installItem(item, {
        cwd: io.cwd, agents, confirm: Boolean(args.flags.yes), acceptCaution: Boolean(args.flags["accept-caution"]),
        fetchImpl: io.fetchImpl ?? fetch, catalogVersion: catalog.meta.version,
      });
      results.push({ id, ok: true, level: item.security?.level, ...r });
    } catch (e) {
      results.push({ id, ok: false, error: e.message, code: e.code ?? null });
    }
  }
  const known = ids.filter((id) => byId.has(id));
  const done = results.filter((r) => r.ok && (r.written || r.type === "tool")).map((r) => r.id);
  await track(io, [
    ...(known.length ? [{ type: "selected", items: known, catalogVersion: catalog.meta.version }] : []),
    ...(done.length ? [{ type: "installed", items: done, catalogVersion: catalog.meta.version }] : []),
  ]);
  if (args.flags.json) out(io, JSON.stringify({ agents, catalogVersion: catalog.meta.version, results }, null, 2));
  else out(io, formatInstallSummary({ agents, results, notice }));
  return results.some((r) => !r.ok) ? 1 : 0;
}

async function cmdRemove(args, io) {
  const id = args.positionals[0];
  if (!id) {
    err(io, "Usage: repotify remove <id>");
    return 2;
  }
  try {
    const entry = removeItem(id, { cwd: io.cwd });
    if (entry.type !== "self") await track(io, [{ type: "removed", items: [id] }]);
    out(io, `Removed ${id} (${(entry.targets ?? []).join(", ")})`);
    return 0;
  } catch (e) {
    err(io, e.message);
    return 1;
  }
}

async function cmdStart(args, io) {
  let agents;
  try {
    agents = agentsFrom(args.flags, io);
  } catch (e) {
    err(io, e.message);
    return 2;
  }
  const fp = await fingerprint(io.cwd);
  if (fp.reason === "home-or-root") {
    out(io, `Repotify ${VERSION}\nThis is your home folder or filesystem root, not a project. Run repotify inside a project folder (or an empty folder for a new project).`);
    return 0;
  }
  const self = installSelf({ cwd: io.cwd, agents, version: VERSION, launcher: detectLauncher() });
  const lines = [`Repotify ${VERSION}`, `Detected agent: ${agents.join(", ")}`];
  if (self.installed.length) lines.push(`Installed the repotify skill: ${self.installed.join(", ")}`);
  if (self.upToDate.length) lines.push(`Repotify skill up to date: ${self.upToDate.join(", ")}`);
  if (self.untouched.length) lines.push(`Existing folder left untouched (not created by Repotify): ${self.untouched.join(", ")}`);
  const t = telemetry(io);
  if (t.noticeNeeded()) {
    lines.push("", NOTICE);
    t.markNoticeShown();
  }
  const env = io.env ?? {};
  const kept = keptEvents(readLock(io.cwd), readConfig(env), new Date());
  await track(io, [{ type: "run", stacks: fp.stacks }, ...kept.events]);
  if (t.enabled && kept.events.length) writeConfig(env, { keptReported: kept.reported });
  lines.push("", formatFingerprint(fp), "");
  lines.push("Next: follow the repotify skill. In short: `repotify questions --json` (only if needed), then `repotify recommend`, then `repotify install <ids> --yes`.");
  out(io, lines.join("\n"));
  return 0;
}

async function cmdGuard(args, io) {
  if (args.flags["self-test"]) {
    const ok = parseInstallCommands("npm i react && pip install requests").length === 2;
    out(io, ok ? "repotify guard ok" : "repotify guard self-test failed");
    return ok ? 0 : 1;
  }
  if (args.flags.hook) {
    let text = "";
    if (io.stdin) for await (const chunk of io.stdin) text += chunk;
    const r = await runHook(text, { fetchImpl: io.fetchImpl ?? fetch });
    if (r.stdout) io.stdout.write(r.stdout);
    if (r.stderr) err(io, r.stderr);
    return r.exitCode;
  }
  err(io, "Usage: repotify guard --hook (reads a Claude Code PreToolUse event on stdin) | --self-test");
  return 2;
}

async function cmdVote(args, io) {
  const env = io.env ?? {};
  if (args.flags.due) {
    out(io, voteDue(readConfig(env), new Date()) ? "due" : "not due");
    return 0;
  }
  if (args.flags.dismiss) {
    writeConfig(env, { lastVoteAskAt: new Date().toISOString() });
    out(io, "OK, not asking again this week.");
    return 0;
  }
  const [id, vote] = args.positionals;
  if (!id || !["up", "down"].includes(vote)) {
    err(io, "Usage: repotify vote <id> up|down | --due | --dismiss");
    return 2;
  }
  if (!readLock(io.cwd).items[id]) {
    err(io, `${id} is not installed in this project; votes are for items you have used`);
    return 1;
  }
  await track(io, [{ type: "vote", item: id, vote }]);
  writeConfig(env, { lastVoteAskAt: new Date().toISOString() });
  out(io, `Thanks! Recorded ${vote === "up" ? "👍" : "👎"} for ${id}.`);
  return 0;
}

async function cmdTelemetry(args, io) {
  const action = args.positionals[0] ?? "status";
  const t = telemetry(io);
  if (action === "off" || action === "on") {
    t.setEnabled(action === "on");
    out(io, `Telemetry ${action}.`);
    return 0;
  }
  if (action !== "status") {
    err(io, "Usage: repotify telemetry [status|on|off]");
    return 2;
  }
  const endpoint = (await import("./config.mjs")).TELEMETRY_ENDPOINT ?? io.env?.REPOTIFY_TELEMETRY_URL ?? null;
  const queued = t.enabled ? (await t.flush()).queued : 0;
  out(io, `Telemetry: ${t.enabled ? "on" : "off"}; ${endpoint ? `endpoint ${endpoint}` : "endpoint not configured (nothing is sent)"}; ${queued} event(s) queued locally.`);
  return 0;
}

function agentsFromTargets(targets) {
  return Object.keys(AGENTS).filter((id) => id !== "generic" && targets.includes(`${AGENTS[id].skillsDir}/repotify`));
}

async function cmdUpdate(args, io) {
  const env = io.env ?? {};
  if (args.flags["enable-auto-check"]) {
    const r = enableAutoCheck({ cwd: io.cwd, launcher: readLock(io.cwd).items.repotify?.launcher ?? detectLauncher() });
    out(io, r.written ? "Weekly update check enabled (Claude Code SessionStart hook)." : `Could not edit .claude/settings.json (${r.reason}); nothing changed.`);
    return r.written ? 0 : 1;
  }
  if (args.flags.apply) {
    const ids = csv(typeof args.flags.apply === "string" ? args.flags.apply : args.positionals.join(","));
    const { catalog } = await getCatalog(io, args.flags);
    const results = await applyUpdates(ids, { cwd: io.cwd, catalog, fetchImpl: io.fetchImpl ?? fetch, acceptCaution: Boolean(args.flags["accept-caution"]) });
    out(io, results.map((r) => (r.ok ? `✓ ${r.id} updated` : `✗ ${r.id}: ${r.error}`)).join("\n") || "Nothing to update.");
    return results.some((r) => !r.ok) ? 1 : 0;
  }
  const now = new Date();
  if (args.flags.weekly && !weeklyCheckDue(readConfig(env), now)) return 0;
  const { catalog, notice } = await getCatalog(io, args.flags);
  const lock = readLock(io.cwd);
  const r = checkUpdates({ lock, catalog });
  const selfTargets = lock.items.repotify?.targets ?? [];
  const self = selfTargets.length ? selfUpdateSkill({ cwd: io.cwd, agents: agentsFromTargets(selfTargets), version: VERSION }) : { updated: false };
  writeConfig(env, { lastUpdateCheckAt: now.toISOString() });
  const lines = [];
  if (r.items.length) {
    lines.push(`${r.items.length} update${r.items.length === 1 ? "" : "s"} available (already security-scanned):`);
    for (const u of r.items) lines.push(`  ${u.id} ${String(u.fromCommit).slice(0, 7)} → ${String(u.toCommit).slice(0, 7)}${u.level === "caution" ? " ⚠ caution" : ""}`);
    lines.push(`Apply with: repotify update --apply ${r.items.map((u) => u.id).join(",")}`);
  }
  for (const id of r.removedFromCatalog) lines.push(`⚠ ${id} is no longer in the catalog (quarantined or removed upstream); consider \`repotify remove ${id}\`.`);
  if (self.updated) lines.push(`Refreshed the repotify skill (${self.from ?? "?"} → ${self.to}).`);
  if (!lines.length) {
    if (args.flags.quiet) return 0;
    lines.push(`Everything is up to date (catalog ${catalog.meta.version}).`);
  }
  if (notice && !args.flags.quiet) lines.unshift(notice);
  out(io, lines.join("\n"));
  return 0;
}

async function cmdScan(args, io) {
  const target = args.positionals[0];
  if (!target) {
    err(io, "Usage: repotify scan <dir> [--json]");
    return 2;
  }
  const dir = resolve(io.cwd, target);
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    err(io, `Not a directory: ${target}`);
    return 2;
  }
  const r = await scanDir(dir);
  if (args.flags.json) {
    out(io, JSON.stringify(r, null, 2));
  } else {
    const shown = r.findings.filter((f) => f.severity !== "low");
    out(io, `${r.level}  ${target}  (${shown.length} finding${shown.length === 1 ? "" : "s"})`);
    for (const f of shown.slice(0, 20)) {
      out(io, `  ${f.severity.padEnd(8)} ${f.rule} ${f.file}${f.line ? ":" + f.line : ""}${f.note ? " (" + f.note + ")" : ""}  ${f.excerpt}`);
    }
    if (shown.length > 20) out(io, `  … ${shown.length - 20} more (use --json)`);
  }
  return r.level === "rejected" || r.level === "quarantined" ? 1 : 0;
}

export const COMMANDS = {
  start: { run: cmdStart, help: "start [--agent a,b]                  Default: install the repotify skill for your agent and summarize the project" },
  fingerprint: { run: cmdFingerprint, help: "fingerprint [--json]                 Summarize this project (local; code is not read)" },
  questions: { run: cmdQuestions, help: "questions [--json]                   Questions to ask only when the answer is unknown" },
  recommend: { run: cmdRecommend, help: "recommend [--type t] [--needs a,b]   Conflict-free candidate table (--json, --budget N)" },
  install: { run: cmdInstall, help: "install <id...> [--yes] [--agent a,b] Install catalog items (hash-checked, re-scanned)" },
  remove: { run: cmdRemove, help: "remove <id>                          Remove an item Repotify installed" },
  scan: { run: cmdScan, help: "scan <dir> [--json]                  Security-scan a skill folder" },
  update: { run: cmdUpdate, help: "update [--check|--apply a,b|--enable-auto-check] Vetted updates for installed items" },
  vote: { run: cmdVote, help: "vote <id> up|down | --due | --dismiss  Rate an installed item (at most weekly)" },
  telemetry: { run: cmdTelemetry, help: "telemetry [status|on|off]           Anonymous usage signals (endpoint currently off)" },
  guard: { run: cmdGuard, help: "guard --hook | --self-test           Package guard (Claude Code PreToolUse hook)" },
};

// Entry point for bin/: an unexpected error becomes one line on stderr; the stack only with REPOTIFY_DEBUG.
export async function main(argv, io, run = runCli) {
  try {
    return await run(argv, io);
  } catch (error) {
    err(io, `repotify: ${error?.message ?? error}`);
    if (io.env?.REPOTIFY_DEBUG) err(io, String(error?.stack ?? ""));
    return 1;
  }
}

export async function runCli(argv, io) {
  const args = parseArgv(argv, VALUE_FLAGS);
  if (args.flags.version) {
    out(io, VERSION);
    return 0;
  }
  const [name = "start", ...rest] = args.positionals;
  if (args.flags.help || name === "help") {
    out(io, `repotify ${VERSION}\n\nCommands:\n` + Object.values(COMMANDS).map((c) => "  " + c.help).join("\n"));
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    err(io, `Unknown command: ${name}. Run "repotify --help".`);
    return 2;
  }
  return command.run({ positionals: rest, flags: args.flags }, io);
}
