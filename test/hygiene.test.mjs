import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "fixtures", "work", "cache"]);
const SOURCE = /\.(mjs|js|json|md|yml|yaml|toml|sql)$/;

// What could be committed: tracked and new files, not what .gitignore keeps out (skills a developer installed into
// this working copy, build output). Without git, every file but the skipped folders.
function* walk(dir) {
  const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: dir, encoding: "utf8" });
  if (git.status === 0) {
    for (const rel of git.stdout.split("\0").filter(Boolean)) {
      if (rel.split("/").some((part) => SKIP.has(part)) || !SOURCE.test(rel)) continue;
      try {
        if (statSync(join(dir, rel)).isFile()) yield join(dir, rel);
      } catch {
        // Deleted in the working tree.
      }
    }
    return;
  }
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE.test(name)) yield full;
  }
}

test("source files contain no literal invisible or bidi characters", () => {
  const bad = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x200b && cp <= 0x200d) || cp === 0x2060 || cp === 0xfeff || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || (cp >= 0xe0000 && cp <= 0xe007f)) {
        bad.push(`${relative(root, file)} U+${cp.toString(16).toUpperCase()}`);
        break;
      }
    }
  }
  assert.deepEqual(bad, []);
});
