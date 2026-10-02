// R3 staged retesting (FAZ 2.4).
// Cheap layer (security + heuristics): re-runs on every content change.
// Expensive layer (eval + jury): re-runs only on a *significant* change or
// when its 30-day TTL expires. Every score carries scored_at + expires_at;
// a stale score must not enter presentation.
export const CHEAP_LAYER_VERSION = "1";
export const EXPENSIVE_LAYER_VERSION = "1";
// Bumped to "2": the proxy path no longer double-counts docQuality (it was an
// effective 0.45 weight). The cache key carries this, so old scores invalidate.
export const TEST_SCORE_VERSION = "2";
export const CHEAP_TTL_MS = 30 * 86400000;
export const EXPENSIVE_TTL_MS = 30 * 86400000;
// A content edit counts as significant when it is large enough to plausibly
// move the jury verdict, or when the security level itself changed.
export const SIGNIFICANT_LENGTH_RATIO = 0.1;

const DAY = 86400000;
export const iso = (ms) => new Date(ms).toISOString();
export const expiresAt = (scoredAtMs, ttlMs) => iso(scoredAtMs + ttlMs);
export const isExpired = (expiresAtIso, nowMs) => new Date(expiresAtIso).getTime() <= nowMs;

const SEC_RANK = { verified: 0, caution: 1, quarantined: 2, rejected: 3 };

export function significantChange(prev, next) {
  if (!prev) return true;
  const a = String(prev.text ?? "");
  const b = String(next.text ?? "");
  if (a === b) return (SEC_RANK[prev.securityLevel] ?? 0) !== (SEC_RANK[next.securityLevel] ?? 0);
  const ratio = Math.abs(a.length - b.length) / Math.max(a.length, b.length, 1);
  if (ratio > SIGNIFICANT_LENGTH_RATIO) return true;
  return (SEC_RANK[prev.securityLevel] ?? 0) !== (SEC_RANK[next.securityLevel] ?? 0);
}

// Cumulative drift since the last jury run. Per-edit deltas let an item be
// degraded 9% at a time while the jury score stays frozen ("salami slicing");
// measuring against the jury-time snapshot closes that hole.
export function cumulativeDrift(jurySnapshot, { text, securityLevel }) {
  if (!jurySnapshot || jurySnapshot.textLength == null) return true; // unknown: re-jury once, safely
  const a = String(text ?? "");
  const ratio = Math.abs(a.length - jurySnapshot.textLength) / Math.max(a.length, jurySnapshot.textLength, 1);
  if (ratio > SIGNIFICANT_LENGTH_RATIO) return true;
  return (SEC_RANK[jurySnapshot.securityLevel] ?? -1) !== (SEC_RANK[securityLevel] ?? -1);
}

// Cheap layer: due on every content change (or when missing/expired).
export function cheapDue(cached, contentHash, nowMs) {
  if (!cached) return { due: true, reason: "no cached record" };
  if (!cached.cheap || isExpired(cached.cheap.expiresAt, nowMs)) return { due: true, reason: "cheap layer missing or expired" };
  if (cached.contentHash !== contentHash) return { due: true, reason: "content changed" };
  return { due: false, reason: "" };
}

// Expensive layer: due only when wanted (eligible or promoted) and the last
// jury verdict is missing, expired, or the content has cumulatively drifted
// past significance since that verdict.
export function expensiveDue(cached, { text, securityLevel, juryWanted, nowMs }) {
  if (!cached) return { due: Boolean(juryWanted), reason: juryWanted ? "no cached record" : "" };
  if (!juryWanted) return { due: false, reason: "" };
  const exp = cached.expensive;
  if (!exp || !exp.ran) return { due: true, reason: "expensive layer never ran" };
  if (isExpired(exp.expiresAt, nowMs)) return { due: true, reason: "expensive layer older than 30 days" };
  if (cumulativeDrift(exp, { text, securityLevel })) return { due: true, reason: "cumulative drift since last jury run" };
  return { due: false, reason: "" };
}

// Which layers need to run for this item right now?
export function planLayers({ cached, contentHash, text, securityLevel, juryWanted, nowMs }) {
  const c = cheapDue(cached, contentHash, nowMs);
  const e = expensiveDue(cached, { text, securityLevel, juryWanted, nowMs });
  return { cheap: c.due, expensive: e.due, reason: [c.reason, e.reason].filter(Boolean) };
}

// Stale scores must not enter presentation (the next phase reads this).
export function isPresentable(record, nowMs = Date.now()) {
  if (!record || typeof record !== "object") return { ok: false, reason: "no record" };
  const level = record.security?.level;
  if (level !== "verified" && level !== "caution") return { ok: false, reason: `security level ${level ?? "unknown"}` };
  if (!record.cheap || isExpired(record.cheap.expiresAt, nowMs)) return { ok: false, reason: "cheap layer stale" };
  if (record.expensive?.ran && isExpired(record.expensive.expiresAt, nowMs)) return { ok: false, reason: "expensive layer stale" };
  return { ok: true, reason: "fresh" };
}

export { DAY };
