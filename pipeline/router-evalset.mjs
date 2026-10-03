#!/usr/bin/env node
// An eval set for the skill router that the router's author did not write: a language model reads the skills'
// descriptions and writes the requests a developer would type, with the skills that should handle each, and requests
// no skill should handle. Written once and kept (test/eval/router-independent.json); the router is never tuned on it.
//   node pipeline/router-evalset.mjs --env-file FILE [--round 2] [--from-raw] [--out test/eval/router-independent.json] [--model z-ai/glm-5.3]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain } from "../src/util.mjs";
import { glmChat, readEnvFile } from "./research.mjs";
import { flag, logStamped } from "./lib/cli.mjs";

const RULES = `Rules: write what a developer types to a coding agent in a chat, the way people really write: some terse, some long, some informal, some describing a symptom instead of naming the task. Never use a skill's name or id in a request. No numbering inside the text. Keep your reasoning short. Answer with JSON only.`;

// Each batch is one question to the model. `--round` picks the set: the first round was read while the router was
// being built, so the claim in the docs comes from the second, which the router was never tuned on.
const work = (id, language, extra) => ({ id, language, n: 40, ask: (n) => `Write ${n} requests in ${language}${language === "Turkish" ? ", the way Turkish developers write (English technical terms mixed in)" : ""}. ${extra} Each must be work one of the skills below should handle; cover every skill at least once.` });
const none = (id, language) => ({ id, language, n: 40, ask: (n) => `Write ${n} requests in ${language} that NONE of the skills below should handle: small commands, simple edits, questions about facts, navigation, chit-chat, confirmations, one-line fixes. They must still be things people type to a coding agent.` });
export const ROUNDS = {
  1: [work("en-1", "English", ""), work("en-2", "English", "Take everyday situations in a web or backend project (a bug report, a feature wish, a release, a slow page, a risky change) and prefer indirect wording: describe the situation, not the task."), work("tr-1", "Turkish", ""), { ...none("none", "English and Turkish (half each)"), n: 50 }],
  2: [
    work("en-3", "English", "Write as a busy developer in the middle of work: short, lower-case, sometimes impatient."),
    work("en-4", "English", "Write as someone newer to programming who describes what they see on screen rather than naming the technique."),
    work("tr-2", "Turkish", "Kısa ve gündelik yaz."),
    work("tr-3", "Turkish", "Durumu anlatarak yaz: ne olduğunu, ne beklediğini."),
    none("none-en", "English"),
    none("none-tr", "Turkish"),
  ],
};
export const BATCHES = ROUNDS[1];

export function batchPrompt(batch, skills) {
  const list = skills.map((s) => `- ${s.id}: ${s.description.slice(0, 500)}`).join("\n");
  const shape = batch.id.startsWith("none") ? `[{"prompt": "..."}]` : `[{"prompt": "...", "expect": ["skill-id", "optional-second-skill-id"]}]  ("expect" lists the one or two skills that fit best, by id)`;
  return [
    { role: "system", content: `You write evaluation data for a tool that suggests which installed coding-agent skill fits a request. ${RULES}` },
    { role: "user", content: `${batch.ask(batch.n)}\n\nSkills:\n${list}\n\nAnswer as a JSON array: ${shape}` },
  ];
}

// Every complete JSON object in a reply that carries a request: a reply cut off mid-array still gives its whole rows.
export function objectsIn(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth++ === 0) start = i;
    } else if (ch === "}" && depth > 0 && --depth === 0) {
      try {
        out.push(JSON.parse(text.slice(start, i + 1)));
      } catch {
        // Not JSON after all: skipped.
      }
    }
  }
  return out;
}

// A reply's request rows, with known skill ids only.
export function readBatch(text, batch, ids) {
  const out = [];
  for (const r of objectsIn(String(text))) {
    const prompt = String(r?.prompt ?? "").replace(/\s+/g, " ").trim();
    if (prompt.length < 2 || prompt.length > 400) continue;
    const idle = batch.id.startsWith("none");
    const expect = idle ? [] : (Array.isArray(r.expect) ? r.expect : []).filter((id) => ids.has(id)).slice(0, 2);
    if (!idle && !expect.length) continue;
    out.push({ prompt, expect, batch: batch.id });
  }
  return out;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const env = { ...process.env, ...(flag(args, "--env-file") ? readEnvFile(flag(args, "--env-file")) : {}) };
  const keys = [1, 2, 3, 4].map((i) => env[`Nvdia${i}`] || env[`NVIDIA_API_KEY_${i}`]).filter(Boolean);
  if (!keys.length) throw new Error("no model key (Nvdia1..4 in --env-file)");
  const skills = JSON.parse(readFileSync(new URL("../test/eval/router-skills.json", import.meta.url), "utf8"));
  const ids = new Set(skills.map((s) => s.id));
  const model = flag(args, "--model", "z-ai/glm-5.3");
  const out = resolve(flag(args, "--out", "test/eval/router-independent.json"));
  const batches = ROUNDS[flag(args, "--round", "1")];
  if (!batches) throw new Error("unknown --round");
  const results = await Promise.all(batches.map(async (batch, i) => {
    // The raw reply is kept beside the result: with --from-raw the set is put together from the replies already
    // there, and only the batches that never answered are asked again.
    const raw = `${out}.${batch.id}.txt`;
    let text = args.includes("--from-raw") && existsSync(raw) ? readFileSync(raw, "utf8") : "";
    if (!text) {
      try {
        text = await glmChat({ key: keys[i % keys.length], messages: batchPrompt(batch, skills), model, maxTokens: 16000, log: logStamped });
      } catch (error) {
        logStamped(`${batch.id}: no answer (${error.message})`);
        return [];
      }
      writeFileSync(raw, text);
    }
    const rows = readBatch(text, batch, ids);
    logStamped(`${batch.id}: ${rows.length} requests (${text.length} characters)`);
    return rows;
  }));
  const seen = new Set();
  const rows = results.flat().filter((r) => !seen.has(r.prompt.toLowerCase()) && seen.add(r.prompt.toLowerCase()));
  writeFileSync(out, JSON.stringify({ writtenBy: model, at: new Date().toISOString().slice(0, 10), requests: rows }, null, 1) + "\n");
  console.log(JSON.stringify({ requests: rows.length, work: rows.filter((r) => r.expect.length).length, none: rows.filter((r) => !r.expect.length).length }));
}
