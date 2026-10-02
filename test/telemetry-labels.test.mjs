// Hold-and-join label pipe tests (FAZ 1 §1.2): slow signals join the label
// when the window closes; intermediate signals are never labels by themselves.
// D4: labels carry raw counts/booleans/enums — no reward math.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LabelJoiner, WINDOWS } from "../lib/telemetry/index.mjs";

const IID = "123e4567-e89b-42d3-a456-426614174000";
const EID = "223e4567-e89b-42d3-a456-426614174000";
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const DAY = 24 * 3600 * 1000;

const mk = (type, ts, extra = {}) => ({
  type, ts: new Date(ts).toISOString(), schema_version: 1, install_id: IID, ...extra,
});

function rig() {
  let now = T0;
  const j = new LabelJoiner({ now: () => new Date(now) });
  return { j, setNow: (t) => { now = t; }, at: (days) => T0 + days * DAY };
}

const rec = (ts) => mk("recommendation", ts, {
  episode_id: EID,
  candidates: [
    { skill_id: "pdf", position: 0, propensity: 0.8, shown: true, is_explore: false },
    { skill_id: "graphify", position: 1, propensity: 0.19, shown: false, is_explore: true },
  ],
});

test("happy path: recommendation → install → invoke → outcome → kept_30d joins one label", () => {
  const { j, setNow, at } = rig();
  j.ingest(rec(at(0)));
  j.ingest(mk("install", at(0), { episode_id: EID, skill_id: "pdf", from_recommendation: true }));
  j.ingest(mk("invoke", at(1), { episode_id: EID, skill_id: "pdf", invocation_kind: "explicit", session_id: "s1" }));
  j.ingest(mk("invoke", at(2), { episode_id: EID, skill_id: "pdf", invocation_kind: "load", session_id: "s2" }));
  j.ingest(mk("invoke", at(2), { episode_id: EID, skill_id: "pdf", invocation_kind: "load", session_id: "s2" }));
  j.ingest(mk("outcome", at(2), { episode_id: EID, skill_ids: ["pdf"], task_success: true, quality: 4 }));
  j.ingest(mk("question", at(1), { episode_id: EID, skill_id: "pdf", question_id: "q1", answer: "yes", skipped: false }));
  j.ingest(mk("usage", at(2), { episode_id: EID, skill_id: "pdf", tokens_in: 1000, tokens_out: 200, latency_ms: 300 }));

  assert.deepEqual(j.closeWindows(new Date(at(3))), [], "no window closes early");
  assert.equal(j.openHolds(), 1, "the pair is HELD open");

  setNow(at(8));
  const [week] = j.closeWindows();
  assert.equal(week.window, "week1");
  assert.equal(week.episode_id, EID);
  assert.equal(week.skill_id, "pdf");
  const s = week.signals;
  assert.equal(s.invoked_count, 3);
  assert.equal(s.invoked_sessions, 2, "unique sessions, not raw retries");
  assert.equal(s.invoked_explicit, 1);
  assert.equal(s.invoked_load, 2);
  assert.equal(s.outcome_success, true);
  assert.equal(s.outcome_quality, 4);
  assert.equal(s.questions_asked, 1);
  assert.equal(s.questions_answered, 1);
  assert.equal(s.tokens_in_sum, 1000);
  assert.equal(s.kept_30d, false, "slow signal not yet observed");
  assert.ok(!("reward" in week) && !("score" in week), "D4: no computed fields on labels");
  assert.ok(!("reward" in s), "D4: no computed fields in signals");

  j.ingest(mk("kept_30d", at(31), { episode_id: EID, skill_id: "pdf" }));
  setNow(at(32));
  const [month] = j.closeWindows();
  assert.equal(month.window, "month1");
  assert.equal(month.signals.kept_30d, true, "the slow signal joined at window close");
  assert.equal(month.signals.invoked_count, 3, "fast signals still attached");
  assert.equal(j.openHolds(), 0, "fully finalized holds are released");
});

test("fast removal: removed_fast at day 3, kept_30d stays false", () => {
  const { j, at } = rig();
  j.ingest(mk("install", at(0), { episode_id: EID, skill_id: "graphify" }));
  j.ingest(mk("removed_fast", at(3), { episode_id: EID, skill_id: "graphify", removal_reason: "unused" }));
  const [week] = j.closeWindows(new Date(at(8)));
  assert.equal(week.signals.removed_fast, true);
  assert.equal(week.signals.removed, true);
  assert.equal(week.signals.removal_reason, "unused");
  const [month] = j.closeWindows(new Date(at(31)));
  assert.equal(month.signals.kept_30d, false);
  assert.equal(month.signals.removed, true);
});

test("replaced carries the pairwise preference (highest-information negative)", () => {
  const { j, at } = rig();
  j.ingest(mk("install", at(0), { episode_id: EID, skill_id: "pdf" }));
  j.ingest(mk("replaced", at(10), { episode_id: EID, skill_id: "pdf", replaced_by: "graphify" }));
  const [week] = j.closeWindows(new Date(at(8)));
  assert.equal(week.signals.replaced_by, "graphify");
  assert.equal(week.signals.removed, true);
});

test("skill-free baseline outcomes are marked for the counterfactual baseline", () => {
  const { j, at } = rig();
  j.ingest(mk("install", at(0), { episode_id: EID, skill_id: "pdf" }));
  j.ingest(mk("outcome", at(1), { episode_id: EID, task_success: true, skill_free_baseline: true }));
  const [week] = j.closeWindows(new Date(at(8)));
  assert.equal(week.signals.outcome_skill_free_baseline, true);
  assert.equal(week.signals.invoked_count, 0, "installed-but-not-invoked earns no invoke credit");
});

test("shared outcomes are marked so one outcome is not mistaken for N (credit-bloat guard)", () => {
  const { j, at } = rig();
  j.ingest(mk("install", at(0), { episode_id: EID, skill_id: "pdf" }));
  j.ingest(mk("install", at(0), { episode_id: EID, skill_id: "graphify" }));
  // Episode-level outcome: no skill_id -> attaches to both holds, marked shared.
  j.ingest(mk("outcome", at(1), { episode_id: EID, task_success: true }));
  const closed = j.closeWindows(new Date(at(8)));
  assert.equal(closed.length, 2);
  for (const l of closed) {
    assert.equal(l.signals.outcome_success, true);
    assert.equal(l.signals.outcome_shared, true, "shared outcome flagged on every label");
  }
  // Skill-scoped outcome: not shared.
  const E3 = "423e4567-e89b-42d3-a456-426614174000";
  j.ingest(mk("install", at(9), { episode_id: E3, skill_id: "pdf" }));
  j.ingest(mk("outcome", at(10), { episode_id: E3, skill_id: "pdf", task_success: false }));
  const [l3] = j.closeWindows(new Date(at(17)));
  assert.equal(l3.signals.outcome_shared, false);
  assert.equal(l3.signals.outcome_success, false);
});

test("clock-skew guard: events timestamped before the hold opened become orphans", () => {
  const { j, at } = rig();
  j.ingest(mk("install", at(5), { episode_id: EID, skill_id: "pdf" }));
  // Stale/mis-stamped invoke: ts < opened_at.
  assert.equal(
    j.ingest(mk("invoke", at(1), { episode_id: EID, skill_id: "pdf", invocation_kind: "load" })),
    true
  );
  const [week] = j.closeWindows(new Date(at(13)));
  assert.equal(week.signals.invoked_count, 0, "skewed event not attached");
  assert.equal(j.orphanCount(), 1);
});

test("windows close independently per hold", () => {
  const { j, at } = rig();
  const E2 = "323e4567-e89b-42d3-a456-426614174000";
  j.ingest(mk("install", at(0), { episode_id: EID, skill_id: "pdf" }));
  j.ingest(mk("install", at(20), { episode_id: E2, skill_id: "pdf" }));
  const closed = j.closeWindows(new Date(at(25)));
  assert.equal(closed.length, 1, "only the older hold's week1 window closed");
  assert.equal(closed[0].episode_id, EID);
  assert.equal(j.openHolds(), 2, "both holds still alive (month1 pending)");
});

test("joiner is loud on bad input and tolerant of episode-less events", () => {
  const { j, at } = rig();
  assert.throws(() => j.ingest({ type: "install" }), /invalid event/);
  // A hook-observed invoke without an episode id cannot join: orphaned, not crashed.
  assert.equal(j.ingest(mk("invoke", at(1), { skill_id: "pdf", invocation_kind: "load", session_id: "s9" })), false);
  assert.equal(j.orphanCount(), 1);
  assert.equal(j.openHolds(), 0);
});
