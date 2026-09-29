#!/usr/bin/env node
// Measures scanner false alarms on real, trusted skill repositories.
// Usage: node eval/scan-corpus.mjs <clone-dir>... [--json] [--details]
import { isMain } from "../src/util.mjs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { scanDir } from "../src/scan/index.mjs";

const SKIP = new Set([".git", "node_modules", "tests", "test", "fixtures", "evals", "evals-extra"]);

export async function findSkillDirs(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) out.push(dir);
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) await walk(join(dir, e.name));
  }
  await walk(root);
  return out;
}

export async function scanCorpus(roots) {
  const results = [];
  for (const root of roots) {
    for (const dir of await findSkillDirs(root)) {
      const r = await scanDir(dir);
      results.push({ skill: relative(dirname(root), dir), level: r.level, findings: r.findings });
    }
  }
  const count = (lvl) => results.filter((r) => r.level === lvl).length;
  const blocked = count("rejected") + count("quarantined");
  return {
    total: results.length,
    verified: count("verified"),
    caution: count("caution"),
    quarantined: count("quarantined"),
    rejected: count("rejected"),
    blockedRate: results.length ? blocked / results.length : 0,
    results,
  };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const roots = args.filter((a) => !a.startsWith("--"));
  const report = await scanCorpus(roots);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const pct = (report.blockedRate * 100).toFixed(1);
    console.log(`skills: ${report.total}  verified: ${report.verified}  caution: ${report.caution}  quarantined: ${report.quarantined}  rejected: ${report.rejected}  blocked: ${pct}%`);
    for (const r of report.results.filter((x) => x.level !== "verified")) {
      console.log(`${r.level.padEnd(11)} ${r.skill}`);
      if (args.includes("--details")) {
        for (const f of r.findings.filter((f) => f.severity !== "low")) console.log(`    ${f.severity.padEnd(8)} ${f.rule} ${f.file}:${f.line} ${f.note ?? ""} | ${f.excerpt}`);
      }
    }
  }
}
