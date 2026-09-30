import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([".git", "node_modules", "fixtures"]);

function markdownFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(full));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

// Markdown links and HTML src/href that point inside the repository.
const LINK = /\]\(([^)\s]+)\)|(?:src|href)="([^"]+)"/g;
const external = (t) => /^(https?:|mailto:|#)/.test(t);

test("every relative link in the documentation points to a file that exists", () => {
  const broken = [];
  for (const file of markdownFiles(root)) {
    const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(LINK)) {
      const target = (m[1] ?? m[2]).split("#")[0];
      if (!target || external(m[1] ?? m[2])) continue;
      if (!existsSync(join(dirname(file), decodeURIComponent(target)))) broken.push(`${relative(root, file)} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
