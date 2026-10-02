# Acceptance rules — future large harness series (pre-registered 2026-10-01)

Decision rule for the planned 100-repo acceptance series, written BEFORE the
series runs, so we cannot argue about interpretation after the budget is spent.

## Series design
- 100 repos x scenarios (docs, python-api, testing, ...) x arms (repotify, none,
  naive, jev) x reps (>=3). Two-phase protocol: routing -> task.
- Reporting: scenario-level first, pooled only as secondary. No pooling-only
  reporting — scenario-level harm must never be hidden by an aggregate.

## Gate bars (all must pass)
1. **Routing**: mustInclude capture in the repotify arm >= 85% (repotify-arm-only
   metric; the none arm is a structural zero / negative control and is never
   reported as evidence).
2. **Breakage**: 0 contract failures in the repotify arm; 0 driver errors series-wide.
3. **Task quality**: paired (scenario x rep) bootstrap 95% CI for
   repotify-minus-none task score excludes 0 in the positive direction.
   WEAK fallback: if CI includes 0 but point estimate >= +0.05 AND no scenario
   shows repotify worse than none by more than 0.10, the gate holds as
   "weak pass" with the regressing scenario flagged as known debt.
4. **Scenario-level veto**: no scenario may show repotify task score < none task
   score by more than 0.10. Violation blocks the gate regardless of the pool.

## Known debt carried into the series (from the 36-run mini series)
- Task-score CIs included 0 at n=9 (minimal power); the series IS the power fix.
- testing scenario: repotify 0.72 vs none 0.89. Root-cause diagnostic: in all 3
  repotify reps the injected webapp-testing skill was routed (recall 1.00) but
  the rubric checks `networkidle` (3/3 misses) and `screenshot` (2/3) failed,
  while the bare model passed them from priors. Suspected cause: skill-card
  example style vs rubric check mismatch (skill-card informativeness debt).
  Naive arm rep0 with the test-master skill scored 1.000, so injection per se
  does not hurt — the specific card/skill-context fit matters.
- Rubric collinearity (pattern-anywhere checks may reward quoting the skill):
  acceptable v1; hardening lessons 2-4 in test/harness/METHOD.md.
