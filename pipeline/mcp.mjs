#!/usr/bin/env node
// MCP servers for the catalog, from the official MCP registry (registry.modelcontextprotocol.io): every server whose
// latest version installs locally from npm or PyPI, with how much people use it (npm and PyPI downloads, not stars),
// its security gate (the scanner on its command, install scripts, known vulnerabilities of the pinned version) and the
// decision model's answers about what it is for. Kept in the content store like skills, so pipeline/derive.mjs turns
// them into catalog items without the network.
//   JEV_API_KEY=… [GITHUB_TOKEN=…] node pipeline/mcp.mjs --store DIR [--min-downloads 1000] [--no-jev] [--concurrency 4] [--from-state]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain } from "../src/util.mjs";
import { ask, jevConfig } from "../lib/signals/jev.mjs";
import { createStore, obsKey } from "./store.mjs";
import { setupSecurity } from "./gate.mjs";
import { fetchWithRetry } from "./lib/http.mjs";
import { githubClient } from "./github.mjs";
import { metaByName } from "./crawl.mjs";
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
  // Publishers write `firebase-tools mcp` as a positional "runtime" argument; put before the package it would be read
  // as the package to run. Only named runtime arguments (flags of npx or uvx) go before it.
  const runtime = Array.isArray(pkg.runtimeArguments) ? pkg.runtimeArguments : [];
  const runtimeArgs = fixedArguments(runtime.filter((a) => a?.type === "named"));
  const packageArgs = fixedArguments([...runtime.filter((a) => a?.type !== "named"), ...(Array.isArray(pkg.packageArguments) ? pkg.packageArguments : [])]);
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
// "retry-after: 0" and refuses again) a wait that doubles. The pause itself adapts: it doubles after a refusal and
// eases back after twenty answers in a row, so the pace settles at what the host accepts. A host that keeps refusing
// is left for the next run.
export function politeClient({ fetchImpl, sleep, log = () => {}, firstWaitMs = 30000, maxRefusals = 6, maxGapMs = 8000 } = {}) {
  const hosts = new Map();
  return async function ask(url, gapMs) {
    const host = new URL(url).host;
    const h = hosts.get(host) ?? hosts.set(host, { refused: 0, gap: gapMs, streak: 0 }).get(host);
    for (let wait = firstWaitMs; ; wait *= 2) {
      if (h.refused >= maxRefusals) return null;
      const r = await getJson(url, { fetchImpl, sleep, retries: 0 });
      if (r.status !== 429) {
        h.refused = 0;
        if (++h.streak >= 20) {
          h.streak = 0;
          h.gap = Math.max(gapMs, Math.round(h.gap * 0.8));
        }
        await sleep(h.gap);
        return r;
      }
      h.refused++;
      h.streak = 0;
      h.gap = Math.min(maxGapMs, h.gap * 2);
      log(`${host} asks to slow down; waiting ${Math.round(wait / 1000)}s, then one request every ${h.gap} ms`);
      await sleep(wait);
    }
  };
}

const CLICKHOUSE = "https://sql-clickhouse.clickhouse.com/?user=demo";
const pep503 = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");

// PyPI downloads of the last 30 days for many projects in one question, from ClickHouse's public PyPI dataset (the
// data behind clickpy.clickhouse.com): Map of normalised name -> downloads, 0 for a project it does not know. null
// when the service does not answer, and the caller asks pypistats one project at a time.
export async function pypiDownloadsBulk(names, { fetchImpl = fetch, sleep, timeoutMs = 60000, batchSize = 400 } = {}) {
  // Names go into the query text: only what a normalised project name can contain.
  const safe = [...new Set(names.map(pep503))].filter((n) => /^[a-z0-9-]+$/.test(n));
  const out = new Map();
  for (let i = 0; i < safe.length; i += batchSize) {
    const batch = safe.slice(i, i + batchSize);
    const sql = `SELECT project, sum(count) AS d FROM pypi.pypi_downloads_per_day WHERE date > today() - 30 AND project IN (${batch.map((n) => `'${n}'`).join(",")}) GROUP BY project FORMAT JSON`;
    let doc;
    try {
      const res = await fetchWithRetry(CLICKHOUSE, { method: "POST", body: sql, headers: { "User-Agent": "repotify-pipeline", "Content-Type": "text/plain" } }, { fetchImpl, retries: 2, timeoutMs, ...(sleep ? { sleep } : {}) });
      if (!res.ok) return null;
      doc = await res.json();
    } catch {
      return null;
    }
    if (!Array.isArray(doc?.data)) return null;
    for (const n of batch) out.set(n, 0);
    for (const row of doc.data) if (out.has(String(row.project)) && Number.isFinite(Number(row.d))) out.set(String(row.project), Number(row.d));
  }
  return out;
}

// Monthly downloads: npm in bulk (unscoped names, 128 a request) or one by one (scoped); PyPI in bulk from the
// public ClickHouse dataset, or through pypistats one by one when that does not answer.
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
  // One lane for each host, side by side: each is asked one request at a time.
  const npmLane = async () => {
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
  };
  const pypiLane = async () => {
    const pending = todo.filter((x) => x.registry === "pypi");
    if (!pending.length) return;
    const bulk = await pypiDownloadsBulk(pending.map((s) => s.package), { fetchImpl, sleep });
    if (bulk) {
      for (const s of pending) if (bulk.has(pep503(s.package))) record(`pypi:${s.package}`, bulk.get(pep503(s.package)));
      return;
    }
    log("the bulk PyPI source did not answer; asking pypistats one project at a time");
    for (const s of pending) {
      counted(`pypi:${s.package}`, await ask(`https://pypistats.org/api/packages/${encodeURIComponent(s.package)}/recent`, gapMs.pypi), (d) => d?.data?.last_month);
    }
  };
  await Promise.all([npmLane(), pypiLane()]);
  save();
  return out;
}

// uvx runs the command named like the package, at the pinned version (`uvx name@version`, uv's own form).
export function mcpSetup(s) {
  const pinned = `${s.package}@${s.packageVersion}`;
  const runtime = s.runtimeArgs ?? [];
  const firstFlag = runtime.findIndex((a) => a.startsWith("-"));
  const flags = firstFlag < 0 ? [] : runtime.slice(firstFlag);
  const after = [...(firstFlag < 0 ? runtime : runtime.slice(0, firstFlag)), ...(s.packageArgs ?? [])];
  const mcp = s.registry === "npm"
    ? { command: "npx", args: [...flags, "-y", pinned, ...after] }
    : { command: "uvx", args: [...flags, pinned, ...after] };
  const env = Object.fromEntries(s.env.map((e) => [e.name, `<${e.name.toLowerCase().replace(/_/g, "-")}>`]));
  return {
    steps: ["Add the server to your agent's MCP config", ...(s.env.length ? [`Set ${s.env.map((e) => e.name).join(", ")} in your environment`] : [])],
    mcp: { ...mcp, ...(Object.keys(env).length ? { env } : {}) },
    ...(s.registry === "npm" ? { npm: `${s.package}@${s.packageVersion}` } : { pypi: `${s.package}==${s.packageVersion}` }),
  };
}

// A package made to be an MCP server starts one when it is run. A general tool that also has an MCP mode starts
// something else, unless its publisher says how (an argument such as `mcp`): without that the command would not
// give the agent a server, however many people download the tool.
export function startsServer(s) {
  const named = (text) => /(^|[^a-z])mcp|mcp([^a-z]|$)/i.test(String(text ?? ""));
  const args = [...(s.runtimeArgs ?? []), ...(s.packageArgs ?? [])];
  return named(s.package) || named(String(s.name ?? "").split("/").pop()) || /\bMCP server\b/i.test(String(s.description ?? "")) || args.some((a) => /mcp|stdio|serve/i.test(a));
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
// Bumped when what the gate records about a server changes, so stored results are made again.
const MCP_GATE = 3;
const gateKey = (s) => obsKey("mcp-gate", s.registry, s.package, s.packageVersion, MCP_GATE);

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

// GET requests answered once per URL within one gate run: the npm version document is read for install scripts and
// again for its command.
function onceFetch(fetchImpl = fetch) {
  const seen = new Map();
  return async (url, init) => {
    if (init?.method && init.method !== "GET") return fetchImpl(url, init);
    if (!seen.has(url)) {
      seen.set(url, (async () => {
        const res = await fetchImpl(url, init);
        const doc = res.ok ? await res.json().catch(() => null) : null;
        return { ok: res.ok, status: res.status, doc };
      })());
    }
    const r = await seen.get(url);
    return { ok: r.ok, status: r.status, headers: new Headers(), json: async () => r.doc };
  };
}

// Whether `npx <package>` has anything to run: the version's `bin`. null when npm did not answer or for PyPI, whose
// index does not list a package's commands.
async function runnable(s, fetchImpl) {
  if (s.registry !== "npm") return null;
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${s.package.replace("/", "%2f")}/${s.packageVersion}`);
    if (!res.ok) return null;
    const bin = (await res.json())?.bin;
    return typeof bin === "string" ? bin.length > 0 : Boolean(bin && typeof bin === "object" && Object.keys(bin).length);
  } catch {
    return null;
  }
}

// The gate for one server, kept per package version: a version does not change once published.
export async function gateServer(store, s, { fetchImpl, now = new Date() } = {}) {
  const key = gateKey(s);
  const hit = store.getObs("mcp-gate", key);
  if (hit && now - new Date(hit.scannedAt) < 7 * DAY) return hit;
  const once = onceFetch(fetchImpl);
  const sec = { ...(await setupSecurity(mcpSetup(s), { fetchImpl: once, now })), runnable: await runnable(s, once) };
  // A registry that did not answer is not a verdict on the package: asked again next run.
  if (!sec.findings.some((f) => String(f.note ?? "").startsWith("could not verify"))) store.putObs("mcp-gate", key, sec);
  return sec;
}

// What GitHub's search says about several repositories in one request, with no account: six `repo:` terms a query,
// ten queries a minute. Map of repository -> { stars, createdAt, pushedAt, archived }; a repository it does not
// return is recorded as missing. Stops at the first refusal and keeps what it has.
export async function searchRepos(repos, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 6500, log = () => {} } = {}) {
  const out = new Map();
  for (let i = 0; i < repos.length; i += 6) {
    const batch = repos.slice(i, i + 6);
    const { status, doc } = await getJson(`https://api.github.com/search/repositories?q=${batch.map((r) => `repo:${r}`).join("+")}&per_page=20`, { fetchImpl, sleep, retries: 0 });
    if (status !== 200 || !Array.isArray(doc?.items)) {
      log(`GitHub search stopped answering (HTTP ${status}) after ${out.size} repositories`);
      break;
    }
    for (const r of batch) out.set(r, { missing: true });
    for (const item of doc.items) {
      const name = String(item.full_name ?? "").toLowerCase();
      if (out.has(name)) out.set(name, { stars: item.stargazers_count ?? 0, createdAt: item.created_at ?? null, pushedAt: item.pushed_at ?? null, archived: Boolean(item.archived) });
    }
    if (i + 6 < repos.length) await sleep(pauseMs);
  }
  return out;
}

// What GitHub says about each server's repository (stars, age, archived), kept for the week: downloads can be padded,
// so a default pick also needs a repository people starred. With an account's client every repository is asked about
// in batches; without one, GitHub's search is asked about the repositories of the servers `worth` asking for (those
// with enough downloads for the stars to matter).
export async function repoStats(store, servers, { gh = null, fetchImpl, sleep, worth = () => true, now = new Date(), log = () => {} } = {}) {
  const week = Math.floor(now.getTime() / (7 * DAY));
  const saved = store.getState("mcp-repos");
  const known = new Map(saved?.week === week ? Object.entries(saved.repos ?? {}) : []);
  const wanted = gh ? servers : servers.filter(worth);
  const missing = [...new Set(wanted.map((s) => s.repo).filter((r) => r && !known.has(r)))];
  if (!missing.length) return known;
  let found;
  if (gh) {
    const metas = await metaByName(gh, missing, { log });
    found = new Map(missing.map((repo) => {
      const m = metas.get(repo);
      return [repo, m ? { stars: m.stars, createdAt: m.createdAt, pushedAt: m.pushedAt, archived: m.archived } : { missing: true }];
    }));
  } else {
    found = await searchRepos(missing, { fetchImpl, log, ...(sleep ? { sleep } : {}) });
  }
  for (const [repo, stats] of found) known.set(repo, stats);
  store.putState("mcp-repos", { week, repos: Object.fromEntries(known) });
  log(`repositories: ${[...found.values()].filter((r) => !r.missing).length} of ${missing.length} found on GitHub`);
  return known;
}

export async function ingestMcp(store, { taxonomy, minDownloads = 1000, statsFloor = 10000, jev = true, concurrency = 4, fetchImpl, env = process.env, sleep, gh = null, fromState = false, log = () => {} } = {}) {
  let unique;
  let popular;
  if (fromState) {
    // The servers of the last run again: their gate, repositories and answers, without reading the registry.
    popular = (store.getState("mcp")?.servers ?? []).map(({ stars, repoCreatedAt, repoPushedAt, archived, ...s }) => s);
    unique = popular;
    log(`${popular.length} servers from the last run`);
  } else {
    const servers = (await fetchRegistry({ fetchImpl, log })).map(localServer).filter(Boolean);
    // One entry per package: several registry names can publish the same package.
    const byPackage = new Map();
    for (const s of servers) if (!byPackage.has(`${s.registry}:${s.package}`)) byPackage.set(`${s.registry}:${s.package}`, s);
    unique = [...byPackage.values()];
    log(`${unique.length} locally installable servers`);
    const counts = await downloads(unique, { store, fetchImpl, log, ...(sleep ? { sleep } : {}) });
    popular = unique.map((s) => ({ ...s, downloads: counts.get(`${s.registry}:${s.package}`) ?? 0 })).filter((s) => s.downloads >= minDownloads).sort((a, b) => b.downloads - a.downloads);
    log(`${popular.length} with at least ${minDownloads} downloads a month`);
  }
  const repos = await repoStats(store, popular, { gh, fetchImpl, log, worth: (s) => s.downloads >= statsFloor, ...(sleep ? { sleep } : {}) });
  for (const s of popular) {
    const r = repos.get(s.repo);
    if (r && !r.missing) Object.assign(s, { stars: r.stars, repoCreatedAt: r.createdAt, repoPushedAt: r.pushedAt, archived: r.archived });
  }
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
  const token = process.env.GITHUB_TOKEN || null;
  const r = await ingestMcp(store, {
    taxonomy, minDownloads: Number(flag(args, "--min-downloads", "1000")), jev: !args.includes("--no-jev"), concurrency: Number(flag(args, "--concurrency", "4")),
    fromState: args.includes("--from-state"), gh: token ? githubClient({ token, log: logStamped }) : null,
    log: logStamped,
  });
  console.log(JSON.stringify({ ...r, seconds: Math.round((Date.now() - t0) / 1000) }));
}
