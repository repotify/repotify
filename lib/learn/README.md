# lib/learn — FAZ 6 learning loop

The closed loop: recommend → measure → learn. Pure JS, zero dependencies,
Node 18+. All policy state lives on the user's machine (DL-014: local-first);
the server only ever computes aggregate fleet policy from delayed snapshots.

## Modules

| File | Decides | Locked by |
|---|---|---|
| `linucb.mjs` | Disjoint per-arm LinUCB, d=64, A/b sufficient statistics, UCB scoring, JSON snapshots | DL-014 (d=64) |
| `explore.mjs` | B1 feature perturbation (x̃ = x + σN(0,I), σ=0.05) with MC propensities in (0,1); DL-049 blind-quota guard (≤5%, never exceeded) | DL-007, DL-049 |
| `reward.mjs` | DL-001 canonical composite (versioned `r1`), two-tier one-shot label vs online proxy features, rank normalization (canonical). P4: `invoke_observed` masking + call-gated outcome credit; weights locked, the label pipe changed | DL-001/002/043/044 |
| `warmstart.mjs` | B2: new arms seed A=Σxxᵀ+λI, b=Σrx from historical labels (never A=λI,b=0 cold) | DL-019 |
| `calibrate.mjs` | B3: fast-proxy calibration against kept_30d; weight multipliers ∈ [0.25,2.0]; source tagged simulated/real | DL-020 |
| `ope.mjs` | FAZ 11: offline policy evaluation (IPS/SNIPS/DR) over Stage 0 logs; refuses on degenerate propensity / ESS<minESS | Q-A |
| `decay.mjs` | P4: monthly forgetting schedule over `LinUCBArm.decay(gamma)` (gamma∈[0.9,0.99)) — stale delayed labels stop locking the posterior | P4 |
| `policy-gate.mjs` | P4: OPE as set-level safety gate — arm-level changes ship only as pass/flagged/veto; OPE never learns | P4 |
| `tripwires.mjs` | P4: T1 (invoke_observed coverage <80%), T2 (winner's curse), T3 (90-day OPE refusal streak) — alarms only, no auto-rollback | P4 |

## The two tiers (DL-044) — read this before touching anything

1. **Bandit tier (slow, gradient):** exactly ONE gradient update per
   `(episode_id, skill_id)`, emitted when the slowest applicable window closes
   (DL-005). Implemented by `oneShotLabel()` + `LinUCB.observe()`. The update
   trains on the rank-normalized (DL-043) DL-001 composite.
2. **Proxy tier (fast, no gradient):** fast signals (`proxyFeatures()`) update
   serving scores and B3 calibration continuously. They affect WHAT IS SERVED
   but never emit a second gradient on the same decision.

Consequence: the bandit flies partially blind between label closes (by
design — labels are delayed). Do not "fix" this by emitting partial labels;
that would violate DL-005.

## Exploration (DL-007)

- Primary: feature perturbation. A deterministic argmax has propensity exactly
  1, which kills IPS/offline replay — perturbation reintroduces loggable
  randomness (0 < p < 1, asserted) while staying directed by the model's own
  uncertainty. ε-greedy does NOT exist here; ε survives only as the cold-start
  quota.
- Control: a small blind-quota arm (≤5%, `QuotaGuard`) is the model-free
  experiment group for FAZ 9 claims — not the exploration mechanism.

## What the sim proved (test/learn-sim.test.mjs, DL-022)

200-round synthetic user flow, 3 arms (linucb / FAZ-5 baseline / quota
control), train/eval rewards separated, delayed labels in virtual time:
regret(linucb) ≤ 0.8 × regret(baseline) on 5 world seeds (worst 0.762), warm
early-regret < cold early-regret (DL-019), ≤1 gradient per episode (DL-044).

## Known limits (honest)

- α=0.5 was chosen by a sim sweep for rank-normalized [0,1] rewards; re-tune
  against real label statistics when they exist.
- The online proxy tier is not yet wired into serving (unit-tested only).
- Warm-start history in the sim comes from the same distribution — negative
  transfer is untested.
- Synthetic Bernoulli events ≠ real user behavior (gaming, correlation,
  non-stationarity).
- **Data regime:** the 200-round sim validates learning dynamics, not the
  calendar data rate. At single-digit monthly volumes per user, production
  accumulates 200 labels over months; until then the system is warm-start
  prior + light personalization (see harness header).
- **Residual gaming margin:** invoked_once_then_removed nets +0.35 − 0.30 =
  +0.05 (weights locked by DL-001/DL-002). Fleet-level FAZ 9 monitoring of
  per-skill try-then-remove rates is the mitigation, not local re-weighting.
- **Non-stationarity:** `LinUCBArm.decay(gamma)` provides exponential
  forgetting (default gamma=1: never forget, preserving locked behavior).
  Call periodically when user taste or the catalog drifts.
- **Red Queen:** as the policy improves the label cohort improves with it.
  Track RAW kept_30d rate per arm alongside rank-normalized training labels;
  a falling raw rate while ranks look healthy is the alarm.
