#!/usr/bin/env node
// Imports consensus-classifier observations (Is 7) into a store, without touching the paid model's `jev`
// observations. Validates every entry (shape, known job/stack options, content digest matches the store's
// skill) and writes the valid ones under obs/consensus/, keyed by content digest + question version + source.
// Entries whose job the two runs did not agree on are still stored; derive.mjs only uses 2/2 jobs.
//   node pipeline/import-consensus.mjs --store DIR --input uzlasma-2000.json --manifest manifest.json
//       --metinler DIR [--taxonomy catalog/taxonomy.json] [--dry-run]
// The writing part is NOT run here in CI; Claude runs it. --dry-run validates and reports only.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isMain } from "../src/util.mjs";
import { createStore } from "./store.mjs";
import { repoFacts } from "./observe.mjs";
import { flag } from "./lib/cli.mjs";
import { consensusKeyer, consensusToAnswers, validateConsensusEntry, CONSENSUS_SOURCE } from "./consensus.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function importConsensus(store, { entries, idToRepo, metinlerDir, validJobs, validStacks, dryRun = false, log = () => {} }) {
  const keyOf = consensusKeyer();
  const stats = { total: entries.length, imported: 0, skipped: [], notCandidate: 0 };
  // Index the store's skills by repo + folder slug for id matching.
  const byRepoFolder = new Map();
  for (const repoName of store.listRepos()) {
    const full = store.getRepo(repoName);
    if (!full || full.error || !full.head) continue;
    let facts;
    try { facts = repoFacts(store, repoName, full); } catch { continue; }
    for (const s of facts.skills) {
      if (!s.skillMd) continue;
      for (const n of new Set([slug(s.path.split("/").pop()), slug(s.name)]).values()) {
        if (!n) continue;
        const k = `${repoName.toLowerCase()}\n${n}`;
        if (!byRepoFolder.has(k)) byRepoFolder.set(k, []);
        byRepoFolder.get(k).push({ repo: repoName, skill: s });
      }
    }
  }
  for (const entry of entries) {
    const id = entry?.id;
    const problems = validateConsensusEntry(entry, { validJobs, validStacks });
    if (problems.length) { stats.skipped.push({ id, reason: `invalid: ${problems.join("; ")}` }); continue; }
    const repo = idToRepo.get(id);
    if (!repo) { stats.skipped.push({ id, reason: "no repo in manifest" }); continue; }
    const holders = byRepoFolder.get(`${String(repo).toLowerCase()}\n${slug(id)}`) ?? [];
    if (!holders.length) { stats.skipped.push({ id, reason: `skill not found in store repo ${repo}` }); continue; }
    if (holders.length > 1) log(`warning: ${id}: ${holders.length} holders in ${repo}, using first`);
    const { skill } = holders[0];
    const blob = store.getBlob(skill.skillMd);
    if (!blob) { stats.skipped.push({ id, reason: "blob missing" }); continue; }
    // Content check: the classified text (metinler/<id>.txt, which has a header
    // "AD:..\nTUR:..\nOZET:..\n\n--- SKILL.md ---\n" before the SKILL.md body) must match the store's skill.
    const metinPath = join(metinlerDir, `${id}.txt`);
    if (existsSync(metinPath)) {
      const raw = readFileSync(metinPath, "utf8");
      const marker = "--- SKILL.md ---\n";
      const at = raw.indexOf(marker);
      const classified = (at >= 0 ? raw.slice(at + marker.length) : raw).slice(0, 12000);
      const stored = blob.toString("utf8").slice(0, 12000);
      if (sha256(classified) !== sha256(stored)) {
        stats.skipped.push({ id, reason: "content mismatch: metinler text differs from store SKILL.md" });
        continue;
      }
    } else {
      log(`warning: ${id}: no metinler text, trusting store content`);
    }
    const answers = consensusToAnswers(entry);
    if (!answers) { stats.notCandidate++; continue; }
    const obs = {
      ...answers,
      id,
      repo: holders[0].repo,
      path: skill.path,
      models: ["muse-spark"],
      date: "2026-10-04",
      onay: entry.onay ?? null,
      levels: {
        coding: entry.coding.duzey, job: entry.job.duzey, stack: entry.stack.duzey,
        lifecycle: entry.lifecycle.duzey, productBound: entry.productBound.duzey,
      },
    };
    const key = keyOf(skill.skillMd);
    if (!dryRun) store.putObs("consensus", key, obs);
    stats.imported++;
  }
  return stats;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const store = createStore(resolve(flag(args, "--store", "store")));
  const input = JSON.parse(readFileSync(resolve(flag(args, "--input")), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(flag(args, "--manifest")), "utf8"));
  const metinlerDir = resolve(flag(args, "--metinler"));
  const taxonomy = JSON.parse(readFileSync(resolve(flag(args, "--taxonomy", join(root, "catalog", "taxonomy.json"))), "utf8"));
  const dryRun = args.includes("--dry-run");
  const entries = Array.isArray(input) ? input : input.beceriler ?? [];
  const idToRepo = new Map((Array.isArray(manifest) ? manifest : []).map((m) => [m.id, m.repo]));
  const validJobs = new Set([...Object.keys(taxonomy.capabilities ?? {}), "none"]);
  const validStacks = new Set([...Object.keys(taxonomy.stacks ?? {}), "any"]);
  const stats = importConsensus(store, { entries, idToRepo, metinlerDir, validJobs, validStacks, dryRun, log: (m) => console.error(m) });
  console.log(JSON.stringify({ dryRun, ...stats, skipped: stats.skipped.slice(0, 20), skippedTotal: stats.skipped.length }, null, 1));
}
