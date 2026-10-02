// v1 test runner (FAZ 2): the standard test package for one catalog item.
// Cheap layer (security gate + heuristics) runs on every content change;
// expensive layer (draft jury) runs only on seed/critical items, on a
// significant change or every 30 days. Scores are cached by content hash,
// carry scored_at + expires_at per layer, and stale scores are flagged by
// isPresentable() in ./retest.mjs so the presentation phase can refuse them.
//
// The security gate is the existing scanner, unchanged: verified / caution /
// quarantined / rejected. This runner never raises trust (a jury can only add
// suspicion, never clear a finding — see pipeline/jury.mjs applySuspicion).
import { scanFiles, levelFromFindings } from "../../../src/scan/index.mjs";
import { applySuspicion } from "../../../pipeline/jury.mjs";
import { runHeuristics, HEURISTICS_VERSION } from "./heuristics.mjs";
import { canonicalContent, contentHashFor, cacheKey, cacheRead, cacheWrite } from "./cache.mjs";
import {
  CHEAP_LAYER_VERSION, EXPENSIVE_LAYER_VERSION, TEST_SCORE_VERSION,
  CHEAP_TTL_MS, EXPENSIVE_TTL_MS, iso, expiresAt, cheapDue, expensiveDue,
} from "./retest.mjs";
import { JURY_RULES_V1, juryEligible, runJuryDraft, JURY_PROMPT_VERSION } from "./jury-draft.mjs";

const round3 = (n) => Math.round(n * 1000) / 1000;

// item: { id, text?, files?[{path,content}], signals?, description?, editorial?, critical?, security? }
// A precomputed item.security (from the pipeline gate) is kept as-is.
export function scanSecurity({ text, files, security }) {
  if (security && typeof security === "object" && security.level) return security;
  const docs = files?.length
    ? files.map((f) => ({ path: f.path, content: f.content }))
    : [{ path: "SKILL.md", content: text ?? "" }];
  const { findings } = scanFiles(docs);
  return { level: levelFromFindings(findings), findings, scannedAt: new Date().toISOString() };
}

export function composeScore({ jury, heuristics }) {
  const { freshness, maintenance, docQuality } = heuristics;
  if (jury) {
    const score = 0.5 * jury.quality + 0.2 * freshness.score + 0.15 * maintenance.score + 0.15 * docQuality.score;
    return { score: round3(score), quality: round3(jury.quality), qualitySource: "jury", scorePath: "jury" };
  }
  // Proxy path: the proxy *replaces* jury quality, so its inputs must not be
  // counted again as standalone terms. (The v1 formula added 0.15*docQuality
  // on top of a proxy built from docQuality, giving doc formatting an
  // effective 0.45 weight — pure README polish outscoring substance.)
  const proxy = 0.6 * docQuality.score + 0.4 * maintenance.score;
  const score = 0.5 * proxy + 0.2 * freshness.score + 0.3 * maintenance.score;
  return { score: round3(score), quality: round3(proxy), qualitySource: "proxy", scorePath: "proxy" };
}

export function versionsFor(taxonomy, { eligible = false } = {}) {
  return {
    cheap: CHEAP_LAYER_VERSION,
    expensive: EXPENSIVE_LAYER_VERSION,
    score: TEST_SCORE_VERSION,
    juryPrompt: JURY_PROMPT_VERSION,
    taxonomy: taxonomy?.version ?? "0",
    // The expensive layer legitimately differs by eligibility: a seed item
    // and a discovered item with identical content must not share a record.
    eligible: eligible ? "1" : "0",
  };
}

// A discovered item whose cheap proxy reaches this score earns a one-time
// jury run (the promotion path). It keeps strong discovered items from being
// stuck forever in the proxy tier — the two-class trap — while the jury
// stays off the default path for everything else. At most one jury run per
// content version: once the expensive layer has run, it never re-promotes.
export const PROMOTE_THRESHOLD = 0.8;

export async function runTestSuite(item, opts = {}) {
  const {
    cache = {}, taxonomy = null, chat = null, jurors = [], jurySeeds = [7, 42],
    now = new Date(), log = () => {}, classify = null, context = null,
    promote = true,
  } = opts;
  const nowMs = now.getTime();
  const text = item.text ?? canonicalContent({ files: item.files });
  const hash = contentHashFor({ text, files: item.files });
  const eligible = juryEligible(item);
  const key = cacheKey(hash, versionsFor(taxonomy, { eligible }));
  const cached = cacheRead(cache, key);

  // Cheap layer first: the promotion decision needs the proxy score.
  let cheap = cached?.cheap ?? null;
  let security = cached?.security ?? null;
  let heuristics = cached?.heuristics ?? null;
  const cd = cheapDue(cached, hash, nowMs);
  if (cd.due) {
    security = scanSecurity({ text, files: item.files, security: item.security });
    heuristics = runHeuristics({ text, description: item.description ?? item.summary ?? "", signals: item.signals ?? {} });
    const scoredAt = iso(nowMs);
    cheap = { security: { level: security.level, findings: security.findings }, heuristics, scoredAt, expiresAt: expiresAt(nowMs, CHEAP_TTL_MS), layerVersion: CHEAP_LAYER_VERSION, heuristicsVersion: HEURISTICS_VERSION };
    log(`test-runner: cheap layer for ${item.id} (${security.level})`);
  }

  // Jury promotion (never for blocked items: no tokens spent on them).
  const juryReady = Boolean(chat && jurors.length && taxonomy);
  const secOk = security.level === "verified" || security.level === "caution";
  const proxyScore = composeScore({ jury: null, heuristics }).score;
  const promoted = !eligible && promote && juryReady && !(cached?.expensive?.ran) && secOk && proxyScore >= PROMOTE_THRESHOLD;
  const juryWanted = (eligible || promoted) && juryReady;
  if (promoted) log(`test-runner: ${item.id} promoted to jury (proxy score ${proxyScore} >= ${PROMOTE_THRESHOLD})`);

  // Same content -> same score: a fresh cached record with nothing due is returned untouched.
  const ed = expensiveDue(cached, { text, securityLevel: security.level, juryWanted, nowMs });
  if (!cd.due && !ed.due && cached) {
    return { ...cached, fromCache: true };
  }

  // Expensive layer: draft jury, only when the cost gate (or promotion) allows it.
  let expensive = cached?.expensive ?? { ran: false };
  let jury = expensive.ran ? expensive.jury : null;
  if (ed.due) {
    const verdict = await runJuryDraft(item, text, { chat, jurors, taxonomy, seeds: jurySeeds, log });
    if (verdict) {
      // The jury can only add suspicion, never raise trust.
      const withSuspicion = applySuspicion({ level: security.level, findings: security.findings ?? [] }, verdict);
      if (withSuspicion.level !== security.level) {
        security = { ...security, level: withSuspicion.level, findings: withSuspicion.findings };
        cheap = { ...cheap, security: { level: security.level, findings: security.findings } };
      }
      jury = {
        quality: verdict.quality, specificity: verdict.specificity, maintenance: verdict.maintenance,
        agreement: verdict.agreement, models: verdict.models, jurorFamilies: verdict.jurorFamilies,
        capabilities: verdict.capabilities, needs: verdict.needs, stacks: verdict.stacks,
        suspicious: verdict.suspicious, rules: verdict.rules, rulesVersion: verdict.rulesVersion,
        seedSpread: verdict.seedSpread, unstable: verdict.unstable,
      };
    } else {
      log(`test-runner: jury produced no verdict for ${item.id}; expensive layer skipped`);
    }
    const scoredAt = iso(nowMs);
    // The jury-time snapshot anchors cumulative drift detection (R3).
    expensive = { ran: Boolean(jury), jury, scoredAt, expiresAt: expiresAt(nowMs, EXPENSIVE_TTL_MS), layerVersion: EXPENSIVE_LAYER_VERSION, rulesVersion: JURY_RULES_V1.version, textLength: text.length, contentHash: hash, securityLevel: security.level };
  }

  const { score, quality, qualitySource, scorePath } = composeScore({ jury, heuristics });
  const scoredAt = iso(nowMs);
  const overallExpires = [cheap.expiresAt, expensive.ran ? expensive.expiresAt : null].filter(Boolean).sort()[0];

  // Coarse capability labels from the test output (+ seed context when given).
  let labels = cached?.labels ?? [];
  let labelConfidence = cached?.labelConfidence ?? "low";
  if (classify && (cd.due || ed.due || !cached)) {
    const cls = classify({ testResult: { id: item.id, text, jury, heuristics, security: { level: security.level } }, context, taxonomy });
    labels = cls.labels;
    labelConfidence = cls.confidence;
  }

  const record = {
    itemId: item.id,
    contentHash: hash,
    text,
    securityLevel: security.level,
    security: { level: security.level, findings: security.findings ?? [] },
    cheap,
    expensive,
    heuristics,
    jury,
    juryPromoted: promoted || cached?.juryPromoted || false,
    proxyScore,
    score,
    quality,
    qualitySource,
    scorePath,
    scoreVersion: TEST_SCORE_VERSION,
    labels,
    labelConfidence,
    scoredAt,
    expiresAt: overallExpires,
    presentableSecurity: security.level === "verified" || security.level === "caution",
    plan: [cd.reason, ed.reason, promoted ? "promoted to jury" : ""].filter(Boolean),
    fromCache: false,
  };
  cacheWrite(cache, key, record);
  return record;
}
