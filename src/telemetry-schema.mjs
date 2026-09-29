// Analytics event schema, shared by the client and the Cloudflare Worker. No Node APIs here.
// Only coarse categories and catalog ids are allowed: never code, paths, repo names or user names.

export const EVENT_TYPES = ["run", "shown", "selected", "installed", "kept7d", "removed", "vote"];
export const AGENT_IDS = ["claude-code", "cursor", "codex", "gemini-cli", "generic", "unknown"];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const ALLOWED = new Set(["type", "ts", "installId", "agent", "version", "catalogVersion", "stacks", "needs", "projectType", "items", "item", "vote"]);

export function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["event must be an object"];
  for (const k of Object.keys(e)) if (!ALLOWED.has(k) && e[k] !== undefined) errors.push(`field not allowed: ${k}`);
  if (!EVENT_TYPES.includes(e.type)) errors.push(`invalid type ${e.type}`);
  if (typeof e.ts !== "string" || Number.isNaN(Date.parse(e.ts))) errors.push("invalid ts");
  if (typeof e.installId !== "string" || !UUID_RE.test(e.installId)) errors.push("invalid installId");
  if (e.agent !== undefined && !AGENT_IDS.includes(e.agent)) errors.push("invalid agent");
  for (const k of ["version", "catalogVersion"]) if (e[k] !== undefined && (typeof e[k] !== "string" || !VERSION_RE.test(e[k]))) errors.push(`invalid ${k}`);
  for (const [k, max] of [["stacks", 30], ["needs", 30], ["items", 50]]) {
    if (e[k] === undefined) continue;
    if (!Array.isArray(e[k]) || e[k].length > max || !e[k].every((x) => typeof x === "string" && ID_RE.test(x))) errors.push(`invalid ${k}`);
  }
  if (e.projectType !== undefined && e.projectType !== null && !(typeof e.projectType === "string" && ID_RE.test(e.projectType))) errors.push("invalid projectType");
  if (e.item !== undefined && !(typeof e.item === "string" && ID_RE.test(e.item))) errors.push("invalid item");
  if (e.type === "vote" && (!e.item || !["up", "down"].includes(e.vote))) errors.push("vote needs item and up|down");
  if (e.type !== "vote" && e.vote !== undefined) errors.push("vote only allowed on vote events");
  return errors;
}
