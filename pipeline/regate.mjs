#!/usr/bin/env node
// Re-gates the published catalog with the current scanner, without discovering or collecting anything again: every
// skill's files are downloaded at the commit the catalog pins, checked against their SHA-256 and scanned again; MCP
// servers, tools and the guard have their setup gated again (scanner, npm registry, OSV). Findings the scanner does not
// make (look-alike names, jury suspicion, the denylist) are kept. Items that no longer pass leave the catalog for
// rejected.json or review-queue.json. Run it after every scanner or gate change: test/catalog-seed.test.mjs refuses
// items gated by an older version.
//   node pipeline/regate.mjs [--dry-run] [--concurrency 8] [catalog-dir]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, sha256 } from "../src/util.mjs";
import { rawUrl } from "../src/install.mjs";
import { scanFiles, levelFromFindings, SCANNER_VERSION } from "../src/scan/index.mjs";
import { PUBLISHABLE_LEVELS, validateCatalog } from "../src/catalog.mjs";
import { setupSecurity, securityRecord } from "./gate.mjs";
import { writeCatalogFiles } from "./publish.mjs";
import { rebuildSeedGraph } from "./graph-seed.mjs";
import { mapLimit } from "./jev-classify.mjs";
import { fetchWithRetry } from "./lib/http.mjs";

// Findings that come from the pipeline, not from the files: a re-scan cannot reproduce them, so they stay.
const KEPT = new Set(["(metadata)", "(jury)", "(denylist)"]);

async function download(item, { fetchImpl }) {
  const files = [];
  for (const f of item.files) {
    const res = await fetchWithRetry(rawUrl(item, f), {}, { fetchImpl, retries: 3, timeoutMs: 30000 });
    if (!res.ok) throw new Error(`${item.id}: HTTP ${res.status} for ${f.path}`);
    const content = Buffer.from(await res.arrayBuffer());
    // The commit is pinned, so a different file means a broken download or a broken catalog, never an update.
    if (sha256(content) !== f.sha256) throw new Error(`${item.id}: ${f.path} does not match the catalog's SHA-256`);
    files.push({ path: f.path, content, size: content.length });
  }
  return files;
}

// The item's security record under the current scanner and gate.
export async function regateItem(item, { fetchImpl = fetch, now = new Date() } = {}) {
  if (item.security?.review) throw new Error(`${item.id}: a reviewer approved it under the old findings; review it again by hand`);
  const kept = (item.security?.findings ?? []).filter((f) => KEPT.has(f.file));
  let record;
  if (item.type === "skill" || item.type === "plugin") {
    const scan = scanFiles(await download(item, { fetchImpl }));
    const findings = [...scan.findings, ...kept];
    record = securityRecord({ level: levelFromFindings(findings), findings }, now);
  } else {
    const gated = await setupSecurity(item.setup, { fetchImpl, now });
    const findings = [...gated.findings, ...kept];
    record = { ...gated, level: levelFromFindings(findings), findings };
  }
  const badges = (item.badges ?? []).filter((b) => b !== "caution");
  return { ...item, badges: record.level === "caution" ? [...badges, "caution"] : badges, security: record };
}

const reasonOf = (security) => {
  const top = security.findings.find((f) => f.severity === "critical" || f.severity === "high");
  return top ? `${top.rule}: ${top.file}:${top.line} ${top.note ?? ""} ${top.excerpt}`.replace(/\s+/g, " ").trim() : "";
};

export async function regateCatalog(dir, { fetchImpl = fetch, now = new Date(), concurrency = 8, dryRun = false, graphPath = null, log = () => {} } = {}) {
  const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const items = read("items.json");
  const regated = await mapLimit(items, concurrency, async (item) => {
    const next = await regateItem(item, { fetchImpl, now });
    if (next.security.level !== item.security.level) log(`${item.id}: ${item.security.level} -> ${next.security.level}`);
    return next;
  });
  const kept = regated.filter((i) => PUBLISHABLE_LEVELS.includes(i.security.level));
  const out = regated.filter((i) => !PUBLISHABLE_LEVELS.includes(i.security.level));
  const outIds = new Set(out.map((i) => i.id));
  const core = read("core.json");
  const loadouts = read("loadouts.json");
  const pinned = [...core.map((c) => c.id), ...loadouts.flatMap((l) => l.items ?? [])].filter((id) => outIds.has(id));
  if (pinned.length) throw new Error(`no longer passes the gate but is in core.json or loadouts.json, decide by hand: ${[...new Set(pinned)].join(", ")}`);
  // Conflicts with an item that left go with it.
  const finalItems = kept.map((i) => ({ ...i, conflicts: (i.conflicts ?? []).filter((c) => !outIds.has(c)) }));
  const taxonomy = read("taxonomy.json");
  const errors = validateCatalog({ items: finalItems, taxonomy, loadouts, core });
  if (errors.length) throw new Error(`invalid catalog after the re-gate: ${errors.slice(0, 5).join("; ")}`);
  const entry = (i) => ({ commit: i.commit ?? null, id: i.id, level: i.security.level, path: i.path ?? null, reason: reasonOf(i.security), repo: i.repo ?? null });
  const changed = regated.filter((i, n) => i.security.level !== items[n].security.level).map((i) => i.id);
  const summary = { items: items.length, kept: finalItems.length, removed: out.map((i) => `${i.id} (${i.security.level})`), changed, scannerVersion: SCANNER_VERSION };
  if (dryRun) return summary;
  const merge = (file, add) => [...read(file).filter((d) => !add.some((a) => a.id === d.id)), ...add].sort((a, b) => (a.id < b.id ? -1 : 1));
  const meta = writeCatalogFiles(dir, { items: finalItems }, {
    now,
    extra: out.length
      ? {
          "rejected.json": merge("rejected.json", out.filter((i) => i.security.level === "rejected").map(entry)),
          "review-queue.json": merge("review-queue.json", out.filter((i) => i.security.level === "quarantined").map(entry)),
        }
      : {},
  });
  if (out.length && graphPath) {
    const classification = JSON.parse(readFileSync(join(dir, "..", "pipeline", "classification.json"), "utf8")).items ?? {};
    const graph = rebuildSeedGraph(JSON.parse(readFileSync(graphPath, "utf8")), finalItems, { classification });
    writeFileSync(graphPath, JSON.stringify(graph) + "\n");
  }
  return { ...summary, version: meta.version };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--concurrency") ?? join(root, "catalog"));
  const result = await regateCatalog(dir, {
    dryRun: args.includes("--dry-run"),
    concurrency: Number(opt("--concurrency", "8")),
    graphPath: join(root, "data", "graph-seed.json"),
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(result, null, 2));
}
