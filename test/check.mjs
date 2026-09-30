#!/usr/bin/env node
// One command for the whole repository: tests, recommendation quality, the catalog, the website and the npm package.
// Usage: npm run check
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const site = mkdtempSync(join(tmpdir(), "repotify-check-"));
const node = (...args) => [process.execPath, args];
const steps = [
  ["tests", ...node("--test", "test/*.test.mjs")],
  ["recommendation quality", ...node("test/eval/run.mjs")],
  ["catalog", ...node("pipeline/verify.mjs", "catalog")],
  ["website", ...node("site/build.mjs", "--out", site)],
  ["npm package", process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"]],
];
let failed = 0;
for (const [label, cmd, args] of steps) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" && cmd.endsWith(".cmd") });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!ok) console.log((r.stdout + r.stderr).split("\n").filter((l) => /✖|fail|error|Error/i.test(l)).slice(0, 12).map((l) => `    ${l}`).join("\n"));
}
rmSync(site, { recursive: true, force: true });
console.log(failed ? `\n${failed} step(s) failed.` : "\nEverything passed.");
process.exitCode = failed ? 1 : 0;
