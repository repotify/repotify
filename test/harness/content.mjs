// Skill content for phase 2 of a harness run.
// Tries the pinned SKILL.md from the item's source repo (raw.githubusercontent.com,
// commit-pinned for reproducibility), cached locally. Falls back to a catalog
// dossier when the body is unavailable (MCP servers, tools, fetch failures).
// The fallback is recorded per skill so content fidelity is auditable.
import { get } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_CONTENT_CHARS = 4000;

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: timeoutMs, headers: { "User-Agent": "repotify-harness/0.1" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchText(res.headers.location, timeoutMs));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

export function catalogDossier(item) {
  const caps = item.capabilities ?? item.needs ?? [];
  return [
    `# ${item.id}`,
    item.summary ?? "",
    `stacks: ${(item.stacks ?? []).join(", ")}`,
    `capabilities: ${Array.isArray(caps) ? caps.join(", ") : JSON.stringify(caps)}`,
    `tier: ${item.tier ?? "?"} cluster: ${item.cluster ?? "?"}`,
  ].filter(Boolean).join("\n");
}

export async function fetchSkillContent(catalog, id, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const item = catalog.items.find((i) => i.id === id);
  if (!item) return { id, text: `# ${id}\n(not in catalog)`, source: "missing", truncated: false };
  const cacheKey = `${id}@${(item.commit ?? "nocmt").slice(0, 12)}.md`.replace(/[^a-zA-Z0-9@._-]/g, "_");
  const cachePath = join(cacheDir, cacheKey);
  if (existsSync(cachePath)) {
    return { id, text: readFileSync(cachePath, "utf8"), source: "cache", truncated: false };
  }
  const repo = item.repo, commit = item.commit, skillPath = item.path;
  if (repo && commit && skillPath) {
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${skillPath}/SKILL.md`;
    try {
      let text = await fetchText(url);
      const truncated = text.length > MAX_CONTENT_CHARS;
      if (truncated) text = text.slice(0, MAX_CONTENT_CHARS) + "\n\n[…truncated]";
      writeFileSync(cachePath, text);
      return { id, text, source: "github", truncated };
    } catch (err) {
      return { id, text: catalogDossier(item), source: "catalog-fallback", truncated: false, fetchError: String(err.message) };
    }
  }
  return { id, text: catalogDossier(item), source: "catalog-dossier", truncated: false };
}
