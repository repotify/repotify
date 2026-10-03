import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { localServer, fixedArguments, mcpSetup, fetchRegistry, downloads, gateServer, ingestMcp, serverQuestions, politeClient, pypiDownloadsBulk, startsServer, repoStats, searchRepos } from "../pipeline/mcp.mjs";
import { createStore } from "../pipeline/store.mjs";
import { flag, logStamped } from "../pipeline/lib/cli.mjs";

const tempDirs = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
const tempStore = () => {
  const d = mkdtempSync(join(tmpdir(), "rp-mcp-"));
  tempDirs.push(d);
  return createStore(d);
};

const json = (status, doc) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => doc });
const server = (pkg, extra = {}) => ({ name: "io.github.acme/thing", title: "Thing", description: "Does  things\nwell", version: "1.2.0", repository: { url: "https://github.com/Acme/Thing.git" }, packages: [pkg], ...extra });

test("a local server is one pinned npm or PyPI package over stdio; remote and unsafe ones are left out", () => {
  const s = localServer(server({ registryType: "npm", identifier: "@Acme/Thing-MCP", version: "1.2.0", transport: { type: "stdio" }, environmentVariables: [{ name: "ACME_TOKEN", isRequired: true, isSecret: true }, { name: "bad name" }] }));
  assert.equal(s.package, "@acme/thing-mcp");
  assert.equal(s.repo, "acme/thing");
  assert.equal(s.description, "Does things well");
  assert.deepEqual(s.env, [{ name: "ACME_TOKEN", required: true, secret: true }]);
  assert.equal(localServer(server({ registryType: "npm", identifier: "thing", version: "1.0.0", transport: { type: "streamable-http" } })), null, "remote transport");
  assert.equal(localServer(server({ registryType: "oci", identifier: "acme/thing", version: "1.0.0" })), null, "container image");
  assert.equal(localServer(server({ registryType: "npm", identifier: "thing; rm -rf ~", version: "1.0.0" })), null, "unsafe name");
  assert.equal(localServer(server({ registryType: "npm", identifier: "thing", version: "latest" })), null, "unpinned version");
  assert.equal(localServer(server({ registryType: "pypi", identifier: "thing", version: "1.0.0", packageArguments: [{ type: "positional", valueHint: "directory", isRequired: true }] })), null, "needs a path only the user knows");
});

test("fixed arguments: values the publisher gives are passed, optional ones skipped, anything else refused", () => {
  assert.deepEqual(fixedArguments([{ type: "named", name: "--transport", value: "stdio" }, { type: "positional", value: "serve" }, { type: "named", name: "--port" }]), ["--transport", "stdio", "serve"]);
  assert.deepEqual(fixedArguments([{ type: "named", name: "--mode", isRequired: true, default: "local" }]), ["--mode", "local"]);
  assert.equal(fixedArguments([{ type: "positional", isRequired: true }]), null);
  assert.equal(fixedArguments([{ type: "positional", value: "$(curl evil)" }]), null);
  assert.equal(fixedArguments([{ type: "named", name: "--dir", value: "{workspace}" }]), null);
  assert.deepEqual(fixedArguments(undefined), []);
});

test("the setup is pinned to the version the gate checked, with placeholders for the user's keys", () => {
  const npm = mcpSetup({ registry: "npm", package: "@acme/thing", packageVersion: "1.2.0", env: [{ name: "ACME_TOKEN" }], packageArgs: ["--stdio"] });
  assert.deepEqual(npm.mcp, { command: "npx", args: ["-y", "@acme/thing@1.2.0", "--stdio"], env: { ACME_TOKEN: "<acme-token>" } });
  assert.equal(npm.npm, "@acme/thing@1.2.0");
  assert.match(npm.steps.join("\n"), /Set ACME_TOKEN/);
  const py = mcpSetup({ registry: "pypi", package: "thing-mcp", packageVersion: "0.4.1", env: [] });
  assert.deepEqual(py.mcp, { command: "uvx", args: ["thing-mcp@0.4.1"] });
  assert.equal(py.pypi, "thing-mcp==0.4.1");
});

test("what the publisher wrote as a runtime argument but meant for the package goes after the package", () => {
  const firebase = localServer(server({ registryType: "npm", identifier: "firebase-tools", version: "14.27.0", runtimeHint: "npx", runtimeArguments: [{ value: "mcp", type: "positional" }, { type: "named", name: "--yes", value: "true" }] }, { name: "io.github.firebase/firebase-mcp" }));
  assert.deepEqual([firebase.runtimeArgs, firebase.packageArgs], [["--yes", "true"], ["mcp"]]);
  assert.deepEqual(mcpSetup(firebase).mcp.args, ["--yes", "true", "-y", "firebase-tools@14.27.0", "mcp"]);
  // A record made before that rule keeps its positional runtime argument: it still lands after the package.
  assert.deepEqual(mcpSetup({ registry: "npm", package: "firebase-tools", packageVersion: "14.27.0", env: [], runtimeArgs: ["mcp"] }).mcp.args, ["-y", "firebase-tools@14.27.0", "mcp"]);
  assert.deepEqual(mcpSetup({ registry: "pypi", package: "thing", packageVersion: "1.0", env: [], runtimeArgs: ["--python", "3.12"], packageArgs: ["serve"] }).mcp.args, ["--python", "3.12", "thing@1.0", "serve"]);
});

test("a package starts a server when it is one, or when its publisher says how", () => {
  const s = (extra) => ({ name: "io.github.acme/thing", package: "thing", description: "Does things.", ...extra });
  assert.equal(startsServer(s({ package: "@playwright/mcp" })), true);
  assert.equal(startsServer(s({ package: "nx-mcp" })), true);
  assert.equal(startsServer(s({ name: "io.github.firebase/firebase-mcp", package: "firebase-tools", runtimeArgs: ["mcp"] })), true);
  assert.equal(startsServer(s({ package: "@bytebase/dbhub", description: "Token-efficient database MCP server for PostgreSQL." })), true);
  assert.equal(startsServer(s({ package: "vibeview", packageArgs: ["--stdio"] })), true);
  assert.equal(startsServer(s({ package: "seleniumbase", description: "Stealthy browser automation, testing, and web-scraping via CDP Mode." })), false);
  assert.equal(startsServer(s({ package: "semiotic", description: "Verified React chart generation through MCP." })), false);
  assert.equal(startsServer(s({ package: "xcodebuildmcp" })), true, "written together at the end of a name");
  assert.equal(startsServer(s({ package: "mcpify" })), true);
  assert.equal(startsServer(s({ package: "armcpu-tool" })), false, "mcp inside a longer word is not the word");
});

test("the gate also records whether an npm package has a command to run", async () => {
  const store = tempStore();
  const withBin = async (url) => json(200, url.includes("osv.dev") ? {} : { scripts: {}, bin: { server: "index.js" } });
  const noBin = async (url) => json(200, url.includes("osv.dev") ? {} : { scripts: {} });
  let npmCalls = 0;
  const counting = async (url, init) => {
    if (url.startsWith("https://registry.npmjs.org/") && url.endsWith("/1.0.0")) npmCalls++;
    return withBin(url, init);
  };
  assert.equal((await gateServer(store, { registry: "npm", package: "@acme/one", packageVersion: "1.0.0", env: [] }, { fetchImpl: counting })).runnable, true);
  assert.equal(npmCalls, 1, "the version document is read once for install scripts and the command");
  assert.equal((await gateServer(store, { registry: "npm", package: "two", packageVersion: "1.0.0", env: [] }, { fetchImpl: noBin })).runnable, false);
  assert.equal((await gateServer(store, { registry: "pypi", package: "three", packageVersion: "1.0.0", env: [] }, { fetchImpl: withBin })).runnable, null, "PyPI does not list commands");
});

test("repository stars and age come from GitHub in batches and are kept for the week", async () => {
  const store = tempStore();
  const asked = [];
  const gh = { graphql: async (query) => {
    asked.push(query);
    return { data: { r0: { nameWithOwner: "acme/one", stargazerCount: 1200, forkCount: 3, createdAt: "2025-01-01T00:00:00Z", pushedAt: "2026-09-30T00:00:00Z", isArchived: false, isFork: false }, r1: null } };
  } };
  const servers = [{ repo: "acme/one" }, { repo: "ghost/gone" }, { repo: null }, { repo: "acme/one" }];
  const now = new Date("2026-10-02T00:00:00Z");
  const stats = await repoStats(store, servers, { gh, now });
  assert.equal(asked.length, 1);
  assert.deepEqual(stats.get("acme/one"), { stars: 1200, createdAt: "2025-01-01T00:00:00Z", pushedAt: "2026-09-30T00:00:00Z", archived: false });
  assert.deepEqual(stats.get("ghost/gone"), { missing: true });
  await repoStats(store, servers, { gh, now });
  assert.equal(asked.length, 1, "known repositories are not asked about again this week");
  // Without an account: GitHub's search, six repositories a request, only for the servers worth asking about.
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (urls.length > 2) return json(403, { message: "rate limit" });
    return json(200, { items: [{ full_name: "Org/R0", stargazers_count: 350, created_at: "2024-05-05T00:00:00Z", pushed_at: "2026-09-01T00:00:00Z", archived: true }, { full_name: "someone/else", stargazers_count: 9 }] });
  };
  const many = Array.from({ length: 15 }, (_, i) => ({ repo: `org/r${i}`, downloads: i < 14 ? 20000 : 5 }));
  const waits = [];
  const anon = await repoStats(tempStore(), many, { gh: null, fetchImpl, sleep: async (ms) => waits.push(ms), worth: (srv) => srv.downloads >= 10000, now });
  assert.equal(urls.length, 3, "14 repositories worth asking about: three requests, the third refused");
  assert.match(urls[0], /q=repo:org\/r0\+repo:org\/r1\+.*repo:org\/r5&/);
  assert.deepEqual(anon.get("org/r0"), { stars: 350, createdAt: "2024-05-05T00:00:00Z", pushedAt: "2026-09-01T00:00:00Z", archived: true });
  assert.deepEqual(anon.get("org/r7"), { missing: true });
  assert.equal(anon.has("org/r12"), false, "what was not answered stays unknown");
  assert.equal(anon.has("org/r14"), false, "too few downloads for its stars to matter");
  assert.ok(waits.includes(6500));
  assert.deepEqual([...(await searchRepos([], { fetchImpl }))], []);
});

test("the registry is read page by page, latest versions only", async () => {
  const pages = {
    "": { servers: [{ server: { name: "a" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } } }, { server: { name: "a-old" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } }], metadata: { nextCursor: "c1" } },
    c1: { servers: [{ server: { name: "b" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } } }], metadata: {} },
  };
  const fetchImpl = async (url) => json(200, pages[new URL(url).searchParams.get("cursor") ?? ""]);
  assert.deepEqual((await fetchRegistry({ fetchImpl })).map((s) => s.name), ["a", "b"]);
});

test("downloads: npm in bulk and one by one, PyPI through pypistats; unknown packages count 0, failures are asked again", async () => {
  const store = tempStore();
  const servers = [
    { registry: "npm", package: "alpha" }, { registry: "npm", package: "beta" }, { registry: "npm", package: "@scope/gamma" },
    { registry: "npm", package: "@scope/missing" }, { registry: "pypi", package: "delta" }, { registry: "pypi", package: "flaky" },
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("clickhouse")) return json(503, null);
    if (url.includes("/last-month/alpha,beta")) return json(200, { alpha: { downloads: 5000 }, beta: null });
    if (url.endsWith("/@scope/gamma")) return json(200, { downloads: 1200 });
    if (url.endsWith("/@scope/missing")) return json(404, { error: "not found" });
    if (url.includes("/packages/delta/")) return json(200, { data: { last_month: 777 } });
    if (url.includes("/packages/flaky/")) throw new Error("network down");
    throw new Error(`unexpected ${url}`);
  };
  const now = new Date("2026-10-02T00:00:00Z");
  const sleep = async () => {};
  const first = await downloads(servers, { store, fetchImpl, now, sleep });
  assert.deepEqual(Object.fromEntries(first), { "npm:alpha": 5000, "npm:beta": 0, "npm:@scope/gamma": 1200, "npm:@scope/missing": 0, "pypi:delta": 777 });
  calls.length = 0;
  const again = await downloads(servers, { store, fetchImpl, now, sleep });
  assert.equal(again.get("npm:alpha"), 5000);
  assert.ok(calls.every((u) => u.includes("flaky") || u.includes("clickhouse")), `only the failed lookup is repeated: ${calls}`);
  calls.length = 0;
  await downloads(servers, { store, fetchImpl, now: new Date("2026-10-20T00:00:00Z"), sleep });
  assert.ok(calls.length >= 4, "a new week asks again");
});

test("PyPI downloads come in bulk for normalised names; unknown projects count 0; no answer is no result", async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(init.body);
    return json(200, { data: [{ project: "mcp-server-fetch", d: "474070" }, { project: "someone-else", d: "9" }] });
  };
  const got = await pypiDownloadsBulk(["MCP_Server.Fetch", "ghost-mcp", "bad'name; DROP"], { fetchImpl });
  assert.deepEqual([...got], [["mcp-server-fetch", 474070], ["ghost-mcp", 0]]);
  assert.match(asked[0], /project IN \('mcp-server-fetch','ghost-mcp'\)/, "only plain names reach the query");
  assert.equal(await pypiDownloadsBulk(["a"], { fetchImpl: async () => json(500, null), sleep: async () => {} }), null);
  assert.equal(await pypiDownloadsBulk(["a"], { fetchImpl: async () => json(200, { error: "x" }) }), null);
  assert.equal(await pypiDownloadsBulk(["a"], { fetchImpl: async () => { throw new Error("down"); }, sleep: async () => {} }), null);
  // The download count uses it when it answers, and records every project it asked about.
  const store = tempStore();
  const counts = await downloads([{ registry: "pypi", package: "mcp_server.fetch" }, { registry: "pypi", package: "ghost-mcp" }], { store, fetchImpl, sleep: async () => {}, now: new Date("2026-10-02T00:00:00Z") });
  assert.deepEqual(Object.fromEntries(counts), { "pypi:mcp_server.fetch": 474070, "pypi:ghost-mcp": 0 });
});

test("a host that asks to slow down is waited for, longer each time, and left for the next run if it keeps refusing", async () => {
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  let refusals = 2;
  const fetchImpl = async (url) => (url.includes("busy") || refusals-- > 0 ? json(429, null) : json(200, { downloads: 9 }));
  const ask = politeClient({ fetchImpl, sleep, firstWaitMs: 1000, maxRefusals: 3 });
  const r = await ask("https://api.npmjs.org/downloads/point/last-month/x", 300);
  assert.equal(r.doc.downloads, 9);
  assert.deepEqual(waits, [1000, 2000, 1200], "two refusals, then a pause twice doubled after the request");
  waits.length = 0;
  assert.equal(await ask("https://busy.example/a", 300), null);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(await ask("https://busy.example/b", 300), null, "a host that keeps refusing is not asked again this run");
  assert.equal((await ask("https://api.npmjs.org/downloads/point/last-month/y", 300)).status, 200, "other hosts are still asked");
  waits.length = 0;
  for (let i = 0; i < 60; i++) await ask("https://api.npmjs.org/downloads/point/last-month/z", 300);
  assert.equal(waits[0], 1200);
  assert.ok(waits.at(-1) < waits[0] && waits.at(-1) >= 300, `the pause eases back while the host answers: ${waits.at(-1)}`);
});

test("the gate result is kept per package version, but not when a registry did not answer", async () => {
  const store = tempStore();
  const s = { registry: "npm", package: "alpha", packageVersion: "1.0.0", env: [] };
  let up = false;
  let asked = 0;
  const fetchImpl = async (url) => {
    asked++;
    if (!up) throw new Error("offline");
    if (url.startsWith("https://registry.npmjs.org/")) return json(200, { scripts: { test: "node test.js" } });
    return json(200, { vulns: [] });
  };
  const down = await gateServer(store, s, { fetchImpl });
  assert.ok(down.findings.some((f) => /could not verify/.test(f.note)));
  up = true;
  const ok = await gateServer(store, s, { fetchImpl });
  assert.equal(ok.findings.length, 0);
  const before = asked;
  await gateServer(store, s, { fetchImpl });
  assert.equal(asked, before, "a verified result is reused");
});

const taxonomy = JSON.parse(readFileSync(new URL("../catalog/taxonomy.json", import.meta.url), "utf8"));

test("ingest: registry to store, popular servers only, each gated and classified once", async () => {
  const store = tempStore();
  const latest = { "io.modelcontextprotocol.registry/official": { isLatest: true } };
  const registry = {
    servers: [
      { server: { name: "io.github.acme/browser", description: "Drives a browser", version: "2.0.0", repository: { url: "https://github.com/acme/browser" }, packages: [{ registryType: "npm", identifier: "acme-browser-mcp", version: "2.0.0", transport: { type: "stdio" } }] }, _meta: latest },
      { server: { name: "io.github.acme/pydocs", description: "Reads docs", version: "0.3.0", packages: [{ registryType: "pypi", identifier: "acme-docs-mcp", version: "0.3.0" }] }, _meta: latest },
      { server: { name: "io.github.acme/tiny", description: "Few users", version: "0.1.0", packages: [{ registryType: "npm", identifier: "tiny-mcp", version: "0.1.0" }] }, _meta: latest },
      { server: { name: "io.github.acme/remote", description: "Hosted", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://acme.example/mcp" }] }, _meta: latest },
    ],
    metadata: {},
  };
  const asked = { jev: 0, gate: 0 };
  const answers = {
    coding: { noul: 0.97 }, productBound: { noul: 0.1 },
    job: { choice: Object.keys(taxonomy.capabilities)[0], probabilities: { [Object.keys(taxonomy.capabilities)[0]]: 0.9 } },
    stack: { choice: "any", probabilities: { any: 0.95 } },
    purpose: { choice: "product", probabilities: { product: 0.8 } },
  };
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith("https://registry.modelcontextprotocol.io/")) return json(200, registry);
    if (url.includes("/downloads/point/last-month/acme-browser-mcp,tiny-mcp")) return json(200, { "acme-browser-mcp": { downloads: 52000 }, "tiny-mcp": { downloads: 12 } });
    if (url.includes("clickhouse")) return json(200, { data: [{ project: "acme-docs-mcp", d: "3100" }] });
    if (url.startsWith("https://registry.npmjs.org/") || url.startsWith("https://pypi.org/")) return (asked.gate++, json(200, { scripts: {} }));
    if (url === "https://api.osv.dev/v1/query") return json(200, {});
    if (url === "https://jev.test/v1") {
      asked.jev++;
      assert.deepEqual(Object.keys(JSON.parse(init.body).questions).sort(), Object.keys(serverQuestions(taxonomy)).sort());
      return json(200, { answers });
    }
    throw new Error(`unexpected ${url}`);
  };
  const env = { JEV_API_KEY: "test-key", JEV_ENDPOINT: "https://jev.test/v1", JEV_MODEL: "test/jev" };
  const logs = [];
  const sleep = async () => {};
  const r = await ingestMcp(store, { taxonomy, fetchImpl, env, sleep, log: (m) => logs.push(m) });
  assert.deepEqual(r, { servers: 3, popular: 2 });
  const state = store.getState("mcp");
  assert.deepEqual(state.servers.map((x) => [x.package, x.downloads]), [["acme-browser-mcp", 52000], ["acme-docs-mcp", 3100]]);
  assert.equal(state.minDownloads, 1000);
  assert.equal(asked.jev, 2);
  assert.ok(logs.some((m) => /3 locally installable servers/.test(m)) && logs.some((m) => /2 with at least 1000/.test(m)), logs.join("\n"));
  const again = await ingestMcp(store, { taxonomy, fetchImpl, env, sleep });
  assert.deepEqual(again, { servers: 3, popular: 2 });
  assert.equal(asked.jev, 2, "classified once per server description");
  const quiet = await ingestMcp(tempStore(), { taxonomy, fetchImpl, env: {}, sleep, jev: false });
  assert.equal(quiet.popular, 2, "without the decision model the servers are still gated and kept");
});

test("pipeline scripts read --name value flags and log with a timestamp", (t) => {
  assert.equal(flag(["--store", "dir", "--dry-run"], "--store"), "dir");
  assert.equal(flag(["--dry-run"], "--store", "store"), "store");
  assert.equal(flag([], "--only"), null);
  const lines = [];
  t.mock.method(console, "error", (m) => lines.push(m));
  logStamped("hello");
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello$/);
});
