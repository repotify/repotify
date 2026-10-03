// The MCP servers a project has configured, judged like its skills: what each one runs, whether that command is safe
// to keep, whether its version is pinned, and whether a secret was written into a file that is often committed.
// Reads the agents' MCP config files in the project; runs nothing and asks no network. A secret's value is never
// printed, only the name of the variable that holds it.
import { join } from "node:path";
import { AGENTS } from "./agents.mjs";
import { readJsonSafe, readTextSafe } from "./util.mjs";
import { scanFiles } from "./scan/index.mjs";
import { shownName } from "./display.mjs";
import { commandLines, envLines, riskyEnvNames } from "./mcpconfig.mjs";

const MAX_SERVERS = 100;
const SEVERITY = { low: 1, medium: 2, high: 3, critical: 4 };
// Names, hosts and packages come from files a cloned repository controls: shown short and quoted when not plain.
const shown = (value) => shownName(String(value).slice(0, 48));

// `[mcp_servers.<id>]` tables of a Codex config, as far as an audit needs them: command, args and env names.
export function tomlServers(text) {
  const out = {};
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(\.\s*env\s*)?\]\s*$/;
  let current = null;
  let inEnv = false;
  for (const line of text.split(/\r?\n/)) {
    const h = header.exec(line);
    if (h) {
      const id = h[1] ?? h[2] ?? h[3];
      current = out[id] ?? (out[id] = { command: "", args: [], env: {} });
      inEnv = Boolean(h[4]);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const kv = /^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? kv[2];
    let value;
    try {
      value = JSON.parse(kv[3]);
    } catch {
      continue;
    }
    if (inEnv) current.env[key] = value;
    else if (key === "command" && typeof value === "string") current.command = value;
    else if (key === "args" && Array.isArray(value)) current.args = value.map(String);
    else if (key === "url" && typeof value === "string") current.url = value;
  }
  return out;
}

// Every MCP server configured in the project: [{ id, agent, file, command, args, env, url }].
export function configuredServers(root) {
  const out = [];
  const seenFiles = new Set();
  for (const [agent, a] of Object.entries(AGENTS)) {
    if (!a.mcp || seenFiles.has(a.mcp.file)) continue;
    seenFiles.add(a.mcp.file);
    const path = join(root, a.mcp.file);
    let servers = {};
    if (a.mcp.format === "toml") {
      const r = readTextSafe(path);
      if (!r.ok) continue;
      servers = tomlServers(r.text);
    } else {
      const r = readJsonSafe(path);
      const table = r.ok && r.value && typeof r.value === "object" ? r.value[a.mcp.key] : null;
      if (!table || typeof table !== "object" || Array.isArray(table)) continue;
      servers = table;
    }
    for (const [id, s] of Object.entries(servers)) {
      if (out.length >= MAX_SERVERS || !s || typeof s !== "object") continue;
      out.push({
        id, agent, file: a.mcp.file,
        command: typeof s.command === "string" ? s.command : "",
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: s.env && typeof s.env === "object" && !Array.isArray(s.env) ? s.env : {},
        url: typeof s.url === "string" ? s.url : typeof s.serverUrl === "string" ? s.serverUrl : null,
      });
    }
  }
  return out;
}

const RUNNERS = { npx: "npm", bunx: "npm", pnpx: "npm", uvx: "pypi", pipx: "pypi" };
const program = (command) => String(command).split(/[\\/]/).pop().toLowerCase().replace(/\.(cmd|exe|bat)$/, "");

// The package a runner command starts and whether its version is fixed: { registry, name, version, pinned }, or null
// for a command that runs something already on the computer.
export function packageOf(command, args) {
  const cmd = program(command);
  if (cmd === "docker") {
    const image = args.find((a) => /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+(:[\w.-]+)?(@sha256:[0-9a-f]{64})?$/i.test(a));
    if (!image) return null;
    const digest = image.includes("@sha256:");
    const tag = /:([\w.-]+)(@|$)/.exec(image.replace(/^[^/]+\//, ""))?.[1] ?? null;
    return { registry: "docker", name: image.replace(/[:@].*$/, ""), version: digest ? "digest" : tag, pinned: digest || Boolean(tag && tag !== "latest") };
  }
  const registry = RUNNERS[cmd];
  if (!registry) return null;
  const from = args.indexOf("--from");
  const spec = from >= 0 ? args[from + 1] : args.find((a) => !a.startsWith("-"));
  if (!spec) return null;
  const m = /^(@?[^@=<>~!\s]+)(?:(?:@|==)(.+))?$/.exec(spec);
  if (!m) return null;
  const version = m[2] ?? null;
  return { registry, name: m[1].toLowerCase(), version, pinned: Boolean(version && /^\d+(\.\d+)*([.-]?[0-9a-z]+)*$/i.test(version) && !/^(latest|next|beta|canary)$/i.test(version)) };
}

const PLACEHOLDER = /^\s*(<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|your[-_ ].*|x{3,}|changeme|todo|)\s*$/i;
const SECRET_NAME = /(key|token|secret|password|passwd|credential|auth)/i;
const SECRET_VALUE = /(^|[=:\s])(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,})/;

// The names of environment variables whose value in the config looks like a real secret, and whether an argument does.
export function writtenSecrets(server) {
  const names = Object.entries(server.env ?? {})
    .filter(([name, value]) => typeof value === "string" && !PLACEHOLDER.test(value) && (SECRET_VALUE.test(value) || (SECRET_NAME.test(name) && value.length >= 12)))
    .map(([name]) => name);
  return { names, inArgs: (server.args ?? []).some((a) => SECRET_VALUE.test(a)) };
}

// The verdict for each configured server: keep (nothing to do), review (something the user should change) or remove
// (its command fails the security scan). Reasons are plain sentences.
export function auditMcp({ root, catalog = { items: [] } }) {
  const known = new Map();
  for (const item of catalog.items) {
    for (const spec of [item.setup?.npm, item.setup?.pypi]) if (spec) known.set(String(spec).replace(/(.)(@|==)[^@=]*$/, "$1").toLowerCase(), item.id);
  }
  return configuredServers(root).map((s) => {
    const reasons = [];
    let verdict = "keep";
    const raise = (v) => {
      if (v === "remove" || (v === "review" && verdict === "keep")) verdict = v;
    };
    if (s.url && !s.command) {
      let host = "another computer";
      try {
        host = shown(new URL(s.url).host);
      } catch {
        // An address that is not a URL: its text is not repeated.
      }
      reasons.push(`Remote server: what the agent sends it goes to ${host}.`);
    } else {
      // The environment is read with the command: a value can be a command, and a name can redirect the install.
      const scan = scanFiles([{ path: "setup.sh", content: `${[...commandLines(s.command, s.args), ...envLines(s.env)].join("\n")}\n` }]);
      const worst = [...scan.findings].sort((a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0))[0];
      if (scan.level === "rejected" || scan.level === "quarantined") {
        raise("remove");
        reasons.push(`Its command fails the security scan (${worst?.rule ?? "unsafe command"}).`);
      } else if (scan.level === "caution") {
        raise("review");
        reasons.push(`Its command needs a look (${worst?.rule ?? "caution"}).`);
      }
      const pkg = packageOf(s.command, s.args);
      if (pkg) {
        const item = known.get(pkg.name);
        if (!pkg.pinned) {
          raise("review");
          reasons.push(`Not pinned: every start runs whatever ${shown(pkg.name)} published last. Pin a version (${pkg.registry === "docker" ? "image:<tag>" : "name@<version>"}).`);
        }
        reasons.push(item ? `In the catalog as ${item} (vetted).` : "Not in the catalog: Repotify has not vetted it.");
      } else if (s.command) {
        reasons.push("Runs a program already on this computer.");
      }
    }
    const risky = riskyEnvNames(s.env);
    if (risky.length) {
      raise("review");
      reasons.push(`Sets ${risky.slice(0, 5).map(shown).join(", ")}: that changes what the server installs or loads, or where its traffic goes. Keep it only if you set it yourself.`);
    }
    const secrets = writtenSecrets(s);
    if (secrets.names.length || secrets.inArgs) {
      raise("review");
      reasons.push(`A secret is written in ${s.file} (${secrets.names.length ? secrets.names.slice(0, 5).map(shown).join(", ") : "an argument"}): keep it in your environment instead, and rotate it if the file was ever committed.`);
    }
    return { id: s.id, agent: s.agent, file: s.file, command: s.command ? program(s.command) : null, verdict, reasons };
  });
}

const MARK = { keep: "keep    ", review: "review  ", remove: "REMOVE  " };

export function formatMcpAudit(servers) {
  if (!servers.length) return "";
  const lines = [];
  for (const file of [...new Set(servers.map((s) => s.file))]) {
    const own = servers.filter((s) => s.file === file);
    lines.push(`${file}: ${own.length} MCP server${own.length === 1 ? "" : "s"}`);
    for (const s of own) lines.push(`  ${MARK[s.verdict]} ${shown(s.id).padEnd(31)} ${s.reasons.join(" ")}`);
  }
  return lines.join("\n");
}
