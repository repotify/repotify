import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS } from "./agents.mjs";

// Placeholders such as "<your token>" are never written: the real value must come from the user's
// environment (docker -e VAR and most MCP clients pass it through), not from a committed config file.
const isPlaceholder = (v) => /^<.*>$/.test(String(v).trim());

function serverConfig(item) {
  const { command, args = [], env = {} } = item.setup.mcp;
  const real = Object.fromEntries(Object.entries(env).filter(([, v]) => !isPlaceholder(v)));
  return Object.keys(real).length ? { command, args, env: real } : { command, args };
}

const tomlString = (s) => JSON.stringify(String(s));

function tomlTable(id, cfg) {
  let text = `[mcp_servers.${id}]\ncommand = ${tomlString(cfg.command)}\nargs = [${cfg.args.map(tomlString).join(", ")}]\n`;
  if (cfg.env) text += `\n[mcp_servers.${id}.env]\n` + Object.entries(cfg.env).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join("\n") + "\n";
  return text;
}

// `"KEY" = "value"` pairs of `[mcp_servers.<id>.env]`, as far as they can be read back.
// A table header, `[a.b]` or an array of tables `[[a.b]]`; the name comes back without quotes or spaces.
const TOML_HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/;
const headerName = (line) => {
  const m = TOML_HEADER.exec(line);
  return m ? m[1].replace(/\s+/g, "").replace(/["']/g, "") : null;
};

function tomlEnvOf(text, id) {
  const env = {};
  let inside = false;
  for (const line of text.split("\n")) {
    const name = headerName(line);
    if (name !== null) {
      inside = name === `mcp_servers.${id}.env`;
      continue;
    }
    const kv = inside && /^\s*(?:"([^"]+)"|([\w.-]+))\s*=\s*("(?:\\.|[^"\\])*")\s*$/.exec(line);
    if (kv) {
      try {
        env[kv[1] ?? kv[2]] = JSON.parse(kv[3]);
      } catch {
        // Unreadable values are left to the user; the new table simply omits them.
      }
    }
  }
  return env;
}

function tomlHasTable(text, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("${esc}"|'${esc}'|${esc})\\s*\\]`, "m").test(text);
}

export function mcpSnippet(item, agentId) {
  const spec = AGENTS[agentId]?.mcp;
  if (!spec) return null;
  const cfg = serverConfig(item);
  if (spec.format === "toml") return { file: spec.file, text: tomlTable(item.id, cfg) };
  return { file: spec.file, text: JSON.stringify({ [spec.key]: { [item.id]: cfg } }, null, 2) + "\n" };
}

function readJsonConfig(path) {
  if (!existsSync(path)) return { ok: true, value: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8").replace(/^\u{FEFF}/u, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// Whether the agent's MCP config can be edited safely (missing is fine; unparseable is not).
export function mcpConfigWritable(agentId, { cwd }) {
  const spec = AGENTS[agentId]?.mcp;
  if (!spec) return { ok: false, reason: "unsupported" };
  if (spec.format === "toml") return { ok: true };
  return readJsonConfig(join(cwd, spec.file)).ok ? { ok: true } : { ok: false, reason: "unparseable", file: spec.file };
}

export function applyMcp(item, agentId, { cwd, replace = false }) {
  const spec = AGENTS[agentId]?.mcp;
  if (!spec) return { written: false, reason: "unsupported" };
  const snippet = mcpSnippet(item, agentId);
  const path = join(cwd, spec.file);
  const base = { file: spec.file, snippet: snippet.text, target: `${spec.file}#${spec.key}.${item.id}` };
  if (spec.format === "toml") {
    let text = existsSync(path) ? readFileSync(path, "utf8") : "";
    let body = snippet.text;
    if (replace && tomlHasTable(text, item.id)) {
      // Keep env values the user added by hand (tokens live there).
      const userEnv = tomlEnvOf(text, item.id);
      if (Object.keys(userEnv).length) body = tomlTable(item.id, { ...serverConfig(item), env: { ...userEnv, ...(serverConfig(item).env ?? {}) } });
      removeMcp(item.id, agentId, { cwd });
      text = readFileSync(path, "utf8");
    }
    if (tomlHasTable(text, item.id)) return { ...base, written: false, reason: "exists" };
    mkdirSync(dirname(path), { recursive: true });
    const prefix = text.trim() === "" ? "" : text.endsWith("\n") ? text + "\n" : text + "\n\n";
    writeFileSync(path, prefix + body);
    return { ...base, written: true };
  }
  const current = readJsonConfig(path);
  if (!current.ok) return { ...base, written: false, reason: "unparseable" };
  const cfg = current.value;
  const servers = cfg[spec.key] && typeof cfg[spec.key] === "object" ? cfg[spec.key] : {};
  if (servers[item.id] && !replace) return { ...base, written: false, reason: "exists" };
  const next = serverConfig(item);
  const userEnv = servers[item.id]?.env;
  if (userEnv && typeof userEnv === "object") next.env = { ...userEnv, ...(next.env ?? {}) };
  cfg[spec.key] = { ...servers, [item.id]: next };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return { ...base, written: true };
}

export function removeMcp(id, agentId, { cwd }) {
  const spec = AGENTS[agentId]?.mcp;
  if (!spec) return { removed: false, reason: "unsupported" };
  const path = join(cwd, spec.file);
  if (!existsSync(path)) return { removed: false, reason: "missing" };
  if (spec.format === "toml") {
    const lines = readFileSync(path, "utf8").split("\n");
    const keep = [];
    let skipping = false;
    for (const line of lines) {
      const name = headerName(line);
      if (name !== null) skipping = name === `mcp_servers.${id}` || name.startsWith(`mcp_servers.${id}.`);
      if (!skipping) keep.push(line);
    }
    writeFileSync(path, keep.join("\n").replace(/\s+$/, "") + "\n");
    return { removed: true };
  }
  const current = readJsonConfig(path);
  if (!current.ok) return { removed: false, reason: "unparseable" };
  if (current.value[spec.key]) delete current.value[spec.key][id];
  writeFileSync(path, JSON.stringify(current.value, null, 2) + "\n");
  return { removed: true };
}

export function agentForMcpFile(file) {
  return Object.keys(AGENTS).find((id) => AGENTS[id].mcp?.file === file) ?? null;
}
