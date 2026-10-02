// Stage 0 (FAZ 1) event schema — v1.
//
// Design inputs: research_notes/repotify-algorithm-deep-design/design.md §3,
// monitoring.md §3. Append-only JSONL, Node 18+, no dependencies.
//
// D4 — REWARD-FORMULA-AGNOSTIC: this schema records RAW observations only.
// Computed rewards, learned weights, score formulas and bandit internals NEVER
// belong in an event. validateEvent() rejects reward/score/weight field names
// outright, so a future reward change cannot silently leak into the log.
//
// B1 — OFFLINE REPLAY READY: every recommendation records the FULL propensity
// record (one propensity per considered candidate, shown or not). Propensity is
// always strictly below 1 (0 < p < 1): deterministic slots would break IPS/SNIPS
// and any offline replay. See lib/learn/ope.mjs (FAZ 11).
//
// `is_explore` (P3 / DL-051, ACTIVE): marks the candidate that entered the
// set via ε-greedy exploration (vs the greedy picks). Single producer:
// trackRecommendationV1 in src/cli.mjs (DL-051d). The serving policy explores
// with prob ε=0.05 per decision (DL-051a: quota granularity = per-decision);
// the swap uses only safety-filtered candidates (DL-051b: arbitrate-safe).
// Consumer: lib/learn/ope.mjs counterfactual estimators (DL-051c).
//
// Content-free by construction: enums, ids, counts, booleans, hashes.
// Never: code, prompts, file paths, repo names, user names, transcripts,
// outputs, raw error strings.

export const SCHEMA_VERSION = 1;

// P4 (hybrid attribution): where an install came from determines whether the
// invoke channel is observable for that (episode, skill) pair.
//   "repotify"    repotify installed it and wrapped it (instrument.mjs) → invoke fully observed
//   "third-party" platform-redacted catalog install → invoke channel blind
//   "external"    user installed it outside repotify → weak signals only
export const INSTALL_SOURCES = ["repotify", "third-party", "external"];

// Event types. `removed` (late) vs `removed_fast` (<=7d) are distinct on
// purpose: fast removal is the stronger negative signal (monitoring.md §2.1).
export const EVENT_TYPES = [
  "recommendation", // one recommendation episode: full slate + propensity per candidate
  "install",        // catalog item installed (from a recommendation or directly)
  "select",         // item switched on without install (hook / MCP server enable)
  "invoke",         // the agent loaded or called the item
  "abandon",       // task given up mid-way (back to grep / manual = double-payment signal)
  "fallback",       // deterministic capability-graph fallback edge taken
  "outcome",        // task finished: raw success boolean + optional raw quality rating
  "kept_30d",       // still installed after 30 days (slow signal; joins late)
  "removed_fast",   // removed within 7 days of install
  "removed",        // removed after 7 days
  "replaced",       // removed in favour of another item (pairwise preference)
  "question",       // elicitation question asked / answered / skipped
  "usage",          // tokens + latency, on platforms where measurable
];

export const AGENT_IDS = ["claude-code", "opencode", "codex", "openclaw", "cursor", "gemini-cli", "generic", "unknown"];
export const INVOCATION_KINDS = ["explicit", "implicit", "load"];
export const REMOVAL_REASONS = ["project_changed", "internalized", "unused", "broken", "other"];
export const ABANDON_REASONS = ["gave_up", "timeout", "switched_tool"];
export const FALLBACK_TRIGGERS = ["invoke_failed", "invoke_timeout", "removed", "manual"];

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const HASH_RE = /^[0-9a-f]{16,64}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ANSWER_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
// Model labels like "z-ai/glm-5.3" — short, opaque, never free text.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

// D4: computed values must never be logged as if they were observations.
const FORBIDDEN_COMPUTED = new Set([
  "reward", "expected_reward", "r_hat", "score", "scores", "weight", "weights",
  "theta", "ucb", "lcb", "value_estimate", "advantage",
]);

const SHARED = new Set([
  "type", "ts", "schema_version", "seq", "gen", "install_id", "episode_id", "agent",
  "cli_version", "catalog_version", "policy_name", "policy_version",
  "project_hash", "session_id", "prompt_id", "skill_id", "skill_ids",
]);

// Per-type field allowlists. `req` = required, `opt` = optional.
const TYPE_FIELDS = {
  recommendation: {
    req: ["episode_id", "candidates"],
    // `randomized`: was the slate order/selection actually randomized? IPS and
    // other counterfactual estimators must only trust propensities from
    // randomized episodes; absent = unknown (v1 static policy).
    // `gate_decisions`: the coverage gate's audit trail — one structured
    // decision record per evaluated candidate (reason code, Jaccard, blocker).
    opt: ["policy_name", "policy_version", "budget_chars", "randomized", "gate_decisions"],
  },
  install: { req: ["skill_id"], opt: ["episode_id", "from_recommendation", "install_source"] },
  select: { req: ["skill_id"], opt: ["episode_id", "target", "install_source"] },
  invoke: { req: ["skill_id", "invocation_kind"], opt: ["episode_id", "session_id"] },
  abandon: { req: [], opt: ["episode_id", "skill_id", "reason"] },
  fallback: { req: ["from_skill", "to_skill"], opt: ["episode_id", "trigger"] },
  outcome: {
    req: ["task_success"],
    opt: ["episode_id", "skill_ids", "quality", "skill_free_baseline"],
  },
  kept_30d: { req: ["skill_id"], opt: ["episode_id"] },
  removed_fast: { req: ["skill_id", "removal_reason"], opt: ["episode_id"] },
  removed: { req: ["skill_id", "removal_reason"], opt: ["episode_id"] },
  replaced: { req: ["skill_id", "replaced_by"], opt: ["episode_id"] },
  question: {
    req: ["question_id"],
    opt: ["episode_id", "answer", "was_confirm", "skipped", "question_propensity"],
  },
  usage: {
    req: [],
    // `model_id`: which model produced the measured counts — raw input label
    // for report-time cost estimation (D4-safe: an observed label, not a
    // computed value). Phase 0, 2026-10-01.
    opt: ["episode_id", "skill_id", "tokens_in", "tokens_out", "latency_ms", "model_id"],
  },
};

const EXTRA_ALLOWED = new Set([
  "candidates", "budget_chars", "randomized", "from_recommendation", "target", "invocation_kind",
  "reason", "from_skill", "to_skill", "trigger", "task_success", "quality",
  "skill_free_baseline", "removal_reason", "replaced_by", "question_id",
  "answer", "was_confirm", "skipped", "question_propensity",
  "tokens_in", "tokens_out", "latency_ms", "model_id", "install_source", "gate_decisions",
]);

function isId(v) { return typeof v === "string" && ID_RE.test(v); }
function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }
function isNonNegInt(v) { return Number.isInteger(v) && v >= 0; }

function checkCandidate(c, i, errors) {
  const where = `candidates[${i}]`;
  if (!c || typeof c !== "object" || Array.isArray(c)) { errors.push(`${where} must be an object`); return; }
  const allowed = new Set(["skill_id", "position", "propensity", "shown", "raw_score", "is_explore"]);
  for (const k of Object.keys(c)) if (!allowed.has(k)) errors.push(`${where}: field not allowed: ${k}`);
  if (!isId(c.skill_id)) errors.push(`${where}: invalid skill_id`);
  if (!isNonNegInt(c.position)) errors.push(`${where}: position must be a non-negative integer`);
  // B1: propensity is ALWAYS strictly below 1 — deterministic slots break
  // offline replay / counterfactual estimators.
  if (typeof c.propensity !== "number" || !(c.propensity > 0) || !(c.propensity < 1)) {
    errors.push(`${where}: propensity must satisfy 0 < p < 1`);
  }
  if (typeof c.shown !== "boolean") errors.push(`${where}: shown must be a boolean`);
  if (c.raw_score !== undefined && (typeof c.raw_score !== "number" || !Number.isFinite(c.raw_score))) {
    errors.push(`${where}: raw_score must be a finite number`);
  }
  if (c.is_explore !== undefined && typeof c.is_explore !== "boolean") {
    errors.push(`${where}: is_explore must be a boolean`);
  }
}

function checkGateDecision(g, i, errors) {
  const where = `gate_decisions[${i}]`;
  if (!g || typeof g !== "object" || Array.isArray(g)) { errors.push(`${where} must be an object`); return; }
  const allowed = new Set(["skill_id", "decision", "reason", "variant", "jaccard", "blocker"]);
  for (const k of Object.keys(g)) if (!allowed.has(k)) errors.push(`${where}: field not allowed: ${k}`);
  if (!isId(g.skill_id)) errors.push(`${where}: invalid skill_id`);
  if (g.decision !== "selected" && g.decision !== "dropped") errors.push(`${where}: decision must be selected|dropped`);
  if (typeof g.reason !== "string" || !g.reason.length) errors.push(`${where}: reason must be a non-empty string`);
  if (typeof g.variant !== "string" || !g.variant.length) errors.push(`${where}: variant must be a non-empty string`);
  if (g.jaccard !== null && (typeof g.jaccard !== "number" || !(g.jaccard >= 0) || !(g.jaccard <= 1))) {
    errors.push(`${where}: jaccard must be a number in [0,1] or null`);
  }
  if (g.blocker !== null && typeof g.blocker !== "string") errors.push(`${where}: blocker must be a string id or null`);
}

export function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["event must be an object"];
  for (const k of Object.keys(e)) {
    if (FORBIDDEN_COMPUTED.has(k)) {
      errors.push(`computed field not allowed in raw schema (D4): ${k}`);
      continue;
    }
    if (!SHARED.has(k) && !EXTRA_ALLOWED.has(k) && e[k] !== undefined) errors.push(`field not allowed: ${k}`);
  }
  if (!EVENT_TYPES.includes(e.type)) { errors.push(`invalid type ${e.type}`); return errors; }
  if (typeof e.ts !== "string" || Number.isNaN(Date.parse(e.ts))) errors.push("invalid ts");
  if (e.schema_version !== undefined && e.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  }
  // Monotonic per-generation sequence number, stamped by the store.
  // Readers use it for gap detection: a missing seq means lost events.
  if (e.seq !== undefined && !isNonNegInt(e.seq)) errors.push("seq must be a non-negative integer");
  // Generation id, stamped by the store, incremented on rotation. (gen, seq)
  // totally orders the log across rotations; the sync watermark uses it.
  if (e.gen !== undefined && !isNonNegInt(e.gen)) errors.push("gen must be a non-negative integer");
  if (!isUuid(e.install_id)) errors.push("invalid install_id");
  if (e.episode_id !== undefined && !isUuid(e.episode_id)) errors.push("invalid episode_id");
  if (e.agent !== undefined && !AGENT_IDS.includes(e.agent)) errors.push("invalid agent");
  for (const k of ["cli_version", "catalog_version"]) {
    if (e[k] !== undefined && (typeof e[k] !== "string" || !VERSION_RE.test(e[k]))) errors.push(`invalid ${k}`);
  }
  for (const k of ["policy_name", "policy_version"]) {
    if (e[k] !== undefined && (typeof e[k] !== "string" || !VERSION_RE.test(e[k]))) errors.push(`invalid ${k}`);
  }
  if (e.project_hash !== undefined && !(typeof e.project_hash === "string" && HASH_RE.test(e.project_hash))) {
    errors.push("invalid project_hash");
  }
  for (const k of ["session_id", "prompt_id"]) {
    if (e[k] !== undefined && !(typeof e[k] === "string" && OPAQUE_ID_RE.test(e[k]))) errors.push(`invalid ${k}`);
  }
  if (e.skill_id !== undefined && !isId(e.skill_id)) errors.push("invalid skill_id");
  if (e.skill_ids !== undefined) {
    if (!Array.isArray(e.skill_ids) || e.skill_ids.length > 100 || !e.skill_ids.every(isId)) errors.push("invalid skill_ids");
  }

  const spec = TYPE_FIELDS[e.type];
  for (const k of spec.req) if (e[k] === undefined) errors.push(`${e.type} requires ${k}`);
  const allowedForType = new Set([...SHARED, ...spec.req, ...spec.opt]);
  for (const k of Object.keys(e)) {
    if (e[k] !== undefined && !allowedForType.has(k)) errors.push(`${e.type}: field not allowed: ${k}`);
  }

  switch (e.type) {
    case "recommendation": {
      if (!Array.isArray(e.candidates) || e.candidates.length === 0 || e.candidates.length > 100) {
        errors.push("recommendation requires a non-empty candidates array (max 100)");
      } else {
        e.candidates.forEach((c, i) => checkCandidate(c, i, errors));
        const seen = new Set();
        for (const c of e.candidates) {
          if (c && typeof c.skill_id === "string") {
            if (seen.has(c.skill_id)) errors.push(`duplicate candidate skill_id: ${c.skill_id}`);
            seen.add(c.skill_id);
          }
        }
      }
      if (e.budget_chars !== undefined && !isNonNegInt(e.budget_chars)) errors.push("invalid budget_chars");
      if (e.randomized !== undefined && typeof e.randomized !== "boolean") errors.push("randomized must be a boolean");
      if (e.gate_decisions !== undefined) {
        if (!Array.isArray(e.gate_decisions)) {
          errors.push("gate_decisions must be an array");
        } else {
          e.gate_decisions.forEach((g, i) => checkGateDecision(g, i, errors));
        }
      }
      break;
    }
    case "install":
      if (e.from_recommendation !== undefined && typeof e.from_recommendation !== "boolean") {
        errors.push("from_recommendation must be a boolean");
      }
      if (e.install_source !== undefined && !INSTALL_SOURCES.includes(e.install_source)) {
        errors.push(`install_source must be one of ${INSTALL_SOURCES.join("|")}`);
      }
      break;
    case "select":
      if (e.target !== undefined && !AGENT_IDS.includes(e.target)) errors.push("invalid target");
      if (e.install_source !== undefined && !INSTALL_SOURCES.includes(e.install_source)) {
        errors.push(`install_source must be one of ${INSTALL_SOURCES.join("|")}`);
      }
      break;
    case "invoke":
      if (!INVOCATION_KINDS.includes(e.invocation_kind)) errors.push("invalid invocation_kind");
      break;
    case "abandon":
      if (e.reason !== undefined && !ABANDON_REASONS.includes(e.reason)) errors.push("invalid reason");
      break;
    case "fallback":
      if (!isId(e.from_skill)) errors.push("invalid from_skill");
      if (!isId(e.to_skill)) errors.push("invalid to_skill");
      if (e.trigger !== undefined && !FALLBACK_TRIGGERS.includes(e.trigger)) errors.push("invalid trigger");
      break;
    case "outcome":
      if (typeof e.task_success !== "boolean") errors.push("task_success must be a boolean");
      if (e.quality !== undefined && (!Number.isInteger(e.quality) || e.quality < 1 || e.quality > 5)) {
        errors.push("quality must be an integer 1..5 (raw recorded rating, not a computed reward)");
      }
      if (e.skill_free_baseline !== undefined && typeof e.skill_free_baseline !== "boolean") {
        errors.push("skill_free_baseline must be a boolean");
      }
      break;
    case "removed_fast":
    case "removed":
      if (!REMOVAL_REASONS.includes(e.removal_reason)) errors.push("invalid removal_reason");
      break;
    case "replaced":
      if (!isId(e.replaced_by)) errors.push("invalid replaced_by");
      break;
    case "question":
      if (!isId(e.question_id)) errors.push("invalid question_id");
      if (e.answer !== undefined && !(typeof e.answer === "string" && ANSWER_RE.test(e.answer))) {
        errors.push("invalid answer (must be a short enum token, never free text)");
      }
      for (const k of ["was_confirm", "skipped"]) {
        if (e[k] !== undefined && typeof e[k] !== "boolean") errors.push(`${k} must be a boolean`);
      }
      if (e.question_propensity !== undefined &&
          (typeof e.question_propensity !== "number" || !(e.question_propensity > 0) || !(e.question_propensity < 1))) {
        errors.push("question_propensity must satisfy 0 < p < 1");
      }
      break;
    case "usage":
      for (const k of ["tokens_in", "tokens_out", "latency_ms"]) {
        if (e[k] !== undefined && (!isNonNegInt(e[k]) || e[k] > 1e12)) errors.push(`invalid ${k}`);
      }
      if (e.model_id !== undefined && !(typeof e.model_id === "string" && MODEL_ID_RE.test(e.model_id))) {
        errors.push("invalid model_id (short opaque model label, e.g. z-ai/glm-5.3)");
      }
      if (e.episode_id === undefined && e.skill_id === undefined) {
        errors.push("usage requires episode_id and/or skill_id for attribution");
      }
      break;
    default:
      break;
  }
  return errors;
}
