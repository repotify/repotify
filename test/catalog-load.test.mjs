import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, compareVersions } from "../src/catalog.mjs";
import { homeDir } from "../src/config.mjs";
import { sha256 } from "../src/util.mjs";

const bundledDir = fileURLToPath(new URL("../catalog/", import.meta.url));
const FILES = ["items.json", "taxonomy.json", "loadouts.json", "core.json"];
const URL_BASE = "https://catalog.test/catalog";

function remoteFiles({ version = "2999.01.01.1", tamper = false } = {}) {
  const files = {};
  for (const f of FILES) files[f] = readFileSync(join(bundledDir, f), "utf8");
  const meta = { schemaVersion: 1, version, generatedAt: "2999-01-01T00:00:00.000Z", files: {} };
  for (const f of FILES) meta.files[f] = sha256(files[f]);
  if (tamper) files["items.json"] = files["items.json"].replace('"graphify"', '"graphifx"');
  files["meta.json"] = JSON.stringify(meta);
  return files;
}

function fakeFetch(files, { etag = '"v1"', calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    const name = url.slice(URL_BASE.length + 1);
    if (name === "meta.json" && init.headers?.["If-None-Match"] === etag) return new Response(null, { status: 304 });
    if (!(name in files)) return new Response("nope", { status: 404 });
    return new Response(files[name], { status: 200, headers: { etag } });
  };
}

const tmp = () => mkTemp("rp-load-");

test("compareVersions orders date versions", () => {
  assert.ok(compareVersions("2026.09.28.2", "2026.09.28.10") < 0);
  assert.ok(compareVersions("2026.10.01.1", "2026.09.28.9") > 0);
  assert.equal(compareVersions("2026.09.28.1", "2026.09.28.1"), 0);
});

test("homeDir honours REPOTIFY_HOME", () => {
  assert.equal(homeDir({ REPOTIFY_HOME: "/x/y" }), "/x/y");
  assert.match(homeDir({}), /\.repotify$/);
});

test("a valid remote catalog is used and cached", async () => {
  const cacheDir = tmp();
  const r = await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, fetchImpl: fakeFetch(remoteFiles()) });
  assert.equal(r.source, "remote");
  assert.equal(r.catalog.meta.version, "2999.01.01.1");
  assert.ok(r.catalog.items.length > 0);
  assert.equal(JSON.parse(readFileSync(join(cacheDir, "meta.json"), "utf8")).version, "2999.01.01.1");
});

test("304 Not Modified serves the cache", async () => {
  const cacheDir = tmp();
  const files = remoteFiles();
  await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, fetchImpl: fakeFetch(files) });
  const calls = [];
  const r = await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, fetchImpl: fakeFetch(files, { calls }) });
  assert.equal(r.source, "cache");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["If-None-Match"], '"v1"');
});

test("network failure falls back to the bundled catalog with an offline notice", async () => {
  const r = await loadCatalog({ url: URL_BASE, cacheDir: tmp(), bundledDir, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(r.source, "bundled");
  assert.match(r.notice, /offline/i);
  assert.ok(r.catalog.items.length > 0);
});

test("a hash mismatch is rejected and falls back with an integrity notice", async () => {
  const cacheDir = tmp();
  const r = await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, fetchImpl: fakeFetch(remoteFiles({ tamper: true })) });
  assert.equal(r.source, "bundled");
  assert.match(r.notice, /integrity/i);
});

test("HTTP 404 falls back to bundled", async () => {
  const r = await loadCatalog({ url: URL_BASE, cacheDir: tmp(), bundledDir, fetchImpl: fakeFetch({}) });
  assert.equal(r.source, "bundled");
  assert.match(r.notice, /404/);
});

test("a remote catalog older than the bundled one is ignored (rollback protection)", async () => {
  const r = await loadCatalog({ url: URL_BASE, cacheDir: tmp(), bundledDir, fetchImpl: fakeFetch(remoteFiles({ version: "2000.01.01.1" })) });
  assert.equal(r.source, "bundled");
  assert.match(r.notice, /older/i);
});

test("offline mode never calls fetch and prefers a valid cache", async () => {
  const cacheDir = tmp();
  await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, fetchImpl: fakeFetch(remoteFiles()) });
  let called = false;
  const r = await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, offline: true, fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(r.source, "cache");
});

test("a corrupted cache is ignored", async () => {
  const cacheDir = tmp();
  await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, fetchImpl: fakeFetch(remoteFiles()) });
  writeFileSync(join(cacheDir, "items.json"), "[]");
  const r = await loadCatalog({ url: URL_BASE, cacheDir, bundledDir, offline: true });
  assert.equal(r.source, "bundled");
});

import { verifyCatalogDir } from "../src/catalog.mjs";

// Test temp dirs: track every mkdtempSync dir and remove them all in after(),
// or a day of test runs fills /tmp (512M tmpfs) and later runs fail with ENOSPC.
const tempDirs = [];
const mkTemp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("verifyCatalogDir accepts the bundled catalog and rejects a tampered copy", () => {
  const ok = verifyCatalogDir(bundledDir);
  assert.deepEqual(ok.errors, []);
  assert.match(ok.version, /^\d{4}\./);
  const dir = tmp();
  cpSync(bundledDir, dir, { recursive: true });
  writeFileSync(join(dir, "core.json"), "[]\n");
  const bad = verifyCatalogDir(dir);
  assert.ok(bad.errors.some((e) => /hash mismatch for core\.json/.test(e)));
});
