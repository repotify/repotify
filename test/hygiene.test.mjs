import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "fixtures", "work", "cache"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(mjs|js|json|md|yml|yaml|toml|sql)$/.test(name)) yield full;
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
