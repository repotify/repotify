import { existsSync } from "node:fs";
import { join } from "node:path";

// Project-level locations verified against official docs on 2026-09-28:
// code.claude.com/docs/en/skills + /mcp, cursor.com/docs/context/skills + /mcp,
// learn.chatgpt.com/docs/build-skills + /docs/extend/mcp, geminicli.com/docs/cli/skills.
export const AGENTS = {
  "claude-code": {
    label: "Claude Code",
    skillsDir: ".claude/skills",
    mcp: { file: ".mcp.json", format: "json", key: "mcpServers" },
    env: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"],
    aiAgentPrefix: "claude",
    markers: [".claude", "CLAUDE.md"],
  },
  cursor: {
    label: "Cursor",
    skillsDir: ".cursor/skills",
    mcp: { file: ".cursor/mcp.json", format: "json", key: "mcpServers" },
    env: ["CURSOR_AGENT", "CURSOR_TRACE_ID"],
    aiAgentPrefix: "cursor",
    markers: [".cursor", ".cursorrules"],
  },
  codex: {
    label: "Codex",
    skillsDir: ".agents/skills",
    mcp: { file: ".codex/config.toml", format: "toml", key: "mcp_servers" },
    env: ["CODEX_SANDBOX", "CODEX_HOME", "CODEX_MANAGED_BY_NPM"],
    aiAgentPrefix: "codex",
    markers: [".codex", "AGENTS.md"],
  },
  "gemini-cli": {
    label: "Gemini CLI",
    skillsDir: ".gemini/skills",
    mcp: { file: ".gemini/settings.json", format: "json", key: "mcpServers" },
    env: ["GEMINI_CLI"],
    aiAgentPrefix: "gemini",
    markers: [".gemini", "GEMINI.md"],
  },
  generic: {
    label: "Any agent (.agents/skills)",
    skillsDir: ".agents/skills",
    mcp: null,
    env: [],
    aiAgentPrefix: null,
    markers: [],
  },
};

const ORDER = ["claude-code", "cursor", "codex", "gemini-cli"];

export function detectAgents({ env = process.env, cwd = process.cwd() } = {}) {
  const aiAgent = String(env.AI_AGENT ?? "").toLowerCase();
  const fromEnv = ORDER.filter((id) => AGENTS[id].env.some((k) => env[k]) || (aiAgent && aiAgent.startsWith(AGENTS[id].aiAgentPrefix)));
  if (fromEnv.length) return fromEnv;
  const fromFiles = ORDER.filter((id) => AGENTS[id].markers.some((m) => existsSync(join(cwd, m))));
  return fromFiles.length ? fromFiles : ["generic"];
}

export function skillTargets(agentIds) {
  return [...new Set(agentIds.map((id) => AGENTS[id].skillsDir))];
}

export function parseAgentList(value) {
  const ids = String(value).split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!AGENTS[id]) throw new Error(`Unknown agent: ${id}. Known: ${Object.keys(AGENTS).join(", ")}`);
  return ids;
}
