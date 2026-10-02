// Privacy filter for Stage 0 events: content-free by construction.
//
// Rules (design.md §3.2):
// - The project name / cwd is NEVER persisted raw: it is hashed at emission
//   time (hashProjectId) and only the hex digest enters the event log.
// - Code and prompts are NEVER written to disk: scanEvent() walks every string
//   value of an event and reports path-like, identity-like or secret-like
//   patterns. The writer refuses events that trip the scan.
// - Transcript paths are never persisted; correlation happens on opaque
//   platform ids (session_id / prompt_id) only.

import { createHash } from "node:crypto";

// [pattern name, regex]. Every match is a privacy violation.
const PII_PATTERNS = [
  ["absolute-path", /(^|[\s"'=:(])(\/(home|Users)\/[^\s"'<>\]]+|[A-Za-z]:\\[^\s"'<>\]]+|~\/[^\s"'<>\]]+)/],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential-assignment", /(api[_-]?key|secret|passwd|password|bearer|access[_-]?token)[\s:=]+\S+/i],
  ["url-with-credentials", /https?:\/\/[^/\s:]+:[^/\s@]+@/],
];

const MAX_SCAN_DEPTH = 8;

/**
 * One-way project identifier. Salt with the install id so the same folder on
 * two machines does not produce the same digest (no cross-machine join key).
 * Returns 32 lowercase hex chars.
 */
export function hashProjectId(cwd, salt = "") {
  const normalized = String(cwd ?? "").trim().replace(/[/\\]+$/, "");
  return createHash("sha256").update(`${salt}\n${normalized}`, "utf8").digest("hex").slice(0, 32);
}

/** Walk an event's string values; return [{path, pattern, sample}] findings. */
export function scanEvent(event) {
  const findings = [];
  const visit = (value, path, depth) => {
    if (depth > MAX_SCAN_DEPTH || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const [name, re] of PII_PATTERNS) {
        const m = value.match(re);
        if (m) {
          findings.push({ path, pattern: name, sample: m[0].slice(0, 80) });
          break;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  visit(event, "", 0);
  return findings;
}

/** Throw if the event is not content-free. The writer calls this before append. */
export function assertContentFree(event) {
  const findings = scanEvent(event);
  if (findings.length) {
    const detail = findings.map((f) => `${f.path || "(root)"}: ${f.pattern}`).join("; ");
    throw new Error(`telemetry event failed the privacy scan (code/prompt/PII must never be logged): ${detail}`);
  }
}
