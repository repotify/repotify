// The published package must hold every file the CLI loads. 2.0.0 as first built shipped without lib/, so
// `npx @repotify/repotify` would have crashed on its first import; `npm pack --dry-run` alone did not notice.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (p) => p.split(sep).join("/");

// Every repository file reachable from the CLI entry through relative static imports, dynamic imports with a
// literal path, and `new URL("./x", import.meta.url)` file references.
export function runtimeFiles(entry = "bin/repotify.mjs") {
  const seen = new Set();
  const stack = [entry];
  const missing = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(root, f), "utf8");
    const refs = src.matchAll(/(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"|import\(\s*"(\.{1,2}\/[^"]+)"\s*\)|new URL\(\s*"(\.{1,2}\/[^"]+)",\s*import\.meta\.url/g);
    for (const m of refs) {
      const p = posix(relative(root, join(root, dirname(f), m[1] ?? m[2] ?? m[3])));
      if (!existsSync(join(root, p))) missing.push(`${p} (from ${f})`);
      else if (/\.m?js$/.test(p)) stack.push(p);
      else if (!p.endsWith("/")) seen.add(p);
    }
  }
  return { files: [...seen].sort(), missing };
}

test("every file the CLI loads is in the published package", () => {
  const { files, missing } = runtimeFiles();
  assert.deepEqual(missing, [], "imports that point nowhere");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr);
  const packed = new Set(JSON.parse(r.stdout)[0].files.map((f) => f.path));
  // A folder reference (the bundled catalog, the agent skill) is satisfied when its files ship.
  const isDir = (f) => statSync(join(root, f)).isDirectory();
  const absent = files.filter((f) => (isDir(f) ? ![...packed].some((p) => p.startsWith(`${f}/`)) : !packed.has(f)));
  assert.deepEqual(absent, [], "loaded at runtime but not published");
  assert.ok(files.some((f) => f.startsWith("lib/")), "the walk reaches lib/");
});
