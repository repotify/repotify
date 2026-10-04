// Consensus classifier observations (Is 7): a second, cheaper classification source that the derivation
// falls back to when the paid decision model has no answer for a skill. The observations come from the
// 2026-10-04 reconciliation protocol (kalibrasyon/uzlasma-2000.json): two to three independent full-text runs,
// per-axis consensus levels. Only a job both runs agreed on ("uzlasilmis", 2/2) may make a skill a candidate:
// on the 49 hand-labeled skills that level measured 95.3% job accuracy, while 2/3 majority measured 80%.
//
// The records live beside the paid model's `jev` observations, under `obs/consensus/`, keyed by the skill's
// content digest plus the question version and the protocol tag. They NEVER mix with `jev` records: the key
// prefix differs, and every record carries source: "consensus".
import { obsKeyer } from "./store.mjs";

// Bump when the question set changes; old observations stop matching.
export const CONSENSUS_QUESTIONS_VERSION = "2026-10-04";
// The protocol that produced the answers; part of the key so a different protocol's answers do not collide.
export const CONSENSUS_SOURCE = "uzlasma-protokolu-v1";

// Key for a skill's consensus observation, from its SKILL.md content digest.
export const consensusKeyer = () => obsKeyer(["consensus"], [CONSENSUS_QUESTIONS_VERSION, CONSENSUS_SOURCE]);

// The 2/2 job agreement maps to jobP 0.95 (measured 95.3% on 49 hand-labeled; conservative rounding).
// coding 2/2 measured 100% (48/48); 0.95 is the conservative cap, matching the report's recommendation.
const P_AGREE = 0.95;

// Map a consensus entry {id, coding:{deger,duzey}, job:{...}, stack:{...}, lifecycle:{...}, productBound:{...}}
// to the answer shape derive.mjs judges. Returns null when the job is not 2/2: a skill whose main job the two
// runs did not agree on is not a candidate.
// productBound uses the v2 verification (Is 6): the systematic over-flagging (50% vs 4.1% hand-labeled) was
// corrected by a blind second reading (98.0% accuracy on 49 hand-labeled, 4.15% true rate). purpose/quality were
// not asked and are null; the judges skip those gates for consensus-sourced answers (see derive.mjs).
export function consensusToAnswers(entry) {
  const job = entry?.job;
  if (!job || job.duzey !== "uzlasilmis" || typeof job.deger !== "string" || !job.deger) return null;
  const codingDeger = entry.coding?.deger;
  const stackArr = entry.stack?.deger;
  const stack = Array.isArray(stackArr) && stackArr.length === 1 && typeof stackArr[0] === "string" ? stackArr[0] : "any";
  return {
    source: "consensus",
    consensusSource: CONSENSUS_SOURCE,
    coding: codingDeger === true ? P_AGREE : codingDeger === false ? 1 - P_AGREE : null,
    job: job.deger,
    jobP: P_AGREE,
    stack,
    stackP: entry.stack?.duzey === "uzlasilmis" ? P_AGREE : 0.83,
    lifecycle: typeof entry.lifecycle?.deger === "string" ? entry.lifecycle.deger : null,
    lifecycleP: entry.lifecycle?.duzey === "uzlasilmis" ? P_AGREE : 0.85,
    purpose: null,
    purposeP: null,
    productBound: entry.productBound?.deger === true ? P_AGREE : entry.productBound?.deger === false ? 1 - P_AGREE : null,
    quality: null,
    qualityConfidence: null,
  };
}

// Validate one consensus entry before import: shape, known option values, and 2/2 job usability.
// validJobs / validStacks are Sets of allowed option ids (from the question set / taxonomy).
export function validateConsensusEntry(entry, { validJobs, validStacks }) {
  const problems = [];
  if (!entry || typeof entry !== "object") return ["not an object"];
  if (typeof entry.id !== "string" || !entry.id) problems.push("missing id");
  for (const axis of ["coding", "job", "lifecycle", "stack", "productBound"]) {
    const a = entry[axis];
    if (!a || typeof a !== "object") { problems.push(axis + ": missing"); continue; }
    if (!["uzlasilmis", "cogunluk", "kararsiz", "tek-kosu-metin-yok"].includes(a.duzey)) problems.push(axis + ": bad duzey " + a.duzey);
  }
  const job = entry.job?.deger;
  if (job != null && validJobs && !validJobs.has(job)) problems.push("job: unknown option " + job);
  const stackArr = entry.stack?.deger;
  if (stackArr != null) {
    if (!Array.isArray(stackArr)) problems.push("stack.deger: not an array");
    else for (const s of stackArr) if (validStacks && !validStacks.has(s)) problems.push("stack: unknown option " + s);
  }
  if (entry.coding?.deger != null && typeof entry.coding.deger !== "boolean") problems.push("coding.deger: not a boolean");
  if (entry.productBound?.deger != null && typeof entry.productBound.deger !== "boolean") problems.push("productBound.deger: not a boolean");
  if (entry.onay != null) for (const pr of validateApproval(entry.onay)) problems.push("onay: " + pr);
  return problems;
}
// Reading-gate approval (Is 7 direction change): a consensus-sourced skill enters the catalog only with
// an approval from TWO independent readers who both fully read the SKILL.md (and helper file list).
// karar "onayli" requires both readers TUT; a single CIKAR or SUPHE means "red".
export function validateApproval(onay) {
  const problems = [];
  if (!onay || typeof onay !== "object") return ["not an object"];
  if (onay.karar !== "onayli" && onay.karar !== "red") problems.push("bad karar " + onay.karar);
  const ok = onay.okuyucular;
  if (!Array.isArray(ok) || ok.length !== 2 || !ok.every((x) => typeof x === "string" && x)) problems.push("okuyucular: need exactly 2 reader ids");
  if (typeof onay.tarih !== "string" || !onay.tarih) problems.push("missing tarih");
  if (typeof onay.gerekce !== "string" || !onay.gerekce) problems.push("missing gerekce");
  return problems;
}

// True when the entry/observation carries a valid "onayli" approval.
export function isApproved(entry) {
  const o = entry?.onay;
  return !!o && o.karar === "onayli" && validateApproval(o).length === 0;
}
