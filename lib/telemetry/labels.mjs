// Hold-and-join label pipe (FAZ 1 §1.2) — v1 skeleton.
//
// Slow signals (kept_30d, removed_fast/removed/replaced) arrive days or weeks
// after the recommendation. The joiner HOLDS each (episode_id, skill_id) pair
// open and JOINS late signals onto it when a window closes; intermediate
// signals are never training labels by themselves.
//
// D4: labels carry raw counts/booleans/enums only — the reward formula is
// computed downstream (FAZ 6), never here.
//
// v1 windows (per design.md §2.3): fast removal is judged at 7 days,
// survival at 30 days. Each window finalizes independently into one label row.

import { randomUUID } from "node:crypto";
import { validateEvent } from "./schema.mjs";

// P4: observability class per (episode_id, skill_id) hold, from the
// install/select event's install_source. Determines invoke_observed at close.
export const OBSERVABILITY = {
  FULL: "full",         // repotify-installed + wrapped → invoke fully observed
  REDACTED: "redacted", // third-party catalog (platform redacts names) → invoke blind
  WEAK: "weak",         // user-installed outside repotify → weak signals only
  UNKNOWN: "unknown",   // install_source absent (legacy) → observability unknown
};

function observabilityFor(installSource) {
  switch (installSource) {
    case "repotify": return OBSERVABILITY.FULL;
    case "third-party": return OBSERVABILITY.REDACTED;
    case "external": return OBSERVABILITY.WEAK;
    default: return OBSERVABILITY.UNKNOWN;
  }
}

const DAY_MS = 24 * 3600 * 1000;

// Window name -> how long after install the window closes.
export const WINDOWS = {
  week1: 7 * DAY_MS,
  month1: 30 * DAY_MS,
};

function zeroSignals() {
  return {
    invoked_count: 0,
    invoked_sessions: 0,
    invoked_explicit: 0,
    invoked_implicit: 0,
    invoked_load: 0,
    // P4: null = observability unknown (legacy / install_source absent).
    // true = invoke channel fully observed (repotify-installed + wrapped);
    // false = channel blind (third-party redacted / external) → invoked_unique
    // is MASKED (unknown), never 0. Set at window close from the hold's
    // observability class; never reward math (D4).
    invoke_observed: null,
    outcome_count: 0,
    outcome_success: null,      // last observed raw outcome; null = never observed
    outcome_shared: false,      // true when the outcome had no skill_id (one outcome, N holds)
    outcome_quality: null,      // last observed raw quality rating; null = none
    outcome_skill_free_baseline: null,
    abandoned_count: 0,
    fallback_count: 0,
    questions_asked: 0,
    questions_answered: 0,
    kept_30d: false,
    removed_fast: false,
    removed: false,
    removal_reason: null,
    replaced_by: null,
    tokens_in_sum: 0,
    tokens_out_sum: 0,
    latency_ms_sum: 0,
    latency_ms_count: 0,
  };
}

export class LabelJoiner {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.holds = new Map(); // `${episode_id}::${skill_id}` -> hold
    this.orphans = [];      // reward-ish events with no open hold (kept for debugging)
  }

  /** Ingest one raw event. Throws on schema violations (loud > silent). */
  ingest(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`LabelJoiner: invalid event: ${errors.join("; ")}`);
    if (!event.episode_id) { this.orphans.push(event); return false; }
    const key = event.skill_id ? `${event.episode_id}::${event.skill_id}` : null;

    switch (event.type) {
      case "recommendation":
        // Episodes are registered implicitly when their install/select opens a hold.
        return true;
      case "install":
      case "select": {
        if (!key) { this.orphans.push(event); return false; }
        if (!this.holds.has(key)) {
          this.holds.set(key, {
            episode_id: event.episode_id,
            skill_id: event.skill_id,
            opened_at: event.ts,
            finalized: new Set(),
            sessions: new Set(),
            signals: zeroSignals(),
            // P4: observability class pinned at hold open; later install/select
            // events for the same pair never downgrade it (first wins).
            observability: observabilityFor(event.install_source),
          });
        }
        return true;
      }
      default:
        break;
    }

    const hold = key ? this.holds.get(key) : null;
    // Episode-level signals (no skill_id — e.g. skill-free baseline outcomes,
    // abandon/fallback before any install) attach to every open hold of the
    // episode. Per-skill credit assignment is downstream's job (FAZ 6), the
    // join only needs the raw signal reachable from each label. Such shared
    // attachments are marked (outcome_shared) so consumers cannot mistake one
    // shared outcome for N independent ones.
    const targets = hold ? [hold] : [...this.holds.values()].filter((h) => h.episode_id === event.episode_id);
    if (!targets.length) { this.orphans.push(event); return false; }
    const shared = !hold && targets.length > 0;
    for (const target of targets) {
      // Clock-skew guard: an event timestamped before the hold opened means
      // the wall clock moved (or the emitter mis-stamped). Attaching it would
      // silently corrupt window math — orphan it instead, loudly countable.
      if (event.ts < target.opened_at) { this.orphans.push({ ...event, _orphan_reason: "clock_skew" }); continue; }
      this.applyToHold(target, event, { shared });
    }
    return true;
  }

  applyToHold(hold, event, { shared = false } = {}) {
    const s = hold.signals;
    switch (event.type) {
      case "invoke":
        s.invoked_count += 1;
        if (event.session_id && !hold.sessions.has(event.session_id)) {
          hold.sessions.add(event.session_id);
          s.invoked_sessions += 1;
        }
        if (event.invocation_kind === "explicit") s.invoked_explicit += 1;
        else if (event.invocation_kind === "implicit") s.invoked_implicit += 1;
        else if (event.invocation_kind === "load") s.invoked_load += 1;
        break;
      case "outcome":
        s.outcome_count += 1;
        s.outcome_success = event.task_success;
        if (shared) s.outcome_shared = true;
        if (event.quality !== undefined) s.outcome_quality = event.quality;
        if (event.skill_free_baseline !== undefined) s.outcome_skill_free_baseline = event.skill_free_baseline;
        break;
      case "abandon":
        s.abandoned_count += 1;
        break;
      case "fallback":
        s.fallback_count += 1;
        break;
      case "question":
        s.questions_asked += 1;
        if (!event.skipped) s.questions_answered += 1;
        break;
      case "usage":
        if (event.tokens_in) s.tokens_in_sum += event.tokens_in;
        if (event.tokens_out) s.tokens_out_sum += event.tokens_out;
        if (event.latency_ms) { s.latency_ms_sum += event.latency_ms; s.latency_ms_count += 1; }
        break;
      case "kept_30d":
        s.kept_30d = true;
        break;
      case "removed_fast":
        s.removed_fast = true;
        s.removed = true;
        s.removal_reason = event.removal_reason;
        break;
      case "removed":
        s.removed = true;
        s.removal_reason = event.removal_reason;
        break;
      case "replaced":
        s.removed = true;
        s.replaced_by = event.replaced_by;
        break;
      default:
        break;
    }
    return true;
  }

  /**
   * Finalize every window whose deadline has passed. Returns the newly
   * closed label rows (raw joined signals — no reward math).
   */
  closeWindows(at = this.now()) {
    const atMs = new Date(at).getTime();
    const closed = [];
    for (const [key, hold] of this.holds) {
      const openedMs = Date.parse(hold.opened_at);
      for (const [window, span] of Object.entries(WINDOWS)) {
        if (hold.finalized.has(window)) continue;
        if (Number.isNaN(openedMs) || atMs < openedMs + span) continue;
        hold.finalized.add(window);
        // P4: pin the observation-channel verdict onto the label row.
        // full → true (absence of invokes means truly never invoked);
        // redacted/weak → false (invoked_unique is masked downstream, never 0);
        // unknown → null (legacy: pre-instrumentation rows keep legacy semantics).
        const signals = { ...hold.signals };
        signals.invoke_observed =
          hold.observability === OBSERVABILITY.FULL ? true
          : hold.observability === OBSERVABILITY.UNKNOWN ? null
          : false;
        closed.push({
          label_id: randomUUID(),
          schema: "label/v1",
          window,
          window_closed_at: new Date(atMs).toISOString(),
          episode_id: hold.episode_id,
          skill_id: hold.skill_id,
          observability: hold.observability,
          installed_at: hold.opened_at,
          signals,
        });
      }
      if (hold.finalized.size === Object.keys(WINDOWS).length) this.holds.delete(key);
    }
    return closed;
  }

  openHolds() { return this.holds.size; }
  orphanCount() { return this.orphans.length; }
}
