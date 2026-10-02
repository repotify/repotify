#!/usr/bin/env node
// Repotify package guard. Standalone on purpose: this file is copied into projects as a
// Claude Code PreToolUse hook, so it may only import Node built-ins.
// Blocks installs of packages that do not exist (hallucinated names) and asks before brand-new ones.

import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DAY = 86400000;
export const NEW_PACKAGE_DAYS = 14;

export function tokenize(command) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let has = false;
  const push = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\n" || ch === "(" || ch === ")" || ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      // Newlines, subshells and command substitutions start a new command.
      push();
      if (ch === "$") i++;
      tokens.push({ op: ch === "$" ? "$(" : ch });
    } else if (/\s/.test(ch)) {
      push();
    } else if ("&|;".includes(ch)) {
      push();
      let op = ch;
      if (command[i + 1] === ch) op += command[++i];
      tokens.push({ op });
    } else {
      cur += ch;
      has = true;
    }
  }
  push();
  return tokens;
}

const NPM_VALUE_FLAGS = new Set(["--prefix", "-C", "--dir", "-w", "--workspace", "--filter", "-F", "--tag", "--cache", "-p", "--package", "--registry"]);
// Packages from a custom registry cannot be checked against the public one (and must not leak to it). The flags
// differ per ecosystem: for npm and bun, `-f` means --force.
const CUSTOM_REGISTRY_FLAGS = {
  npm: new Set(["--registry"]),
  pypi: new Set(["-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--index", "--default-index"]),
};
const PUBLIC_REGISTRY_RE = /^https?:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org)(\/|$)/i;

// True when the words point the installer at a registry other than the public one.
function usesCustomRegistry(words, ecosystem) {
  const flags = CUSTOM_REGISTRY_FLAGS[ecosystem];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const eq = w.indexOf("=");
    const flag = w.startsWith("--") && eq > 0 ? w.slice(0, eq) : w;
    if (!flags.has(flag)) continue;
    const value = flag === w ? words[i + 1] ?? "" : w.slice(eq + 1);
    if (!PUBLIC_REGISTRY_RE.test(value)) return true;
  }
  return false;
}
const PIP_VALUE_FLAGS = new Set(["-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--target", "-t", "--python", "--group", "--with"]);
const LOCAL_RE = /^(\.|\/|~|[A-Za-z]:\\)|:\/\/|^(git\+|github:)|(workspace|file|link|portal):|\.(tgz|tar\.gz|whl|zip)$/;

function npmName(token) {
  // Aliases install the package after `npm:` (`my-react@npm:react@18`).
  const alias = /^(?:@?[^@]+@)?npm:(.+)$/.exec(token);
  if (alias) return npmName(alias[1]);
  if (LOCAL_RE.test(token)) return null;
  const at = token.startsWith("@") ? token.indexOf("@", 1) : token.indexOf("@");
  const name = (at > 0 ? token.slice(0, at) : token).toLowerCase();
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name) ? name : null;
}

function pypiName(token) {
  if (LOCAL_RE.test(token)) return null;
  const name = token.split(/[[<>=!~;@\s]/)[0].toLowerCase();
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(name) ? name : null;
}

function collect(args, valueFlags, toName, { firstOnly = false } = {}) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    const n = toName(a);
    if (n) out.push(n);
    if (firstOnly) break;
  }
  return out;
}

// Drops subshell and grouping wrappers: "(cd x", "$(npm", "x)" and the like.
function unwrap(words) {
  return words.map((w) => w.replace(/^(\$\(|\(|\{|`)+/, "").replace(/[)`}]+$/, "")).filter(Boolean);
}

// Skips options (and their values) that may come before the subcommand, e.g. `npm --prefix web install`.
function skipLeadingFlags(args, valueFlags) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += valueFlags.has(args[i]) ? 2 : 1;
  return args.slice(i);
}

function parseSegment(rawWords) {
  let w = unwrap(rawWords);
  // An env prefix chooses the registry the install actually uses: `NPM_CONFIG_REGISTRY=https://evil npm i pkg`
  // must not be checked against the public registry.
  let envRegistry = "";
  while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || w[0] === "sudo" || w[0] === "command" || w[0] === "exec")) {
    const reg = /^(NPM_CONFIG_REGISTRY|PIP_INDEX_URL)=(\S+)/i.exec(w[0]);
    if (reg) envRegistry = reg[2];
    w = w.slice(1);
  }
  if (!w.length) return null;
  const cmd = w[0];
  const ecosystem = ["npm", "pnpm", "yarn", "bun", "npx", "bunx"].includes(cmd) ? "npm" : "pypi";
  if ((envRegistry && !PUBLIC_REGISTRY_RE.test(envRegistry)) || usesCustomRegistry(w.slice(1), ecosystem)) return null;
  const isNode = ["npm", "pnpm", "yarn", "bun"].includes(cmd);
  const [sub, ...rest] = isNode ? skipLeadingFlags(w.slice(1), NPM_VALUE_FLAGS) : w.slice(1);
  const npm = (args, opts) => ({ ecosystem: "npm", packages: collect(args, NPM_VALUE_FLAGS, npmName, opts) });
  const pypi = (args, opts) => ({ ecosystem: "pypi", packages: collect(args, PIP_VALUE_FLAGS, pypiName, opts) });
  // `npx -p pkg cmd` / `npm exec --package=pkg -- cmd` install and run `pkg`, not `cmd`: the package under
  // scrutiny is the -p/--package value. Without it, fall back to the first positional as before.
  const execPackages = (args) => {
    const pkgs = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-p" || a === "--package") {
        const n = npmName(args[i + 1] ?? "");
        if (n) pkgs.push(n);
        i++;
      } else if (a.startsWith("--package=")) {
        const n = npmName(a.slice("--package=".length));
        if (n) pkgs.push(n);
      }
    }
    return pkgs.length ? { ecosystem: "npm", packages: pkgs } : npm(args, { firstOnly: true });
  };
  if (cmd === "npm" && ["i", "install", "add", "isntall", "in"].includes(sub)) return npm(rest);
  // `npm exec` / `npm x` download and run a package exactly like `npx` does.
  if (cmd === "npm" && (sub === "exec" || sub === "x")) return execPackages(rest);
  if ((cmd === "pnpm" || cmd === "bun") && ["add", "i", "install"].includes(sub)) return npm(rest);
  if (cmd === "yarn" && sub === "add") return npm(rest);
  if (cmd === "yarn" && sub === "workspace" && rest[1] === "add") return npm(rest.slice(2));
  if (cmd === "npx" || cmd === "bunx") return execPackages([sub, ...rest].filter(Boolean));
  if ((cmd === "pnpm" || cmd === "yarn") && sub === "dlx") return execPackages(rest);
  if ((cmd === "pip" || cmd === "pip3") && sub === "install") return pypi(rest);
  if (/^python3?(\.\d+)?$/.test(cmd) && sub === "-m" && rest[0] === "pip" && rest[1] === "install") return pypi(rest.slice(2));
  if (cmd === "uv" && sub === "add") return pypi(rest);
  if (cmd === "uv" && sub === "pip" && rest[0] === "install") return pypi(rest.slice(1));
  if (cmd === "poetry" && sub === "add") return pypi(rest);
  if (cmd === "pipx" && (sub === "install" || sub === "run")) return pypi(rest, { firstOnly: true });
  if (cmd === "uvx") return pypi([sub, ...rest].filter(Boolean), { firstOnly: true });
  return null;
}

// Scopes (or everything, for a global `registry=`) served from a private registry according to .npmrc.
export function privateNpmScopes(cwd, { home = homedir() } = {}) {
  let text = "";
  for (const dir of [cwd, home].filter(Boolean)) {
    try {
      // Only a regular file of a sane size: a cloned project's .npmrc linked to /dev/zero would stall every command.
      const st = statSync(join(dir, ".npmrc"));
      if (st.isFile() && st.size <= 1024 * 1024) text += readFileSync(join(dir, ".npmrc"), "utf8") + "\n";
    } catch {
      // No .npmrc here.
    }
  }
  const scopes = new Set();
  let all = false;
  for (const line of text.split("\n")) {
    const scoped = /^\s*(@[^:\s]+):registry\s*=\s*(\S+)/.exec(line);
    if (scoped && !/registry\.npmjs\.org/.test(scoped[2])) scopes.add(scoped[1].toLowerCase());
    const global = /^\s*registry\s*=\s*(\S+)/.exec(line);
    if (global && !/registry\.npmjs\.org/.test(global[1])) all = true;
  }
  return { all, scopes };
}

export function parseInstallCommands(command) {
  const groups = [];
  let words = [];
  const flush = () => {
    const g = parseSegment(words);
    if (g && g.packages.length) groups.push(g);
    words = [];
  };
  for (const t of tokenize(String(command ?? ""))) {
    if (typeof t === "object") flush();
    else words.push(t);
  }
  flush();
  return groups;
}

async function lookup(ecosystem, name, fetchImpl) {
  const url = ecosystem === "npm" ? `https://registry.npmjs.org/${name.replace("/", "%2f")}` : `https://pypi.org/pypi/${name}/json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return { exists: false };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = await res.json();
  if (ecosystem === "npm") return { exists: true, created: doc.time?.created ?? null };
  const times = Object.values(doc.releases ?? {}).flat().map((f) => f.upload_time_iso_8601).filter(Boolean).sort();
  return { exists: true, created: times[0] ?? null };
}

export async function checkPackages({ ecosystem, packages, fetchImpl = fetch, now = new Date() }) {
  return Promise.all(
    packages.map(async (name) => {
      try {
        const info = await lookup(ecosystem, name, fetchImpl);
        if (!info.exists) return { name, exists: false, ageDays: null, verdict: "missing" };
        const ageDays = info.created ? Math.floor((now - new Date(info.created)) / DAY) : null;
        return { name, exists: true, ageDays, verdict: ageDays !== null && ageDays < NEW_PACKAGE_DAYS ? "new" : "ok" };
      } catch {
        return { name, exists: null, ageDays: null, verdict: "unknown" };
      }
    }),
  );
}

const REGISTRY = { npm: "npm", pypi: "PyPI" };

export async function runHook(stdinText, { fetchImpl = fetch, now = new Date() } = {}) {
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (input?.tool_name !== "Bash") return { exitCode: 0, stdout: "", stderr: "" };
  const privateNpm = privateNpmScopes(input.cwd);
  const groups = parseInstallCommands(input.tool_input?.command)
    .map((g) => (g.ecosystem !== "npm" ? g : privateNpm.all ? { ...g, packages: [] } : { ...g, packages: g.packages.filter((p) => !privateNpm.scopes.has(p.split("/")[0])) }))
    .filter((g) => g.packages.length);
  if (!groups.length) return { exitCode: 0, stdout: "", stderr: "" };
  const results = (await Promise.all(groups.map(async (g) => (await checkPackages({ ...g, fetchImpl, now })).map((r) => ({ ...r, ecosystem: g.ecosystem }))))).flat();
  // A scoped name missing from the public registry is usually a private package: ask, don't block.
  for (const r of results) if (r.verdict === "missing" && r.name.startsWith("@")) r.verdict = "private?";
  const missing = results.filter((r) => r.verdict === "missing");
  if (missing.length) {
    const names = missing.map((r) => `${r.name} (${REGISTRY[r.ecosystem]})`).join(", ");
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Repotify guard blocked this install: ${names} does not exist in the registry. The name may be hallucinated or misspelled; check the library's official docs for the exact package name.`,
    };
  }
  const fresh = results.filter((r) => r.verdict === "new" || r.verdict === "private?");
  if (fresh.length) {
    const names = fresh.map((r) => (r.verdict === "new" ? `${r.name} (${r.ageDays} days old)` : `${r.name} (not on the public registry; fine if it is your private package)`)).join(", ");
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Repotify guard: please confirm ${names}. New or unknown packages are a common typosquatting vehicle; make sure this is the package you meant.`,
      },
    };
    return { exitCode: 0, stdout: JSON.stringify(out), stderr: "" };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const groups = parseInstallCommands("npm i react && pip install requests");
    process.stdout.write(groups.length === 2 ? "repotify guard ok\n" : "repotify guard self-test failed\n");
    process.exit(groups.length === 2 ? 0 : 1);
  }
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const r = await runHook(text);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr + "\n");
  process.exit(r.exitCode);
}

function startedDirectly() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (startedDirectly()) await main();
