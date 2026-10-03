import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { localServer, fixedArguments, mcpSetup, fetchRegistry, downloads, gateServer, ingestMcp, serverQuestions, politeClient } from "../pipeline/mcp.mjs";
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
  assert.ok(calls.every((u) => u.includes("flaky")), `only the failed lookup is repeated: ${calls}`);
  calls.length = 0;
  await downloads(servers, { store, fetchImpl, now: new Date("2026-10-20T00:00:00Z"), sleep });
  assert.ok(calls.length >= 4, "a new week asks again");
});

test("a host that asks to slow down is waited for, longer each time, and left for the next run if it keeps refusing", async () => {
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  let refusals = 2;
  const fetchImpl = async (url) => (url.includes("busy") || refusals-- > 0 ? json(429, null) : json(200, { downloads: 9 }));
  const ask = politeClient({ fetchImpl, sleep, firstWaitMs: 1000, maxRefusals: 3 });
  const r = await ask("https://api.npmjs.org/downloads/point/last-month/x", 300);
  assert.equal(r.doc.downloads, 9);
  assert.deepEqual(waits, [1000, 2000, 300], "two refusals, then the pause after a request");
  waits.length = 0;
  assert.equal(await ask("https://busy.example/a", 300), null);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(await ask("https://busy.example/b", 300), null, "a host that keeps refusing is not asked again this run");
  assert.equal((await ask("https://api.npmjs.org/downloads/point/last-month/y", 300)).status, 200, "other hosts are still asked");
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
    if (url.includes("pypistats.org/api/packages/acme-docs-mcp/")) return json(200, { data: { last_month: 3100 } });
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
