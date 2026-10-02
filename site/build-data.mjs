#!/usr/bin/env node
// FAZ 8: build-time data for the v2 site sub-pages.
// Reads the catalog (catalog/items.json + catalog/meta.json) and the harness
// series (test/harness/runs/series3.jsonl), and writes JSON data files into the
// site dist assets dir. Zero dependencies.
// Usage: node site/build-data.mjs --out site/dist [--today 2026-10-01]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, loadRuns } from "../test/harness/report.mjs";
import { EXPENSIVE_TTL_MS } from "../lib/pipeline/test-runner/retest.mjs";
import { FLEET_INSTALL_THRESHOLD } from "../lib/telemetry/server/thresholds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function buildData({ out = join(here, "dist"), today = new Date().toISOString().slice(0, 10) } = {}) {
  const meta = JSON.parse(readFileSync(join(ROOT, "catalog", "meta.json"), "utf8"));
  const items = JSON.parse(readFileSync(join(ROOT, "catalog", "items.json"), "utf8"));
  const catalogAt = new Date(meta.generatedAt).getTime();
  // Jury/quality scores expire on the same 30-day TTL the pipeline uses for the
  // expensive scoring layer; derived, not stored per item. Documented on skill pages.
  const scoreExpiresAt = isoDay(catalogAt + EXPENSIVE_TTL_MS);

  const skills = items.map((it) => {
    const j = it.jury ?? {};
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const juryMean = j.quality != null ? +mean([j.quality, j.specificity, j.maintenance]).toFixed(3) : null;
    return {
      id: it.id,
      name: it.name ?? it.id,
      summary: it.summary ?? "",
      tier: it.tier ?? null,
      type: it.type ?? null,
      repo: it.repo ?? null,
      license: it.license ?? null,
      agents: it.agents ?? [],
      security: {
        level: it.security?.level ?? "unknown",
        scannedAt: it.security?.scannedAt ?? null,
        findings: (it.security?.findings ?? []).length,
      },
      jury: {
        quality: j.quality ?? null,
        specificity: j.specificity ?? null,
        maintenance: j.maintenance ?? null,
        agreement: j.agreement ?? null,
        models: j.models ?? [],
        mean: juryMean,
      },
      capabilities: it.capabilities ?? [],
      stacks: it.stacks ?? [],
      needs: it.needs ?? [],
      conflicts: it.conflicts ?? [],
      commit: it.commit ?? null,
      descriptionChars: it.descriptionChars ?? null,
      files: (it.files ?? []).length,
      scoreScoredAt: isoDay(catalogAt),
      scoreExpiresAt,
      // Critic's point (a): an expiry date with no mechanism is theater. The
      // build knows its own date, so expired scores are flagged at build time
      // and rendered as "expired — pending re-scan", never as valid.
      scoreExpired: scoreExpiresAt < today,
      catalogVersion: meta.version,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const runs = loadRuns(join(ROOT, "test", "harness", "runs", "series3.jsonl"));
  const rows = aggregate(runs);
  const leaderboard = {
    meta: {
      source: "test/harness/runs/series3.jsonl",
      generatedAt: new Date().toISOString(),
      label: "Series 3 — internal harness eval (pilot scale, n=3 per cell). Not fleet telemetry.",
      // Pragmatist tur2 (c2): cherry-picking guard. Earlier series (1/2) ran
      // with different scenarios and the pre-fix methodology; series3 is the
      // accepted final methodology, so only it is shown here. Series 1/2 files
      // are retained locally (git-ignored) for anyone who wants to check.
      seriesNote: "Series 3 is shown because it runs the final accepted methodology (4 arms incl. none negative control, ground-truth reachability fix). Series 1 and 2 are earlier pilots — different scenarios, pre-fix methodology — retained locally at test/harness/runs/series1.jsonl and series2.jsonl for audit (git-ignored, not in the repo), not cherry-picked out of this page.",
      fleetEnabled: false, // 8b: fleet (usage + retention) leaderboard stays behind this flag until the FAZ 9 data threshold (FLEET_INSTALL_THRESHOLD installs, DL-045: imported, not a literal).
      fleetThreshold: FLEET_INSTALL_THRESHOLD,
      dataPolicy: "Delayed and aggregated. No raw runs, no user data — see publishing strategy (FAZ 9 plan).",
    },
    rows,
  };

  const dataDir = join(out, "assets", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "skills.json"), JSON.stringify({ meta: { count: skills.length, catalogVersion: meta.version, generatedAt: meta.generatedAt, scoreExpiresAt }, skills }, null, 1));
  writeFileSync(join(dataDir, "leaderboard.json"), JSON.stringify(leaderboard, null, 1));
  // Approved community comments, embedded at build time. Starts empty; the
  // moderation pipeline (site/COMMENTS-DESIGN.md) appends signed approvals here.
  writeFileSync(join(dataDir, "comments.json"), JSON.stringify({ meta: { note: "Moderated community experiences. No stars, no ratings — by design." }, comments: [] }, null, 1));
  return { out: dataDir, skillCount: skills.length, catalogVersion: meta.version, scoreExpiresAt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const r = buildData(i > 0 ? { out: resolve(process.argv[i + 1]) } : {});
  console.log(`site data: ${r.skillCount} skills (catalog ${r.catalogVersion}) → ${r.out}`);
}
