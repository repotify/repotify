import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { COMMANDS } from "../src/cli.mjs";

// The documentation promises commands, versions and files; these tests keep the promises true as the code changes.
const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const mentioned = (text) => [...text.matchAll(/`repotify(?: ([a-z]+))?[^`]*`/g)].map((m) => m[1] ?? "start");

test("every command the README and the guide mention exists, and the guide lists them all", () => {
  for (const doc of ["README.md", "docs/GUIDE.md"]) {
    for (const cmd of mentioned(read(doc))) assert.ok(COMMANDS[cmd], `${doc} mentions \`repotify ${cmd}\`, which does not exist`);
  }
  const guide = new Set(mentioned(read("docs/GUIDE.md")));
  for (const cmd of Object.keys(COMMANDS)) assert.ok(guide.has(cmd), `docs/GUIDE.md does not document \`repotify ${cmd === "start" ? "" : cmd}\``);
});

test("the changelog's newest version is the package version", () => {
  assert.equal(/^## (\d+\.\d+\.\d+)/m.exec(read("CHANGELOG.md"))?.[1], pkg.version);
});

test("everything package.json ships or runs exists", () => {
  for (const f of pkg.files) {
    // "dir/*.mjs": the folder exists and the pattern matches at least one file in it.
    const m = /^(.*)\/\*(\.[a-z]+)$/.exec(f);
    if (m) assert.ok(existsSync(new URL(`${m[1]}/`, root)) && readdirSync(new URL(`${m[1]}/`, root)).some((x) => x.endsWith(m[2])), `files: ${f}`);
    else assert.ok(existsSync(new URL(f, root)), `files: ${f}`);
  }
  for (const f of Object.values(pkg.bin)) assert.ok(existsSync(new URL(f, root)), `bin: ${f}`);
  for (const [name, script] of Object.entries(pkg.scripts)) {
    const file = /node (\S+\.mjs)/.exec(script)?.[1];
    if (file) assert.ok(existsSync(new URL(file, root)), `scripts.${name}: ${file}`);
  }
});

test("install instructions use the published package name", () => {
  for (const doc of ["README.md", "AGENTS.md", "docs/i18n/README.tr.md", "docs/i18n/README.zh-CN.md"]) {
    for (const m of read(doc).matchAll(/npx -y (@?[a-z0-9._/-]+)/g)) assert.equal(m[1], pkg.name, `${doc}: npx -y ${m[1]}`);
  }
});
