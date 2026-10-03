import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { basename, join, resolve } from "node:path";
import { auditSkills, formatAudit } from "./audit.mjs";
import { auditMcp } from "./mcpaudit.mjs";
import { buildSuggestion, formatSuggestion } from "./suggest.mjs";
import { fileURLToPath } from "node:url";
import { scanDir } from "./scan/index.mjs";
import { fingerprint, formatFingerprint } from "./fingerprint.mjs";
import { resolveNeeds } from "./needs.mjs";
import { adaptiveQuestions, formatAdaptive, questionsJson } from "./questions.mjs";
import { startUi } from "./ui.mjs";
import { driftOf, readProjectState, writeProjectState, staleLine } from "./track.mjs";
import { formatTable, pickLoadout } from "./recommend.mjs";
import { loadCatalog } from "./catalog.mjs";
import { catalogUrl, DEFAULT_CATALOG_URL, envOverrides, homeDir, NPX_LAUNCHER } from "./config.mjs";
import { detectAgents, parseAgentList, runningAgents, skillTargets } from "./agents.mjs";
import { installItem, removeItem, installSelf, backfillJobs } from "./install.mjs";
import { runHook, parseInstallCommands } from "./guard.mjs";
import { createTelemetry, NOTICE, NOTICE_DETAILS } from "./telemetry.mjs";
import { recommendV1, demandFor, DEFAULT_BUDGET_CHARS as V1_BUDGET_CHARS } from "../lib/pipeline/recommend/index.mjs";
import { loadSeedGraph } from "../lib/pipeline/graph/loader.mjs";
import { loadFleetPolicy } from "../lib/telemetry/fleet-policy.mjs";
import { arbitrateWithJev, jevLooksAvailable } from "../lib/signals/jev.mjs";
import { createTracker } from "../lib/telemetry/store.mjs";
import { noticeNeeded as s0NoticeNeeded, markNoticeShown as s0MarkNoticeShown } from "../lib/telemetry/consent.mjs";
import { AGENT_IDS } from "../lib/telemetry/schema.mjs";
import { voteDue, keptEvents } from "./feedback.mjs";
import { checkUpdates, applyUpdates, selfUpdateSkill, enableAutoCheck, weeklyCheckDue, sanitizeLauncher, AUTO_CHECK_ARGS } from "./update.mjs";
import { AGENTS } from "./agents.mjs";
import { probeMachine, missingRuntime, formatMachine } from "./machine.mjs";
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

const VALUE_FLAGS = ["agent", "needs", "type", "priorities", "stacks", "platforms", "budget", "answers", "apply", "kind", "why", "license", "blocked", "port"];
const out = (io, text) => io.stdout.write(text.endsWith("\n") ? text : text + "\n");
const err = (io, text) => io.stderr.write(text.endsWith("\n") ? text : text + "\n");
const csv = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function telemetry(io) {
  return createTelemetry({ env: io.env ?? {}, version: VERSION });
}

// Queues anonymous events locally. Nothing is sent from here: `repotify sync` is the only way out.
// T1: no data before the notice — events are dropped until the user has seen
// the first-run telemetry notice (noticeNeeded), even when enabled.
async function track(io, events) {
  const t = telemetry(io);
  if (!t.enabled) return;
  if (t.noticeNeeded()) {
    // First tracking touchpoint, whatever the command: the user sees the
    // notice at the moment collection begins (stderr, so JSON on stdout stays
    // parseable), then the events flow. T1 holds — nothing was written before.
    err(io, NOTICE);
    t.markNoticeShown();
  }
  let agent = "unknown";
  try {
    agent = detectAgents({ env: io.env ?? {}, cwd: io.cwd })[0] ?? "unknown";
  } catch {
    // Detection problems never block the command.
  }
  for (const e of events) t.track({ agent, ...e });
}

export async function getCatalog(io, flags = {}) {
  const env = io.env ?? {};
  // A changed catalog source decides everything that is recommended and installed: never silent.
  if (env.REPOTIFY_CATALOG_URL && env.REPOTIFY_CATALOG_URL !== DEFAULT_CATALOG_URL && !flags.offline && env.REPOTIFY_OFFLINE !== "1") {
    err(io, `Note: the catalog is read from ${String(env.REPOTIFY_CATALOG_URL).replace(/[^\x20-\x7e]/g, "?").slice(0, 200)} (REPOTIFY_CATALOG_URL), not from Repotify's own repository.`);
  }
  return loadCatalog({
    url: catalogUrl(env),
    cacheDir: join(homeDir(env), "cache", "catalog"),
    fetchImpl: io.fetchImpl ?? fetch,
    offline: Boolean(flags.offline) || env.REPOTIFY_OFFLINE === "1",
  });
}

// The agents asking: `--agent a,b`, or what the environment says. Empty when unknown; nothing is held back then.
function askingAgents(args, io) {
  if (typeof args.flags.agent === "string") {
    try {
      return parseAgentList(args.flags.agent).filter((a) => a !== "generic");
    } catch {
      return [];
    }
  }
  return runningAgents(io.env ?? {});
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
  if (flags.stacks) answers.stacks = [...(answers.stacks ?? []), ...csv(flags.stacks)];
  if (flags.platforms) answers.platforms = [...(answers.platforms ?? []), ...csv(flags.platforms)];
  return answers;
}

async function cmdFingerprint(args, io) {
  const fp = await fingerprint(io.cwd);
  const machine = probeMachine({ env: io.env ?? process.env });
  out(io, args.flags.json ? JSON.stringify({ ...fp, machine }, null, 2) : `${formatFingerprint(fp)}\n- Computer: ${formatMachine(machine)}`);
  return 0;
}

// Only the questions whose answer would change the picks: every option is tried against the engine first. Takes the
// same answer flags as recommend, so after one answer it lists what is still worth asking.
async function cmdQuestions(args, io) {
  const { catalog, notice } = await getCatalog(io, args.flags);
  const fp = await fingerprint(io.cwd);
  const installed = [...new Set([...Object.keys(readLock(io.cwd).items), ...(fp.agents?.skills ?? [])])];
  const r = adaptiveQuestions({
    catalog, graph: loadSeedGraph(GRAPH_SEED_PATH), fingerprint: fp, answers: answersFrom(args.flags),
    machine: probeMachine({ env: io.env ?? process.env }), installed, blocked: csv(args.flags.blocked), agents: askingAgents(args, io),
  });
  if (args.flags.json) out(io, questionsJson(r.questions));
  else out(io, (notice ? notice + "\n" : "") + formatAdaptive(r));
  return 0;
}

// The decision drawn as a tree in the browser, served on 127.0.0.1 until Ctrl+C. Read-only: the page shows what the
// engine prunes and picks for each answer; installing stays with the agent and the user.
async function cmdUi(args, io) {
  const { catalog, notice } = await getCatalog(io, args.flags);
  const fp = await fingerprint(io.cwd);
  const installed = [...new Set([...Object.keys(readLock(io.cwd).items), ...(fp.agents?.skills ?? [])])];
  const port = Number(args.flags.port);
  const ui = await startUi({
    catalog, graph: loadSeedGraph(GRAPH_SEED_PATH), fingerprint: fp, project: basename(resolve(io.cwd)),
    machine: probeMachine({ env: io.env ?? process.env }), installed, agents: askingAgents(args, io), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
  });
  const answers = answersFrom(args.flags);
  const link = Object.keys(answers).length ? `${ui.url}&a=${encodeURIComponent(JSON.stringify(answers))}` : ui.url;
  if (notice) out(io, notice);
  out(io, `Repotify UI: ${link}\nOpen it in your browser. It only reads; Ctrl+C stops it.`);
  await new Promise((stopped) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      stopped();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await ui.close();
  return 0;
}

// Capability graph seed, bundled with the package (package.json "files").
const GRAPH_SEED_PATH = fileURLToPath(new URL("../data/graph-seed.json", import.meta.url));

// The engine's candidate table (one row per job: installed items, the default
// set, the best alternate for each open job) in the row shape formatTable and
// --json use.
function tableRows(rec, itemById, machine = null) {
  return (rec.table ?? []).map((r) => {
    const item = itemById.get(r.id) ?? {};
    const missing = missingRuntime(item, machine);
    return {
      id: r.id,
      type: item.type ?? "skill",
      tier: item.tier,
      cluster: item.cluster,
      score: Math.round(r.score * 100) / 100,
      badges: [item.security?.level === "caution" ? "caution" : "verified"],
      summary: item.summary ?? "",
      reasons: [...missing.map((t) => `needs:${t}`), ...(r.reasons ?? [])],
      default: r.default,
      installed: r.installed,
      userEnables: item.type === "mcp" || item.type === "config",
      lifecycle: item.lifecycle ?? null,
    };
  });
}

// Stage 0 propensity telemetry (FAZ 10 d1, item 7; P3 DL-051): the old
// {type:"shown"} event is replaced by a Stage 0 "recommendation" episode —
// the full slate with one propensity per considered candidate (B1: 0 < p < 1).
// The serving policy is ε-greedy (ε=0 by default, 0.05 with REPOTIFY_EXPLORE=1; DL-051): with prob ε the set
// contains one exploration swap. Propensities are the ε-greedy propensities:
// p=(1-ε)+ε/n for the greedy pick, p=ε/n for the rest — never degenerate 0/1.
// `is_explore` marks the exploration-swapped candidate (single producer:
// this function, DL-051d). `randomized:true` — counterfactual estimators
// (lib/learn/ope.mjs, DL-051c) may trust these propensities. Fail-open:
// telemetry never breaks the command.
function trackRecommendationV1(io, { rec, catalogVersion, budgetChars }) {
  const env = io.env ?? {};
  // Preserve the first-run notice behavior (T1): shown once on stderr, then
  // events flow. Same config keys as the legacy pipeline.
  if (s0NoticeNeeded(env)) {
    err(io, NOTICE);
    s0MarkNoticeShown(env);
  }
  let agent = "unknown";
  try {
    const a = detectAgents({ env, cwd: io.cwd })[0] ?? "unknown";
    agent = AGENT_IDS.includes(a) ? a : "unknown";
  } catch {
    // Detection problems never block the command.
  }
  const ranked = (rec.ranked ?? []).slice(0, 100); // schema cap: max 100 candidates
  if (!ranked.length) return false;
  // ε-greedy propensities (P3): the serving policy explores with prob ε.
  // Greedy pick: (1-ε) + ε/n. Alternates: ε/n, n being the alternates the swap
  // draws from uniformly (the table's open jobs); anything else is never drawn.
  // Clamped strictly inside (0,1) — B1.
  const eps = rec.exploreEpsilon ?? 0;
  const pool = new Set((rec.table ?? []).filter((r) => !r.default && !r.installed).map((r) => r.id));
  if (rec.exploreItemId) pool.add(rec.exploreItemId);
  const n = Math.max(1, pool.size);
  const selected = new Set(rec.set ?? []);
  const exploreId = rec.exploreItemId ?? null;
  const candidates = ranked.map((r, i) => {
    const isGreedyPick = selected.has(r.id) && r.id !== exploreId;
    const propensity = isGreedyPick
      ? (1 - eps) + eps / n
      : pool.has(r.id) ? eps / n : 0;
    return {
      skill_id: r.id,
      position: i,
      propensity: Math.min(1 - 1e-9, Math.max(1e-9, propensity)),
      shown: selected.has(r.id),
      raw_score: r.score,
      is_explore: r.id === exploreId,
    };
  });
  try {
    const t = createTracker({ env, dir: homeDir(env) });
    return t.track({
      type: "recommendation",
      episode_id: t.newEpisodeId(),
      agent,
      cli_version: VERSION,
      catalog_version: catalogVersion,
      policy_name: "repotify-v2",
      policy_version: "1",
      budget_chars: budgetChars,
      randomized: eps > 0, // only an exploring policy yields propensities OPE may trust
      candidates,
      // Gate decision audit trail (BACKLOG: gate karar loglama): one
      // structured record per gate-evaluated candidate — reason code,
      // Jaccard, blocker. Capped for log hygiene; the catalog is ~100 items.
      gate_decisions: (rec.gateDecisions ?? []).slice(0, 200),
    });
  } catch {
    return false;
  }
}

// Exploration (DL-051) swaps one set item for a random candidate. It only pays
// off once a learning loop consumes the logged propensities, and none runs yet
// (TELEMETRY_ENDPOINT is null), so until then it would only hand users a random
// skill. Off by default; REPOTIFY_EXPLORE=1 turns it on for experiments.
export const EXPLORE_EPSILON = 0.05;
function exploreEpsilonFor(env) {
  return env.REPOTIFY_EXPLORE === "1" && env.REPOTIFY_NO_EXPLORE !== "1" ? EXPLORE_EPSILON : 0;
}

async function cmdRecommend(args, io) {
  const { catalog, notice } = await getCatalog(io, args.flags);
  const fp = await fingerprint(io.cwd);
  const answers = answersFrom(args.flags);
  const resolved = resolveNeeds({ fingerprint: fp, answers, taxonomy: catalog.taxonomy });
  const budget = Number(args.flags.budget) > 0 ? Number(args.flags.budget) : undefined;
  // Installed means in the lock or already in an agent's skills folder (put there by hand
  // or by another tool): either way it is not offered again, and it holds its job.
  const installed = [...new Set([...Object.keys(readLock(io.cwd).items), ...(fp.agents?.skills ?? [])])];
  // d1: the CLI now drives the v2 pipeline. Demand translation reuses the old
  // engine's buildDemand (same taxonomy/need-weight semantics) plus the
  // fingerprint stacks and answered keys the v2 narrower/scorer read.
  // What this computer can run: an MCP server whose runtime is missing is listed with what it needs, not defaulted.
  const machine = probeMachine({ env: io.env ?? process.env });
  const demand = { ...demandFor({ catalog, fingerprint: fp, needs: resolved, answers, agents: askingAgents(args, io) }), machine };
  const graph = loadSeedGraph(GRAPH_SEED_PATH);
  const blocked = csv(args.flags.blocked);
  const fleetPolicy = loadFleetPolicy({ env: io.env ?? {} });
  const itemById = new Map(catalog.items.map((i) => [i.id, i]));
  // Jev arbitration is a paid call with the user's own key (JEV_API_KEY): opt-in
  // via --arbitrate or REPOTIFY_JEV=1. recommendV1 consults it only when the
  // local top-2 is genuinely ambiguous.
  const env = io.env ?? process.env;
  const jevOptIn = Boolean(args.flags.arbitrate) || env.REPOTIFY_JEV === "1";
  const arbitrate = jevOptIn && jevLooksAvailable({ env })
    ? (ids) => arbitrateWithJev(ids, {
        state: { needs: demand.needs, stacks: demand.stacks },
        describe: (id) => itemById.get(id)?.summary ?? id,
        env,
      })
    : null;
  const rec = await recommendV1(
    { catalog, graph, demand, installed, blocked, budgetChars: budget, answers },
    { arbitrate, fleetPolicy, exploreEpsilon: exploreEpsilonFor(io.env ?? {}) },
  );
  // Empty-project loadout (legacy behavior): presentation-only — the v2
  // pipeline has no loadout concept.
  const loadout = fp?.empty ? pickLoadout(catalog.loadouts, resolved) : null;
  trackRecommendationV1(io, { rec, catalogVersion: catalog.meta.version, budgetChars: budget });
  const rows = tableRows(rec, itemById, machine);
  const tableInput = {
    rows,
    budget: rec.budget ?? { used: 0, limit: budget ?? V1_BUDGET_CHARS },
    loadout: loadout?.id ?? null,
  };
  if (args.flags.json) {
    out(io, JSON.stringify({
      ...rec,
      rows,
      defaultSet: rec.set,
      loadout: loadout?.id ?? null,
      projectType: resolved.projectType,
      needs: resolved.needs,
      catalogVersion: catalog.meta.version,
      notice: notice ?? null,
    }, null, 2));
  } else {
    if (notice) out(io, notice);
    if (rec.decision === "reject") {
      out(io, `Repotify candidates: no confident recommendation (${rec.reason}${rec.detail ? ` — ${rec.detail}` : ""}).`);
      if (rec.advice) out(io, rec.advice);
    }
    out(io, formatTable(tableInput));
  }
  return 0;
}

async function cmdAudit(args, io) {
  const { catalog, notice } = await getCatalog(io, args.flags);
  const fp = await fingerprint(io.cwd);
  const needs = resolveNeeds({ fingerprint: fp, answers: answersFrom(args.flags), taxonomy: catalog.taxonomy });
  const home = io.env?.HOME || homedir();
  const extraRoots = args.flags.user && resolve(home) !== resolve(io.cwd) ? [{ root: home, scope: "user" }] : [];
  const report = { ...(await auditSkills({ root: io.cwd, catalog, fingerprint: fp, needs, lock: readLock(io.cwd), extraRoots })), mcp: auditMcp({ root: io.cwd, catalog }) };
  if (args.flags.json) {
    out(io, JSON.stringify({ ...report, catalogVersion: catalog.meta.version, notice: notice ?? null }, null, 2));
  } else {
    if (notice) out(io, notice);
    out(io, formatAudit(report));
  }
  return 0;
}

const str = (v) => (typeof v === "string" ? v : undefined);

async function cmdSuggest(args, io) {
  const s = await buildSuggestion({
    cwd: io.cwd, target: args.positionals[0], kind: str(args.flags.kind), why: str(args.flags.why), license: str(args.flags.license),
    own: !args.flags["not-mine"],
  });
  if (args.flags.json) out(io, JSON.stringify(s, null, 2));
  else (s.ok ? out : err)(io, formatSuggestion(s));
  return s.ok ? 0 : s.code === "blocked" ? 1 : 2;
}

function agentsFrom(flags, io) {
  return flags.agent ? parseAgentList(flags.agent) : detectAgents({ env: io.env ?? {}, cwd: io.cwd });
}

const MAX_INSTALL_SUMMARY = 1050;

// Items that change how the agent itself runs: hooks and MCP servers. An agent never switches these on; the user does,
// with `repotify enable`, after seeing what will be written.
const AGENT_CONFIG_TYPES = new Set(["mcp", "config"]);
// How to call this copy again. Never read from repotify.lock.json: a cloned repository can ship that file, and what
// it says would end up in a hook command or in front of the user as a command to run.
const launcherOf = () => detectLauncher();

async function ask(io, question) {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

// Hooks and MCP servers need the user: an interactive terminal where they confirm, or --yes typed by them.
function userConsentMissing(args, io, what) {
  if (io.stdin?.isTTY || args.flags.yes) return false;
  err(io, `${what} changes how your coding agent runs. Run this yourself in a terminal to confirm it, or add --yes if you are the user running it.`);
  return true;
}

function summaryLine(r) {
  if (!r.ok) return `✗ ${r.id}: ${r.error}`;
  if (r.userEnables && !r.written) return `• ${r.id} (${r.type === "mcp" ? "MCP server" : "hook"}) changes how the agent runs; the user enables it: ${r.userEnables}`;
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
      const agentConfig = AGENT_CONFIG_TYPES.has(item.type);
      const r = await installItem(item, {
        cwd: io.cwd, agents, confirm: Boolean(args.flags.yes) && !agentConfig, acceptCaution: Boolean(args.flags["accept-caution"]),
        fetchImpl: io.fetchImpl ?? fetch, catalogVersion: catalog.meta.version, launcher: detectLauncher(),
        offline: Boolean(args.flags.offline) || io.env?.REPOTIFY_OFFLINE === "1",
      });
      results.push({ id, ok: true, level: item.security?.level, ...r, ...(agentConfig ? { userEnables: `${launcherOf(io)} enable ${id}` } : {}) });
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
  else {
    out(io, formatInstallSummary({ agents, results, notice }));
    // Once per machine, after the first install that wrote something: a one-line thank-you, never repeated.
    const env = io.env ?? process.env;
    if (done.length && !readConfig(env).starHintShown) {
      out(io, `\n${STAR_HINT}`);
      writeConfig(env, { starHintShown: true });
    }
  }
  return results.some((r) => !r.ok) ? 1 : 0;
}

export const STAR_HINT = "★ Did Repotify help? A star on GitHub helps other developers find it: https://github.com/repotify/repotify";

function describeChange(item, preview) {
  if (item.type === "mcp") {
    const files = (preview.snippets ?? []).map((s) => s.file).join(", ") || "no agent with an MCP config";
    const cmd = [item.setup?.mcp?.command, ...(item.setup?.mcp?.args ?? [])].join(" ");
    return `${item.id}: adds an MCP server your agent starts itself (\`${cmd}\`) to ${files}.`;
  }
  return `${item.id}: ${preview.preview ?? "changes your agent's settings"}. ${item.summary}`;
}

async function cmdEnable(args, io) {
  const ids = args.positionals.flatMap((p) => p.split(",")).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    err(io, "Usage: repotify enable <id...> [--yes] [--agent a,b] [--accept-caution]   (hooks and MCP servers; the user runs this)");
    return 2;
  }
  if (userConsentMissing(args, io, "`repotify enable`")) return 2;
  let agents;
  try {
    agents = agentsFrom(args.flags, io);
  } catch (e) {
    err(io, e.message);
    return 2;
  }
  const { catalog } = await getCatalog(io, args.flags);
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const opts = { cwd: io.cwd, agents, fetchImpl: io.fetchImpl ?? fetch, catalogVersion: catalog.meta.version, acceptCaution: Boolean(args.flags["accept-caution"]), launcher: detectLauncher() };
  let failed = false;
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || !AGENT_CONFIG_TYPES.has(item.type)) {
      err(io, `✗ ${id}: ${item ? `a ${item.type}, not a hook or MCP server; use \`repotify install ${id}\`` : "not in the catalog"}`);
      failed = true;
      continue;
    }
    try {
      out(io, describeChange(item, await installItem(item, { ...opts, confirm: false })));
      if (!args.flags.yes && !(await ask(io, `Enable ${id}? [y/N] `))) {
        out(io, `Skipped ${id}; nothing changed.`);
        continue;
      }
      out(io, summaryLine({ id, ok: true, level: item.security?.level, ...(await installItem(item, { ...opts, confirm: true })) }));
      // The router reads each installed skill's job from the lock; older locks get it now.
      if (id === "repotify-router") backfillJobs(io.cwd, catalog);
      await track(io, [{ type: "installed", items: [id], catalogVersion: catalog.meta.version }]);
    } catch (e) {
      err(io, `✗ ${id}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
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
  const others = fp.agents.skills.filter((s) => s !== "repotify");
  if (others.length) lines.push(`This project already has ${others.length} skill${others.length === 1 ? "" : "s"}; \`repotify audit\` shows which ones earn their place and why.`);
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
  const fleet = io.env?.REPOTIFY_TELEMETRY_URL ?? null;
  out(io, `Telemetry: ${t.enabled ? "on" : "off"}; ${t.queued()} event(s) kept locally; nothing is sent unless you run \`repotify sync\` (${fleet ? `fleet server ${fleet}` : "no fleet server configured"}).\n${NOTICE_DETAILS}`);
  const overrides = envOverrides(io.env ?? {});
  if (overrides.length) out(io, `Environment overrides in effect: ${overrides.join(", ")}.`);
  return 0;
}

// `repotify sync`: the only path by which anything leaves the machine.
// All logic lives in lib/telemetry/sync.mjs; the CLI only routes io.
async function cmdSync(args, io) {
  if (args.positionals.length > 0) {
    err(io, "Usage: repotify sync");
    return 2;
  }
  const sync = await import("../lib/telemetry/sync.mjs");
  return sync.runSyncCommand(io, {});
}

function agentsFromTargets(targets) {
  return Object.keys(AGENTS).filter((id) => id !== "generic" && targets.includes(`${AGENTS[id].skillsDir}/repotify`));
}

async function cmdUpdate(args, io) {
  const env = io.env ?? {};
  if (args.flags["enable-auto-check"]) {
    if (userConsentMissing(args, io, "The weekly update check (a Claude Code SessionStart hook)")) return 2;
    const launcher = sanitizeLauncher(detectLauncher());
    if (!args.flags.yes && !(await ask(io, `Add a SessionStart hook to .claude/settings.json that runs \`${launcher} ${AUTO_CHECK_ARGS}\` once a week? [y/N] `))) {
      out(io, "Nothing changed.");
      return 0;
    }
    const r = enableAutoCheck({ cwd: io.cwd, launcher });
    out(io, r.written ? `Weekly update check enabled (runs \`${r.command}\`).` : `Could not edit .claude/settings.json (${r.reason}); nothing changed.`);
    return r.written ? 0 : 1;
  }
  if (args.flags.apply) {
    const ids = csv(typeof args.flags.apply === "string" ? args.flags.apply : args.positionals.join(","));
    // Updating a hook or an MCP server changes how the agent runs, like enabling one: the same consent applies.
    const lock = readLock(io.cwd);
    const agentConfig = ids.filter((id) => AGENT_CONFIG_TYPES.has(lock.items[id]?.type));
    if (agentConfig.length) {
      if (userConsentMissing(args, io, `Updating ${agentConfig.join(", ")} (a hook or MCP server)`)) return 2;
      if (!args.flags.yes && !(await ask(io, `Update ${agentConfig.join(", ")}? This changes how your coding agent runs. [y/N] `))) {
        out(io, "Nothing changed.");
        return 0;
      }
    }
    const { catalog } = await getCatalog(io, args.flags);
    const results = await applyUpdates(ids, { cwd: io.cwd, catalog, fetchImpl: io.fetchImpl ?? fetch, acceptCaution: Boolean(args.flags["accept-caution"]), offline: Boolean(args.flags.offline) || env.REPOTIFY_OFFLINE === "1" });
    out(io, results.map((r) => (r.ok ? `✓ ${r.id} updated` : `✗ ${r.id}: ${r.error}`)).join("\n") || "Nothing to update.");
    return results.some((r) => !r.ok) ? 1 : 0;
  }
  const now = new Date();
  if (args.flags.weekly && !weeklyCheckDue(readConfig(env), now)) return 0;
  const { lines, catalog, notice } = await updateLines(io, args.flags, now);
  if (!lines.length) {
    if (args.flags.quiet) return 0;
    lines.push(`Everything is up to date (catalog ${catalog.meta.version}).`);
  }
  if (notice && !args.flags.quiet) lines.unshift(notice);
  out(io, lines.join("\n"));
  return 0;
}

// The update check both `update --check` and the tracker run: vetted updates for installed items, items that left
// the catalog, and Repotify's own skill refreshed. Marks the check as done for the week.
async function updateLines(io, flags, now) {
  const { catalog, notice } = await getCatalog(io, flags);
  const lock = readLock(io.cwd);
  const r = checkUpdates({ lock, catalog });
  const selfTargets = lock.items.repotify?.targets ?? [];
  const self = selfTargets.length ? selfUpdateSkill({ cwd: io.cwd, agents: agentsFromTargets(selfTargets), version: VERSION }) : { updated: false };
  writeConfig(io.env ?? {}, { lastUpdateCheckAt: now.toISOString() });
  const lines = [];
  if (r.items.length) {
    lines.push(`${r.items.length} update${r.items.length === 1 ? "" : "s"} available (already security-scanned):`);
    for (const u of r.items) lines.push(`  ${u.id} ${String(u.fromCommit).slice(0, 7)} → ${String(u.toCommit).slice(0, 7)}${u.level === "caution" ? " ⚠ caution" : ""}`);
    lines.push(`Apply with: repotify update --apply ${r.items.map((u) => u.id).join(",")}`);
  }
  for (const id of r.removedFromCatalog) lines.push(`⚠ ${id} is no longer in the catalog (quarantined or removed upstream); consider \`repotify remove ${id}\`.`);
  if (r.heldBack.length) lines.push(`Not offered: ${r.heldBack.join(", ")} came from a newer catalog than the one in use (${catalog.meta.version}); an older catalog never replaces it.`);
  if (self.updated) lines.push(`Refreshed the repotify skill (${self.from ?? "?"} → ${self.to}).`);
  return { lines, catalog, notice };
}

// What changed since the last look: new stacks or needs that bring new picks (local, said once), and once a week the
// update check and the skills that no longer earn their place. Silent when there is nothing to do. As a hook
// (`--hook`, at session start) it never fails the session: any error ends it quietly.
async function cmdTrack(args, io) {
  const env = io.env ?? {};
  const now = new Date();
  const lines = [];
  try {
    const fp = await fingerprint(io.cwd);
    const lock = readLock(io.cwd);
    const installed = [...new Set([...Object.keys(lock.items), ...(fp.agents?.skills ?? [])])];
    const { catalog } = await getCatalog(io, { ...args.flags, offline: true });
    const drift = driftOf({ catalog, graph: loadSeedGraph(GRAPH_SEED_PATH), fingerprint: fp, state: readProjectState(env, io.cwd), installed, machine: probeMachine({ env: io.env ?? process.env }), agents: askingAgents(args, io), now });
    writeProjectState(env, io.cwd, drift.state);
    lines.push(...drift.lines);
    if (weeklyCheckDue(readConfig(env), now)) {
      const checked = await updateLines(io, args.flags, now);
      lines.push(...checked.lines);
      const needs = resolveNeeds({ fingerprint: fp, answers: {}, taxonomy: checked.catalog.taxonomy });
      const stale = staleLine(await auditSkills({ root: io.cwd, catalog: checked.catalog, fingerprint: fp, needs, lock }));
      if (stale) lines.push(stale);
    }
  } catch (error) {
    if (!args.flags.hook) throw error;
    return 0;
  }
  if (args.flags.json) out(io, JSON.stringify({ lines }, null, 2));
  else if (lines.length) out(io, lines.join("\n"));
  else if (!args.flags.hook) out(io, "Nothing new since the last look.");
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
  let r;
  try {
    // The same limits as `repotify audit`: a folder too large to read is not vetted, and says so.
    r = await scanDir(dir, { maxFiles: 400, maxBytes: 30 * 1024 * 1024 });
  } catch (error) {
    err(io, `Not scanned: ${target} is ${error.message}.`);
    return 1;
  }
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

// Every variable the CLI reads. The ones that change where data comes from or goes to are announced when set.
export const ENV_HELP = [
  "REPOTIFY_OFFLINE=1          Use the bundled or cached catalog; never touch the network (installs are refused)",
  "REPOTIFY_HOME=<dir>         Where the cache, settings and local logs live (default ~/.repotify)",
  "REPOTIFY_TELEMETRY=0        Turn local measurement off (also DO_NOT_TRACK=1, NO_ANALYTICS=1)",
  "REPOTIFY_TELEMETRY_URL=<u>  Fleet server `repotify sync` sends its summary to, after you confirm (none by default)",
  "REPOTIFY_CATALOG_URL=<u>    Read the catalog from another place (announced on every run)",
  "REPOTIFY_RAW_BASE=<u>       Download skill files from another host (files must still match the catalog's hashes)",
  "REPOTIFY_EXPLORE=1          Let recommend try a less certain pick now and then (REPOTIFY_NO_EXPLORE=1 forbids it)",
  "REPOTIFY_JEV=1              Let recommend ask a paid model to break ties, with your own JEV_API_KEY",
  "REPOTIFY_COVERAGE_VARIANT   How overlapping picks are dropped: jaccard (default), strict, loose, hybrid",
  "REPOTIFY_DEBUG=1            Print the stack trace of an unexpected error (may show local paths)",
];

export const COMMANDS = {
  start: { run: cmdStart, help: "start [--agent a,b]                  Default: install the repotify skill for your agent and summarize the project" },
  fingerprint: { run: cmdFingerprint, help: "fingerprint [--json]                 Summarize this project (local; code is not read)" },
  questions: { run: cmdQuestions, help: "questions [--json] [--type t ...]    Only the questions whose answer changes the picks" },
  ui: { run: cmdUi, help: "ui [--port N] [--type t ...]         See the decision as a tree in your browser (local, read-only)" },
  recommend: { run: cmdRecommend, help: "recommend [--type t] [--needs a,b]   Conflict-free candidate table (--json, --budget N, --blocked a,b, --arbitrate)" },
  suggest: { run: cmdSuggest, help: "suggest [dir|github-url] [--why text]  Suggest your repo for the catalog (pre-filled form; nothing is sent)" },
  audit: { run: cmdAudit, help: "audit [--user] [--json]              Which installed skills earn their place, which to remove, and why" },
  install: { run: cmdInstall, help: "install <id...> [--yes] [--agent a,b] Install catalog skills (hash-checked, re-scanned)" },
  enable: { run: cmdEnable, help: "enable <id...> [--yes]               Hooks and MCP servers: the user switches them on, after a preview" },
  remove: { run: cmdRemove, help: "remove <id>                          Remove an item Repotify installed" },
  scan: { run: cmdScan, help: "scan <dir> [--json]                  Security-scan a skill folder" },
  track: { run: cmdTrack, help: "track [--hook] [--json]              What changed in the project since the last look, and what it would now pick" },
  update: { run: cmdUpdate, help: "update [--check|--apply a,b|--enable-auto-check] Vetted updates for installed items" },
  vote: { run: cmdVote, help: "vote <id> up|down | --due | --dismiss  Rate an installed item (at most weekly)" },
  telemetry: { run: cmdTelemetry, help: "telemetry [status|on|off]           Anonymous usage signals (endpoint currently off)" },
  sync: { run: cmdSync, help: "sync                                  Send an anonymous summary to a fleet server you configure (none runs yet; you confirm first)" },
  guard: { run: cmdGuard, help: "guard --hook | --self-test           Package guard (Claude Code PreToolUse hook)" },
};

// A reader that stops early (`repotify recommend | head`, `| grep -q`) closes the pipe while Repotify may still
// write. That is not a failure: the command finishes its work and exits with its own code, instead of a stack trace
// and exit code 1 that make an agent think a finished install failed.
export function quietPipes(...streams) {
  for (const stream of streams) {
    stream.on("error", (error) => {
      if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") throw error;
    });
  }
}

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
    out(io, `repotify ${VERSION}\n\nCommands:\n` + Object.values(COMMANDS).map((c) => "  " + c.help).join("\n") + "\n\nEnvironment:\n" + ENV_HELP.map((l) => "  " + l).join("\n"));
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    err(io, `Unknown command: ${name}. Run "repotify --help".`);
    return 2;
  }
  return command.run({ positionals: rest, flags: args.flags }, io);
}
