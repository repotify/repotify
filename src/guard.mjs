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
      // Inside double quotes a backslash escapes `"`, `\\`, `$` and the backtick; inside single quotes nothing does.
      if (ch === "\\" && quote === '"' && '"\\$`'.includes(command[i + 1] ?? "")) cur += command[++i];
      else if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "\\") {
      // Outside quotes a backslash makes the next character literal (`\"` is a quote character, not a quote), and
      // a backslash before a newline joins the lines. Reading `\"` as an opening quote swallowed every command
      // after it into one word.
      if (command[i + 1] === "\n") i++;
      else if (i + 1 < command.length) {
        cur += command[++i];
        has = true;
      }
    } else if (ch === "#" && !has) {
      // A comment runs to the end of the line.
      const nl = command.indexOf("\n", i);
      i = (nl < 0 ? command.length : nl) - 1;
    } else if (ch === "'" || ch === '"') {
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

// An install that takes its code from a URL or a git host instead of the registry: `pip install https://…`,
// `npm i github:user/repo`, and the forms that put a familiar name in front of it: PEP 508 `requests @ https://…`
// and `npm i react@https://…`. The name proves nothing there, so the guard asks instead of checking the name.
const REMOTE_RE = /^(https?|ftp|git|ssh):\/\/|^git\+|^(github|gitlab|bitbucket|gist):|^git@/i;
function remoteSource(token, ecosystem) {
  if (REMOTE_RE.test(token)) return token;
  const at = ecosystem === "npm" ? token.indexOf("@", 1) : token.indexOf("@");
  if (at < 0) return null;
  const target = token.slice(at + 1).trim();
  if (REMOTE_RE.test(target)) return target;
  // `user/repo` after the `@` is npm's GitHub shorthand.
  return ecosystem === "npm" && /^[\w.-]+\/[\w.-]+(#.*)?$/.test(target) && !target.startsWith("npm:") ? `github:${target}` : null;
}

function collect(args, valueFlags, toName, { firstOnly = false, ecosystem = "npm", remote = [], files = [] } = {}) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      // `pip install -r requirements.txt`: the packages are in the file.
      if (ecosystem === "pypi" && (a === "-r" || a === "--requirement") && args[i + 1]) files.push(args[i + 1]);
      else if (ecosystem === "pypi" && a.startsWith("--requirement=")) files.push(a.slice("--requirement=".length));
      // `pip install -e git+https://…` installs from the URL like any other; `-e .` is local.
      else if (ecosystem === "pypi" && (a === "-e" || a === "--editable") && remoteSource(args[i + 1] ?? "", ecosystem)) remote.push(args[i + 1]);
      if (valueFlags.has(a)) i++;
      continue;
    }
    // A bare `@` joins the words around it (`requests @ https://…` typed without quotes).
    const joined = args[i + 1] === "@" && args[i + 2] ? `${a}@${args[i + 2]}` : a;
    if (joined !== a) i += 2;
    const from = remoteSource(joined, ecosystem);
    if (from) remote.push(from);
    else {
      const n = toName(joined);
      if (n) out.push(n);
    }
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

// Words that run the command after them: `sudo -E npm i x`, `env npm i x`, `nice -n 5 npm i x`, `timeout 60 npm i x`.
// The guard read only a bare `sudo`, so any of these in front made the install invisible.
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "builtin", "nice", "ionice", "stdbuf", "timeout", "caffeinate", "unbuffer"]);
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-D", "-R", "-T", "-n", "-c", "-i", "-o", "-e", "-k", "-s", "-S"]);

// The program a word runs: the last path segment, without a Windows shim extension (`/usr/local/bin/npm`, `npm.cmd`).
function programOf(word) {
  return word.split(/[\\/]/).pop().toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
}

const NODE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];
const isPip = (cmd) => /^pip(3(\.\d+)?)?$/.test(cmd);
const isPython = (cmd) => /^(python(3(\.\d+)?)?|py)$/.test(cmd);
const PYTHON_VALUE_FLAGS = new Set(["-W", "-X", "--check-hash-based-pycs"]);

function parseSegment(rawWords) {
  let w = unwrap(rawWords);
  // An env prefix chooses the registry the install actually uses: `NPM_CONFIG_REGISTRY=https://evil npm i pkg`
  // must not be checked against the public registry.
  let envRegistry = "";
  let wrapped = false;
  while (w.length) {
    const reg = /^(NPM_CONFIG_REGISTRY|PIP_INDEX_URL|UV_INDEX_URL|UV_DEFAULT_INDEX|PIP_EXTRA_INDEX_URL)=(\S+)/i.exec(w[0]);
    if (reg) envRegistry = reg[2];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    else if (WRAPPERS.has(programOf(w[0]))) {
      wrapped = true;
      w = w.slice(1);
    } else if (wrapped && w[0].startsWith("-")) w = w.slice(WRAPPER_VALUE_FLAGS.has(w[0]) ? 2 : 1);
    // `nice 10 …`, `timeout 60s …`: a number right after a wrapper is its argument.
    else if (wrapped && /^\d+(\.\d+)?[smhd]?$/.test(w[0])) w = w.slice(1);
    else break;
  }
  if (!w.length) return null;
  const cmd = programOf(w[0]);
  const ecosystem = [...NODE_MANAGERS, "npx", "bunx"].includes(cmd) ? "npm" : "pypi";
  // A registry given on the command line (or by an env prefix) is one the guard cannot check, and a look-alike of
  // the public one is the point of the attack: the group comes back with the registry instead of vanishing.
  const custom = (envRegistry && !PUBLIC_REGISTRY_RE.test(envRegistry)) || usesCustomRegistry(w.slice(1), ecosystem);
  const isNode = NODE_MANAGERS.includes(cmd);
  const [sub, ...rest] = isNode ? skipLeadingFlags(w.slice(1), NPM_VALUE_FLAGS) : w.slice(1);
  const group = (eco, flags, toName) => (args, opts) => {
    const remote = [];
    const files = [];
    const packages = collect(args, flags, toName, { ...opts, ecosystem: eco, remote, files });
    return { ecosystem: eco, packages, remote, files, customRegistry: Boolean(custom) };
  };
  const npm = group("npm", NPM_VALUE_FLAGS, npmName);
  const pypi = group("pypi", PIP_VALUE_FLAGS, pypiName);
  // `npx -p pkg cmd` / `npm exec --package=pkg -- cmd` install and run `pkg`, not `cmd`: the package under
  // scrutiny is the -p/--package value. Without it, fall back to the first positional as before.
  const execPackages = (args) => {
    const named = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-p" || a === "--package") named.push(args[++i] ?? "");
      else if (a.startsWith("--package=")) named.push(a.slice("--package=".length));
    }
    return named.length ? npm(named.filter(Boolean)) : npm(args, { firstOnly: true });
  };
  if (cmd === "npm" && ["i", "install", "add", "isntall", "in"].includes(sub)) return npm(rest);
  // `npm exec` / `npm x` download and run a package exactly like `npx` does.
  if (cmd === "npm" && (sub === "exec" || sub === "x")) return execPackages(rest);
  if ((cmd === "pnpm" || cmd === "bun") && ["add", "i", "install"].includes(sub)) return npm(rest);
  if (cmd === "yarn" && sub === "add") return npm(rest);
  if (cmd === "yarn" && sub === "workspace" && rest[1] === "add") return npm(rest.slice(2));
  if (cmd === "npx" || cmd === "bunx") return execPackages([sub, ...rest].filter(Boolean));
  if ((cmd === "pnpm" || cmd === "yarn") && sub === "dlx") return execPackages(rest);
  if (isPip(cmd) && sub === "install") return pypi(rest);
  if (isPython(cmd)) {
    // `python -u -m pip install …`, `py -3 -m pip install …`: options may come before `-m`.
    const args = w.slice(1);
    let k = 0;
    while (k < args.length && args[k].startsWith("-") && args[k] !== "-m") k += PYTHON_VALUE_FLAGS.has(args[k]) ? 2 : 1;
    if (args[k] === "-m" && args[k + 1] === "pip" && args[k + 2] === "install") return pypi(args.slice(k + 3));
    return null;
  }
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
    // A group with a custom registry has nothing the public registry can vouch for: its names are not checked.
    if (g && (g.packages.length || g.remote.length || g.files.length || g.customRegistry)) {
      groups.push({
        ecosystem: g.ecosystem,
        packages: g.customRegistry ? [] : g.packages,
        ...(g.remote.length ? { remote: g.remote } : {}),
        ...(g.files.length ? { files: g.files } : {}),
        ...(g.customRegistry ? { customRegistry: true } : {}),
      });
    }
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

// At most this many packages of one command are looked up, a few at a time: a command naming hundreds of packages
// must not open hundreds of connections (each with its own 8 s timeout).
export const MAX_CHECKED_PACKAGES = 25;
const LOOKUPS_AT_ONCE = 6;

export async function checkPackages({ ecosystem, packages, fetchImpl = fetch, now = new Date() }) {
  const out = new Array(packages.length);
  let next = 0;
  const worker = async () => {
    while (next < packages.length) {
      const n = next++;
      const name = packages[n];
      try {
        const info = await lookup(ecosystem, name, fetchImpl);
        if (!info.exists) out[n] = { name, exists: false, ageDays: null, verdict: "missing" };
        else {
          const ageDays = info.created ? Math.floor((now - new Date(info.created)) / DAY) : null;
          out[n] = { name, exists: true, ageDays, verdict: ageDays !== null && ageDays < NEW_PACKAGE_DAYS ? "new" : "ok" };
        }
      } catch {
        out[n] = { name, exists: null, ageDays: null, verdict: "unknown" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, packages.length) }, worker));
  return out;
}

const REGISTRY = { npm: "npm", pypi: "PyPI" };
const MAX_REQUIREMENTS_BYTES = 256 * 1024;

// The package names in a requirements file, as far as they can be read: comments, options and URLs are skipped.
// `remote` collects the lines that install from a URL. null when the file cannot be read.
export function requirementNames(cwd, file, remote = []) {
  try {
    const path = join(cwd ?? ".", file);
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_REQUIREMENTS_BYTES) return null;
    const names = [];
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line || line.startsWith("-")) continue;
      const from = remoteSource(line, "pypi");
      if (from) remote.push(from);
      else {
        const n = pypiName(line);
        if (n) names.push(n);
      }
    }
    return names;
  } catch {
    return null;
  }
}

const shown = (text) => String(text).replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
const ask = (reason) => ({
  exitCode: 0,
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `Repotify guard: ${reason}` } }),
  stderr: "",
});

export async function runHook(stdinText, { fetchImpl = fetch, now = new Date() } = {}) {
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (input?.tool_name !== "Bash") return { exitCode: 0, stdout: "", stderr: "" };
  const privateNpm = privateNpmScopes(input.cwd);
  const parsed = parseInstallCommands(input.tool_input?.command);
  // What the guard cannot check is said, not passed over: an install from a URL, a registry it does not know, a
  // requirements file it cannot read.
  const unchecked = [];
  for (const g of parsed) {
    for (const r of g.remote ?? []) unchecked.push(`${shown(r)} is installed from a URL, not from the registry`);
    if (g.customRegistry) unchecked.push(`the command names a registry other than the public ${REGISTRY[g.ecosystem]} one`);
    for (const f of g.files ?? []) {
      const remote = [];
      const names = requirementNames(input.cwd, f, remote);
      if (names === null) unchecked.push(`the packages in ${shown(f)} could not be read`);
      else g.packages = [...g.packages, ...names];
      for (const r of remote) unchecked.push(`${shown(r)} (from ${shown(f)}) is installed from a URL, not from the registry`);
    }
  }
  const groups = parsed
    .map((g) => ({ ecosystem: g.ecosystem, packages: [...new Set(g.packages)] }))
    .map((g) => (g.ecosystem !== "npm" ? g : privateNpm.all ? { ...g, packages: [] } : { ...g, packages: g.packages.filter((p) => !privateNpm.scopes.has(p.split("/")[0])) }))
    .filter((g) => g.packages.length);
  let budget = MAX_CHECKED_PACKAGES;
  let skipped = 0;
  for (const g of groups) {
    skipped += Math.max(0, g.packages.length - budget);
    g.packages = g.packages.slice(0, budget);
    budget -= g.packages.length;
  }
  if (skipped) unchecked.push(`${skipped} more package${skipped === 1 ? " was" : "s were"} not checked (only the first ${MAX_CHECKED_PACKAGES} are)`);
  const results = [];
  for (const g of groups) {
    if (g.packages.length) results.push(...(await checkPackages({ ...g, fetchImpl, now })).map((r) => ({ ...r, ecosystem: g.ecosystem })));
  }
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
  // The registry did not answer: the package was not checked, which is not the same as the package being fine.
  const unknown = results.filter((r) => r.verdict === "unknown");
  if (unknown.length) unchecked.push(`${unknown.slice(0, 5).map((r) => r.name).join(", ")} could not be checked (the ${[...new Set(unknown.map((r) => REGISTRY[r.ecosystem]))].join(" and ")} registry did not answer)`);
  if (fresh.length) {
    const names = fresh.map((r) => (r.verdict === "new" ? `${r.name} (${r.ageDays} days old)` : `${r.name} (not on the public registry; fine if it is your private package)`)).join(", ");
    const rest = unchecked.length ? ` Also: ${unchecked.join("; ")}.` : "";
    return ask(`please confirm ${names}. New or unknown packages are a common typosquatting vehicle; make sure this is the package you meant.${rest}`);
  }
  if (unchecked.length) return ask(`not checked: ${unchecked.join("; ")}. Confirm this is what you meant to install.`);
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
