// Jev (TypeSafe AI "System One" decision model) Node wrapper.
//
// Jev is a SIGNAL INPUT, never the decision maker: cheap local rules decide the
// clear-cut cases, and Jev arbitrates only the ambiguous branches. The host
// algorithm stays the boss. Every call degrades gracefully: when Jev is
// unreachable, disabled, slow, or returns garbage, the wrapper returns null and
// the pipeline continues without it.
//
// Transport: JSON is piped to the OpenRouter decisions endpoint via the
// workspace openrouter skill (bin/jev.py): stdin gets
// { state, questions, model }, stdout yields the API JSON answer.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const existsSync = require("node:fs").existsSync;

const HOME = process.env.HOME ?? "~";
export const DEFAULT_JEV_CMD = path.join(HOME, "workspace", "skills", "openrouter", "bin", "jev.py");
export const DEFAULT_MODEL = "typesafe/jev-1.13";
export const DEFAULT_TIMEOUT_MS = 60000;

// Run the jev.py bridge with a JSON payload on stdin. Returns the parsed
// stdout JSON, or null on any failure (missing binary, timeout, bad JSON,
// non-zero exit, disabled). Never throws for transport reasons.
export async function runJev(payload, { cmd, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  if (process.env.REPOTIFY_JEV === "off") return null;
  const command = cmd ?? process.env.REPOTIFY_JEV_CMD ?? DEFAULT_JEV_CMD;
  const input = JSON.stringify(payload ?? {});
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }
    let out = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done(null);
    }, Math.max(1, timeoutMs));
    child.on("error", () => done(null));
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.length > 1_000_000) {
        try {
          child.kill("SIGKILL");
        } catch {}
        done(null);
      }
    });
    child.on("close", (code) => {
      if (code !== 0) return done(null);
      try {
        done(JSON.parse(out));
      } catch {
        done(null);
      }
    });
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      done(null);
    }
  });
}

const normalizeQuestions = (questions) => {
  const q = {};
  for (const [id, def] of Object.entries(questions ?? {})) q[String(id)] = def;
  return q;
};

export async function jevAsk(state, questions, { model = DEFAULT_MODEL, instructions, ...rest } = {}) {
  const payload = { state, questions: normalizeQuestions(questions), model };
  if (instructions) payload.instructions = instructions;
  return runJev(payload, rest);
}

// Ask Jev to pick one of several named options.
// options: { key: "description", ... }. Returns { option, probability } | null.
export async function jevChoice(state, options, instructions, opts = {}) {
  const answer = await jevAsk(state, { pick: { type: "choice", instructions, criteria: options } }, opts);
  const pick = answer?.questions?.pick ?? answer?.pick;
  if (!pick) return null;
  const option = pick.option ?? pick.selected ?? pick.choice ?? null;
  if (typeof option !== "string" || !(option in (options ?? {}))) return null;
  const probability = Number(pick.probability ?? pick.confidence ?? pick.p ?? NaN);
  return { option, probability: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : null };
}

// Ask Jev to score ordered criteria (0..1 each). criteria: ["fast", "cheap", ...].
// Returns { scores: { name: probability } } | null.
export async function jevScore(state, criteria, instructions, opts = {}) {
  const answer = await jevAsk(state, { rank: { type: "score", instructions, criteria: [...criteria] } }, opts);
  const rank = answer?.questions?.rank ?? answer?.rank;
  if (!rank) return null;
  const raw = rank.scores ?? rank.criteria ?? rank;
  const scores = {};
  for (const name of criteria) {
    const v = Number(raw?.[name]);
    if (Number.isFinite(v)) scores[name] = Math.max(0, Math.min(1, v));
  }
  return Object.keys(scores).length ? { scores } : null;
}

// Ask Jev true/false criteria. criteria: { name: "description" }.
// Returns { truth: { name: boolean }, probability: { name } } | null.
export async function jevNoul(state, criteria, instructions, opts = {}) {
  const answer = await jevAsk(state, { check: { type: "noul", instructions, criteria } }, opts);
  const check = answer?.questions?.check ?? answer?.check;
  if (!check || typeof check !== "object") return null;
  const truth = {};
  const probability = {};
  for (const name of Object.keys(criteria ?? {})) {
    const entry = check[name];
    const value = entry && typeof entry === "object" ? (entry.value ?? entry.truth ?? entry.answer) : entry;
    if (typeof value !== "boolean") return null;
    truth[name] = value;
    const p = Number(entry?.probability ?? entry?.confidence ?? NaN);
    if (Number.isFinite(p)) probability[name] = Math.max(0, Math.min(1, p));
  }
  return { truth, probability };
}

// Adapter implementing the recommendV1 `arbitrate` contract:
//   async (ids: string[]) => Record<id, 0..1> | null
// Scores the ambiguous top candidates against the demand state via Jev's
// score question, returning a 0..1 signal per id. Returns null on any failure
// (unavailable, malformed, <2 ids) — the pipeline treats null as "no
// arbitration" and keeps the local ranking (graceful degradation).
export async function arbitrateWithJev(ids, { state = {}, describe = (id) => id, ...opts } = {}) {
  if (!Array.isArray(ids) || ids.length < 2) return null;
  const names = ids.map(String);
  const legend = names.map((n) => `${n}: ${describe(n) ?? n}`).join("; ");
  const res = await jevScore(
    state,
    names,
    `Score each candidate's fit for this task from 0 to 1. Candidates — ${legend}.`,
    opts,
  );
  return res?.scores ?? null;
}

// Lightweight offline gate for whether Jev is even worth trying. Returns true
// when the command is enabled and the bridge file exists; the real proof is a
// successful call. Used to skip wasted spawns in tight loops.
export function jevLooksAvailable({ cmd } = {}) {
  if (process.env.REPOTIFY_JEV === "off") return false;
  const command = cmd ?? process.env.REPOTIFY_JEV_CMD ?? DEFAULT_JEV_CMD;
  try {
    return existsSync(command);
  } catch {
    return false;
  }
}


// Local fallback: pick the best-scoring branch by a caller-supplied score
// function. Keeps the same return shape as jevChoice so callers can swap the
// arbiter without rewriting logic: local score first, Jev only when scores tie.
export function localChoice(options, scoreFn) {
  const keys = Object.keys(options ?? {});
  if (!keys.length) return null;
  let best = keys[0];
  let bestScore = scoreFn(keys[0]);
  let tie = false;
  for (const k of keys.slice(1)) {
    const s = scoreFn(k);
    if (s > bestScore) {
      best = k;
      bestScore = s;
      tie = false;
    } else if (s === bestScore) {
      tie = true;
    }
  }
  return { option: best, probability: tie ? null : 1, tied: tie };
}
