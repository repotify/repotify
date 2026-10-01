import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseInstallCommands, checkPackages, runHook, privateNpmScopes } from "../src/guard.mjs";
import { installGuard, removeGuard } from "../src/install.mjs";

const NOW = new Date("2026-09-28T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test("install commands are parsed across package managers", () => {
  assert.deepEqual(parseInstallCommands("npm i -D left-padx@1.0.0 react"), [{ ecosystem: "npm", packages: ["left-padx", "react"] }]);
  assert.deepEqual(parseInstallCommands("pip install -r req.txt requests==2.0"), [{ ecosystem: "pypi", packages: ["requests"] }]);
  assert.deepEqual(parseInstallCommands("pnpm add @scope/pkg@^2 && yarn add lodash"), [{ ecosystem: "npm", packages: ["@scope/pkg"] }, { ecosystem: "npm", packages: ["lodash"] }]);
  assert.deepEqual(parseInstallCommands("uv add 'fastapi[standard]>=0.1' httpx"), [{ ecosystem: "pypi", packages: ["fastapi", "httpx"] }]);
  assert.deepEqual(parseInstallCommands("python -m pip install --upgrade numpy"), [{ ecosystem: "pypi", packages: ["numpy"] }]);
  assert.deepEqual(parseInstallCommands("npx -y create-thing@latest my-app"), [{ ecosystem: "npm", packages: ["create-thing"] }]);
  assert.deepEqual(parseInstallCommands("npm exec -y evil-pkg"), [{ ecosystem: "npm", packages: ["evil-pkg"] }]);
  assert.deepEqual(parseInstallCommands("npm x evil-pkg"), [{ ecosystem: "npm", packages: ["evil-pkg"] }]);
  assert.deepEqual(parseInstallCommands("npm install"), []);
  assert.deepEqual(parseInstallCommands("pip install -e . ./local git+https://x/y.git"), []);
  assert.deepEqual(parseInstallCommands("ls -la"), []);
});

test("npx/npm exec -p/--package checks the installed package, not the command", () => {
  assert.deepEqual(parseInstallCommands("npx -p evil-pkg somecmd"), [{ ecosystem: "npm", packages: ["evil-pkg"] }]);
  assert.deepEqual(parseInstallCommands("npx --package=evil-pkg -- somecmd"), [{ ecosystem: "npm", packages: ["evil-pkg"] }]);
  assert.deepEqual(parseInstallCommands("npm exec --package=evil-pkg -- somecmd"), [{ ecosystem: "npm", packages: ["evil-pkg"] }]);
  assert.deepEqual(parseInstallCommands("npx -p a -p b run"), [{ ecosystem: "npm", packages: ["a", "b"] }]);
  assert.deepEqual(parseInstallCommands("npx somecmd"), [{ ecosystem: "npm", packages: ["somecmd"] }]);
});

test("registry env prefix opts out of the public-registry check", () => {
  assert.deepEqual(parseInstallCommands("NPM_CONFIG_REGISTRY=https://evil.example npm i pkg"), []);
  assert.deepEqual(parseInstallCommands("NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm i pkg"), [{ ecosystem: "npm", packages: ["pkg"] }]);
  assert.deepEqual(parseInstallCommands("PIP_INDEX_URL=https://evil.example/simple pip install pkg"), []);
});

function registry(map) {
  return async (url) => {
    for (const [k, v] of Object.entries(map)) if (url.endsWith(k)) return v === 404 ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(v), { status: 200 });
    throw new Error("offline");
  };
}

test("checkPackages flags missing and brand-new packages", async () => {
  const fetchImpl = registry({
    "/react": { time: { created: daysAgo(4000) } },
    "/left-padx": 404,
    "/fresh-pkg": { time: { created: daysAgo(3) } },
    "/@scope%2fpkg": { time: { created: daysAgo(100) } },
  });
  const r = await checkPackages({ ecosystem: "npm", packages: ["react", "left-padx", "fresh-pkg", "@scope/pkg", "offline-pkg"], fetchImpl, now: NOW });
  assert.deepEqual(r.map((x) => [x.name, x.verdict]), [["react", "ok"], ["left-padx", "missing"], ["fresh-pkg", "new"], ["@scope/pkg", "ok"], ["offline-pkg", "unknown"]]);
  const py = await checkPackages({ ecosystem: "pypi", packages: ["requests"], fetchImpl: registry({ "/requests/json": { releases: { "1.0": [{ upload_time_iso_8601: daysAgo(5000) }], "2.0": [{ upload_time_iso_8601: daysAgo(10) }] } } }), now: NOW });
  assert.equal(py[0].verdict, "ok");
  assert.ok(py[0].ageDays > 4000);
});

test("the hook blocks missing packages, asks about new ones and ignores other tools", async () => {
  const fetchImpl = registry({ "/left-padx": 404, "/fresh-pkg": { time: { created: daysAgo(2) } }, "/react": { time: { created: daysAgo(4000) } } });
  const blocked = await runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm i left-padx react" } }), { fetchImpl, now: NOW });
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.stderr, /left-padx/);
  const ask = await runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm i fresh-pkg" } }), { fetchImpl, now: NOW });
  assert.equal(ask.exitCode, 0);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, "ask");
  const ok = await runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm i react" } }), { fetchImpl, now: NOW });
  assert.deepEqual([ok.exitCode, ok.stdout], [0, ""]);
  assert.equal((await runHook(JSON.stringify({ tool_name: "Read", tool_input: {} }), { fetchImpl })).exitCode, 0);
  assert.equal((await runHook("not json", { fetchImpl })).exitCode, 0);
});

test("installGuard copies a standalone hook and merges settings without clobbering", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rp-guard-"));
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
  const r = installGuard({ cwd });
  assert.equal(r.written, true);
  const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /repotify-guard\.mjs/);
  installGuard({ cwd });
  assert.equal(JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8")).hooks.PreToolUse.length, 1, "idempotent");
  const hook = join(cwd, ".claude/hooks/repotify-guard.mjs");
  assert.ok(existsSync(hook));
  const run = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Read" }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  removeGuard({ cwd });
  assert.equal(existsSync(hook), false);
  assert.equal(JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8")).hooks, undefined);
});

test("installGuard refuses to touch an unparseable settings file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rp-guard-"));
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude/settings.json"), "{ nope");
  const r = installGuard({ cwd });
  assert.deepEqual([r.written, r.reason], [false, "unparseable"]);
  assert.equal(readFileSync(join(cwd, ".claude/settings.json"), "utf8"), "{ nope");
});

test("I3: more command shapes are parsed", () => {
  const pkgs = (cmd) => parseInstallCommands(cmd).map((g) => g.packages).flat();
  assert.deepEqual(pkgs("npm i react\nnpm i left-padx"), ["react", "left-padx"]);
  assert.deepEqual(pkgs("(cd web && npm i x-lib)"), ["x-lib"]);
  assert.deepEqual(pkgs("echo $(npm i y-lib)"), ["y-lib"]);
  assert.deepEqual(pkgs("npm --prefix web install z-lib"), ["z-lib"]);
  assert.deepEqual(pkgs("pnpm --filter web add w-lib"), ["w-lib"]);
  assert.deepEqual(pkgs("yarn workspace web add v-lib"), ["v-lib"]);
});

test("I3: workspace specs and custom registries are never looked up publicly", () => {
  assert.deepEqual(parseInstallCommands("pnpm add @acme/shared@workspace:*"), []);
  assert.deepEqual(parseInstallCommands("npm i --registry https://npm.acme.internal @acme/ui"), []);
  assert.deepEqual(parseInstallCommands("pip install --index-url https://pypi.acme/simple internal-lib"), []);
});

test("I3: a scoped package missing from the public registry asks instead of blocking", async () => {
  const fetchImpl = registry({ "/@acme%2finternal-ui": 404 });
  const r = await runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm i @acme/internal-ui" } }), { fetchImpl, now: NOW });
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask");
});

test("I3: scopes with a private registry in .npmrc are skipped entirely", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rp-npmrc-"));
  writeFileSync(join(cwd, ".npmrc"), "@acme:registry=https://npm.acme.internal/\n");
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return new Response("{}", { status: 404 }); };
  const r = await runHook(JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command: "npm i @acme/ui" } }), { fetchImpl, now: NOW });
  assert.deepEqual([r.exitCode, r.stdout], [0, ""]);
  assert.deepEqual(asked, [], "private names are not sent to the public registry");
});

test("re-review I-5: -f and -i only mean a custom index for pip-style tools, and public registries are still checked", () => {
  assert.deepEqual(parseInstallCommands("npm i -f left-padx"), [{ ecosystem: "npm", packages: ["left-padx"] }]);
  assert.deepEqual(parseInstallCommands("npm install -f totally-hallucinated-pkg"), [{ ecosystem: "npm", packages: ["totally-hallucinated-pkg"] }]);
  assert.deepEqual(parseInstallCommands("bun add -f x"), [{ ecosystem: "npm", packages: ["x"] }]);
  assert.deepEqual(parseInstallCommands("pip install -i https://pypi.org/simple reqeusts"), [{ ecosystem: "pypi", packages: ["reqeusts"] }]);
  assert.deepEqual(parseInstallCommands("npm i --registry=https://registry.npmjs.org/ lodahs"), [{ ecosystem: "npm", packages: ["lodahs"] }]);
  assert.deepEqual(parseInstallCommands("pip install -i https://pypi.acme/simple internal-lib"), []);
  assert.deepEqual(parseInstallCommands("npm i --registry=https://npm.acme.internal @acme/ui"), []);
});

test("re-review M-i: npm aliases are looked up by the real package name", () => {
  assert.deepEqual(parseInstallCommands("npm i my-react@npm:react@18"), [{ ecosystem: "npm", packages: ["react"] }]);
  assert.deepEqual(parseInstallCommands("npm i @scope/x@npm:@other/y@1"), [{ ecosystem: "npm", packages: ["@other/y"] }]);
});

test("re-review M-i: private scopes from the user's ~/.npmrc are respected", () => {
  const home = mkdtempSync(join(tmpdir(), "rp-home-"));
  writeFileSync(join(home, ".npmrc"), "@acme:registry=https://npm.acme.internal/\n");
  const cwd = mkdtempSync(join(tmpdir(), "rp-proj-"));
  const r = privateNpmScopes(cwd, { home });
  assert.ok(r.scopes.has("@acme"));
});
