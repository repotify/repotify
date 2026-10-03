// What this computer can run, for the setup a pick needs: the runtimes and tools on PATH, the operating system and the
// CPU. Found by looking for executables on PATH, never by running anything; nothing leaves the machine.
import { statSync } from "node:fs";
import { join } from "node:path";

// Tool id -> the executable names that provide it.
export const TOOLS = Object.freeze({
  node: ["node"], npx: ["npx"], python: ["python3", "python"], uv: ["uv"], uvx: ["uvx"], pipx: ["pipx"], docker: ["docker"],
  git: ["git"], adb: ["adb"], xcrun: ["xcrun"], java: ["java"], go: ["go"], cargo: ["cargo"], deno: ["deno"], bun: ["bun"],
  brew: ["brew"], gh: ["gh"],
});

export function probeMachine({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const dirs = String(env.PATH ?? env.Path ?? "").split(sep).filter(Boolean);
  const exts = platform === "win32" ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()).filter(Boolean) : [""];
  const found = new Map();
  const has = (name) => {
    if (!found.has(name)) {
      found.set(name, dirs.some((d) => exts.some((ext) => {
        try {
          const st = statSync(join(d, name + ext));
          return st.isFile() && (platform === "win32" || (st.mode & 0o111) !== 0);
        } catch {
          return false;
        }
      })));
    }
    return found.get(name);
  };
  const tools = Object.fromEntries(Object.entries(TOOLS).map(([id, names]) => [id, names.some(has)]));
  return { os: platform, arch, tools };
}

// The runtime each kind of command needs. A command the table does not know is never held against an item.
const NEEDS = Object.freeze({ npx: ["npx"], node: ["node"], uvx: ["uvx", "uv"], uv: ["uv"], pipx: ["pipx"], docker: ["docker"], python: ["python"], python3: ["python"], go: ["go"], cargo: ["cargo"], deno: ["deno"], bun: ["bun"], bunx: ["bun"], brew: ["brew"], java: ["java"] });

// What an item needs on this computer and does not find: an MCP server's command, or the first word of a tool's steps.
// An empty list means it can run here (or the machine is unknown).
export function missingRuntime(item, machine) {
  if (!machine?.tools) return [];
  const commands = item.type === "mcp" ? [item.setup?.mcp?.command] : item.type === "tool" ? (item.setup?.steps ?? []).map((s) => String(s).trim().split(/\s+/)[0]) : [];
  const missing = new Set();
  for (const c of commands) {
    const any = NEEDS[String(c ?? "").toLowerCase()];
    if (any && !any.some((t) => machine.tools[t])) missing.add(any[any.length - 1]);
  }
  return [...missing];
}

export function formatMachine(m) {
  const on = Object.entries(m.tools).filter(([, v]) => v).map(([k]) => k);
  return `${m.os}/${m.arch}; tools: ${on.join(", ") || "none found"}`;
}
