#!/usr/bin/env node
// MCP servers for the catalog, from the official MCP registry (registry.modelcontextprotocol.io): every server whose
// latest version installs locally from npm or PyPI, with how much people use it (npm and PyPI downloads, not stars),
// its security gate (the scanner on its command, install scripts, known vulnerabilities of the pinned version) and the
// decision model's answers about what it is for. Kept in the content store like skills, so pipeline/derive.mjs turns
// them into catalog items without the network.
//   JEV_API_KEY=… node pipeline/mcp.mjs --store DIR [--min-downloads 1000] [--no-jev] [--concurrency 4]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain } from "../src/util.mjs";
import { ask, jevConfig } from "../lib/signals/jev.mjs";
import { createStore, obsKey } from "./store.mjs";
import { setupSecurity } from "./gate.mjs";
import { fetchWithRetry } from "./lib/http.mjs";
import { capabilityOptions, stackOptions, mapLimit, extendTaxonomy } from "./jev-classify.mjs";
import { extendTaxonomyV2 } from "./taxonomy.mjs";
import { PURPOSES } from "./observe.mjs";
import { flag, logStamped } from "./lib/cli.mjs";

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const DAY = 86400000;

// A JSON document and the HTTP status it came with (0 when the request itself failed).
async function getJson(url, { fetchImpl = fetch, timeoutMs = 30000, sleep, retries = 2 } = {}) {
  try {
    const res = await fetchWithRetry(url, { headers: { "User-Agent": "repotify-pipeline", Accept: "application/json" } }, { fetchImpl, retries, timeoutMs, ...(sleep ? { sleep } : {}) });
    return { status: res.status, doc: res.ok ? await res.json() : null };
  } catch {
    return { status: 0, doc: null };
  }
}

// The registry's servers, latest versions only, page by page.
export async function fetchRegistry({ fetchImpl, maxPages = 2000, log = () => {} } = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const { doc } = await getJson(`${REGISTRY}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { fetchImpl });
    if (!doc) break;
    for (const s of doc.servers ?? []) if (s._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest) out.push(s.server);
    cursor = doc.metadata?.nextCursor;
    if (!cursor) break;
    if (page % 50 === 49) log(`registry: ${out.length} servers so far`);
  }
  return out;
}

const SAFE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SAFE_VERSION = /^[0-9][0-9A-Za-z.+-]*$/;
const SAFE_ARG = /^[A-Za-z0-9_.:\/=@+,-]{1,200}$/;

// The fixed arguments a package's publisher says to pass, or null when one cannot be filled in: a required argument
// with neither a value nor a default (a path or a key only the user knows), or a value that is not a plain word.
export function fixedArguments(list) {
  const out = [];
  for (const a of list ?? []) {
    const value = a?.value ?? (a?.isRequired ? a.default : null) ?? null;
    if (value == null) {
      if (a?.isRequired) return null;
      continue;
    }
    const named = a.type === "named";
    if (!SAFE_ARG.test(String(value)) || (named && !SAFE_ARG.test(String(a.name ?? "")))) return null;
    out.push(...(named ? [String(a.name), String(value)] : [String(value)]));
  }
  return out;
}

// A registry server that installs locally: one pinned npm or PyPI package run over stdio. Remote-only servers send
// the project's data to someone else's host and are left out, and so are servers that cannot start without an
// argument only the user can give.
export function localServer(s) {
  const pkg = (s.packages ?? []).find((p) => (p.registryType === "npm" || p.registryType === "pypi") && (p.transport?.type ?? "stdio") === "stdio");
  if (!pkg || !SAFE_VERSION.test(String(pkg.version ?? ""))) return null;
  const id = String(pkg.identifier ?? "").toLowerCase();
  if (!SAFE_NAME.test(id)) return null;
  const runtimeArgs = fixedArguments(pkg.runtimeArguments);
  const packageArgs = fixedArguments(pkg.packageArguments);
  if (!runtimeArgs || !packageArgs) return null;
  const repo = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(s.repository?.url ?? ""))?.[1]?.toLowerCase() ?? null;
  const env = (pkg.environmentVariables ?? []).map((e) => ({ name: String(e.name ?? ""), required: Boolean(e.isRequired), secret: Boolean(e.isSecret) })).filter((e) => /^[A-Z][A-Z0-9_]*$/.test(e.name));
  return {
    name: String(s.name),
    title: String(s.title ?? s.name).slice(0, 100),
    description: String(s.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
    version: String(s.version ?? pkg.version),
    registry: pkg.registryType,
    package: id,
    packageVersion: String(pkg.version),
    env,
    repo,
    ...(runtimeArgs.length ? { runtimeArgs } : {}),
    ...(packageArgs.length ? { packageArgs } : {}),
  };
}

// One host at a time, politely: a pause after every request, and after a refusal (429; api.npmjs.org says
// "retry-after: 0" and refuses again) a wait that doubles. A host that keeps refusing is left for the next run.
export function politeClient({ fetchImpl, sleep, log = () => {}, firstWaitMs = 30000, maxRefusals = 6 } = {}) {
  const refused = new Map();
  return async function ask(url, gapMs) {
    const host = new URL(url).host;
    for (let wait = firstWaitMs; ; wait *= 2) {
      if ((refused.get(host) ?? 0) >= maxRefusals) return null;
      const r = await getJson(url, { fetchImpl, sleep, retries: 0 });
      if (r.status !== 429) {
        refused.set(host, 0);
        await sleep(gapMs);
        return r;
      }
      refused.set(host, (refused.get(host) ?? 0) + 1);
      log(`${host} asks to slow down; waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  };
}

// Monthly downloads: npm in bulk (unscoped names, 128 a request) or one by one (scoped); PyPI through pypistats.
// A package the registry does not know counts 0; a lookup that failed is left out and asked again next time. Counts
// are kept for the week in the store, so an interrupted run picks up where it stopped.
export async function downloads(servers, { store = null, fetchImpl, now = new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = { npm: 300, pypi: 1000 }, firstWaitMs, log = () => {} } = {}) {
  const week = Math.floor(now.getTime() / (7 * DAY));
  const saved = store?.getState("mcp-downloads");
  const out = new Map(saved?.week === week ? Object.entries(saved.counts ?? {}) : []);
  let unsaved = 0;
  const save = () => {
    if (store) store.putState("mcp-downloads", { week, counts: Object.fromEntries(out) });
    unsaved = 0;
  };
  const record = (key, d) => {
    out.set(key, d);
    if (++unsaved >= 100) save();
    if (out.size % 1000 === 0) log(`downloads: ${out.size} packages counted`);
  };
  const counted = (key, r, value) => {
    if (!r) return;
    if (r.status === 404) record(key, 0);
    else if (Number.isFinite(value(r.doc))) record(key, value(r.doc));
  };
  const ask = politeClient({ fetchImpl, sleep, log, ...(firstWaitMs ? { firstWaitMs } : {}) });
  const todo = servers.filter((s) => !out.has(`${s.registry}:${s.package}`));
  const npm = todo.filter((s) => s.registry === "npm");
  const unscoped = npm.filter((s) => !s.package.startsWith("@")).map((s) => s.package);
  for (let i = 0; i < unscoped.length; i += 128) {
    const batch = unscoped.slice(i, i + 128);
    const r = await ask(`https://api.npmjs.org/downloads/point/last-month/${batch.join(",")}`, gapMs.npm);
    if (r?.status === 404 && batch.length === 1) record(`npm:${batch[0]}`, 0);
    if (!r?.doc) continue;
    for (const name of batch) {
      const d = batch.length === 1 ? r.doc.downloads : r.doc[name]?.downloads;
      record(`npm:${name}`, Number.isFinite(d) ? d : 0);
    }
  }
  for (const s of npm.filter((x) => x.package.startsWith("@"))) {
    counted(`npm:${s.package}`, await ask(`https://api.npmjs.org/downloads/point/last-month/${s.package}`, gapMs.npm), (d) => d?.downloads);
  }
  for (const s of todo.filter((x) => x.registry === "pypi")) {
    counted(`pypi:${s.package}`, await ask(`https://pypistats.org/api/packages/${encodeURIComponent(s.package)}/recent`, gapMs.pypi), (d) => d?.data?.last_month);
  }
  save();
  return out;
}

// uvx runs the command named like the package, at the pinned version (`uvx name@version`, uv's own form).
export function mcpSetup(s) {
  const pinned = `${s.package}@${s.packageVersion}`;
  const mcp = s.registry === "npm"
    ? { command: "npx", args: [...(s.runtimeArgs ?? []), "-y", pinned, ...(s.packageArgs ?? [])] }
    : { command: "uvx", args: [...(s.runtimeArgs ?? []), pinned, ...(s.packageArgs ?? [])] };
  const env = Object.fromEntries(s.env.map((e) => [e.name, `<${e.name.toLowerCase().replace(/_/g, "-")}>`]));
  return {
    steps: ["Add the server to your agent's MCP config", ...(s.env.length ? [`Set ${s.env.map((e) => e.name).join(", ")} in your environment`] : [])],
    mcp: { ...mcp, ...(Object.keys(env).length ? { env } : {}) },
    ...(s.registry === "npm" ? { npm: `${s.package}@${s.packageVersion}` } : { pypi: `${s.package}==${s.packageVersion}` }),
  };
}

// What the decision model is asked about a server: its job, the product it serves, and whether it is for building
// software. Its quality comes from use, not from a description.
export function serverQuestions(taxonomy) {
  return {
    coding: { type: "noul", instructions: "Would a developer use this MCP server while building or running a software project?", criteria: { true: "yes: it helps with software work", false: "no: personal, business, media or other non-software use" } },
    job: { type: "choice", instructions: "Which ONE capability does this MCP server mainly give a coding agent?", criteria: { ...capabilityOptions(taxonomy), none: "none of these" } },
    stack: { type: "choice", instructions: "Is it for one particular language, framework or product? If it works for any project, answer any.", criteria: stackOptions(taxonomy) },
    productBound: { type: "noul", instructions: "Is it only useful together with one specific product, service or account that most repositories do not use?", criteria: { true: "yes: it drives one product or hosted service", false: "no: any project doing this kind of work can use it" } },
    purpose: { type: "choice", instructions: "What is this MCP server mainly for?", criteria: PURPOSES },
  };
}

// What the decision model reads about a server: what the registry says it is.
const serverState = (s) => ({ name: s.title, registry_name: s.name, package: `${s.registry}:${s.package}`, description: s.description || "(none)" });
const gateKey = (s) => obsKey("mcp-gate", s.registry, s.package, s.packageVersion);

// What the store already holds about a server, without the network: its gate result and the decision model's answers
// (null for what was never observed).
export function serverObservations(store, s, { taxonomy, model }) {
  return {
    security: store.getObs("mcp-gate", gateKey(s)),
    answers: store.getObs("mcp-jev", obsKey("mcp-jev", serverState(s), serverQuestions(taxonomy), model)),
  };
}

export async function classifyServer(store, s, { questions, model, env = process.env, fetchImpl } = {}) {
  const state = serverState(s);
  const key = obsKey("mcp-jev", state, questions, model);
  const hit = store.getObs("mcp-jev", key);
  if (hit) return hit;
  const r = await ask(state, questions, { env, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!r || Object.values(r).some((a) => a === null)) return null;
  const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  const obs = {
    coding: round(r.coding.probability), job: r.job.option, jobP: round(r.job.probability), stack: r.stack.option, stackP: round(r.stack.probability),
    productBound: round(r.productBound.probability), purpose: r.purpose.option, purposeP: round(r.purpose.probability), model,
  };
  store.putObs("mcp-jev", key, obs);
  return obs;
}

// The gate for one server, kept per package version: a version does not change once published.
export async function gateServer(store, s, { fetchImpl, now = new Date() } = {}) {
  const key = gateKey(s);
  const hit = store.getObs("mcp-gate", key);
  if (hit && now - new Date(hit.scannedAt) < 7 * DAY) return hit;
  const sec = await setupSecurity(mcpSetup(s), { fetchImpl, now });
  // A registry that did not answer is not a verdict on the package: asked again next run.
  if (!sec.findings.some((f) => String(f.note ?? "").startsWith("could not verify"))) store.putObs("mcp-gate", key, sec);
  return sec;
}

export async function ingestMcp(store, { taxonomy, minDownloads = 1000, jev = true, concurrency = 4, fetchImpl, env = process.env, sleep, log = () => {} } = {}) {
  const servers = (await fetchRegistry({ fetchImpl, log })).map(localServer).filter(Boolean);
  // One entry per package: several registry names can publish the same package.
  const byPackage = new Map();
  for (const s of servers) if (!byPackage.has(`${s.registry}:${s.package}`)) byPackage.set(`${s.registry}:${s.package}`, s);
  const unique = [...byPackage.values()];
  log(`${unique.length} locally installable servers`);
  const counts = await downloads(unique, { store, fetchImpl, log, ...(sleep ? { sleep } : {}) });
  const popular = unique.map((s) => ({ ...s, downloads: counts.get(`${s.registry}:${s.package}`) ?? 0 })).filter((s) => s.downloads >= minDownloads).sort((a, b) => b.downloads - a.downloads);
  log(`${popular.length} with at least ${minDownloads} downloads a month`);
  const questions = serverQuestions(taxonomy);
  const model = jevConfig(env).model;
  let done = 0;
  await mapLimit(popular, concurrency, async (s) => {
    s.security = await gateServer(store, s, { fetchImpl });
    if (jev) s.answers = await classifyServer(store, s, { questions, model, env, fetchImpl });
    if (++done % 100 === 0) log(`gated and classified ${done}/${popular.length}`);
  });
  store.putState("mcp", { at: new Date().toISOString(), minDownloads, servers: popular.map(({ security, answers, ...s }) => s) });
  return { servers: unique.length, popular: popular.length };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const store = createStore(resolve(flag(args, "--store", "store")));
  const taxonomy = extendTaxonomyV2(extendTaxonomy(JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"))));
  const t0 = Date.now();
  const r = await ingestMcp(store, {
    taxonomy, minDownloads: Number(flag(args, "--min-downloads", "1000")), jev: !args.includes("--no-jev"), concurrency: Number(flag(args, "--concurrency", "4")),
    log: logStamped,
  });
  console.log(JSON.stringify({ ...r, seconds: Math.round((Date.now() - t0) / 1000) }));
}
