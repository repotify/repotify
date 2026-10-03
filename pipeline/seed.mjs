#!/usr/bin/env node
// Rebuilds the catalog from the editorial seed only (no discovery), reusing local clones.
// The jury runs when NVIDIA keys are set and --no-jury is not given.
// Usage: node pipeline/seed.mjs [--clone-dir pipeline/work/clones] [--out catalog] [--cache pipeline/cache/jury.json] [--no-jury]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../src/util.mjs";
import { runPipeline } from "./run.mjs";
import { providersFromEnv } from "./providers/index.mjs";
import { flag, logStamped } from "./lib/cli.mjs";

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const here = fileURLToPath(new URL(".", import.meta.url));
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const outDir = resolve(flag(args, "--out", join(here, "..", "catalog")));
  const cachePath = resolve(flag(args, "--cache", join(here, "cache", "jury.json")));
  const juryCache = existsSync(cachePath) ? read(cachePath) : {};
  const providers = args.includes("--no-jury") ? {} : Object.fromEntries(providersFromEnv({ ...process.env, REPOTIFY_USE_OMNIROUTE: process.env.REPOTIFY_USE_OMNIROUTE ?? "0" }).map((p) => [p.name, p]));
  const result = await runPipeline({
    seed: read(join(here, "seed-sources.json")),
    taxonomy: read(join(outDir, "taxonomy.json")),
    outDir,
    workDir: resolve(flag(args, "--clone-dir", join(here, "work", "clones"))),
    freshClones: false,
    providers,
    juryCache,
    reviewed: existsSync(join(here, "reviewed.json")) ? read(join(here, "reviewed.json")) : [],
    denylist: existsSync(join(here, "denylist.json")) ? read(join(here, "denylist.json")) : [],
    concurrency: 3,
    log: logStamped,
  });
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(result.juryCache));
  console.error(`catalog ${result.meta.version}: ${result.items.length} items, ${result.dropped.length} dropped, ${result.stats.jurors} juror(s)`);
}
