# Harness measurement method (mini-series) — D5

**Scope:** in-house counterfactual measurement for the Repotify v2 recommender (PLAN.md FAZ 7).
No real users are involved: a model API plays the agent, the same scenario is run under
different arms, and the delta is the measurement. All product text is English.

## 1. Scenario selection

- 5 pilot scenarios in `test/harness/scenarios/`: `js-frontend`, `python-api`, `cli-tool`,
  `testing`, `docs` — one per project type, each a short task (code or docs, one small
  deliverable) with a ground-truth `mustInclude` set (verified catalog ids) and a
  `mustNotInclude` set (over-routing guard).
- Each scenario carries the project fingerprint the pipeline sees, so arm A runs the real
  `recommend()` path (`src/recommend.mjs` + `src/needs.mjs`, read-only).
- Scenario bar for admission: deterministic rubric with ≥ 3 checks; every ground-truth id
  exists in the catalog; task solvable in ≤ 500 output tokens.
- **Ground-truth reachability (FAZ 7-MINI, 2026-10-01):** every `mustInclude` id must appear
  in the pipeline's `defaultSet` for the scenario fingerprint (verify with `--dry-run`).
  If a must-include skill is not even offered to the agent, routing recall is trivially 0
  and the scenario measures a pipeline/taxonomy gap, not routing quality. Pilot bug:
  `docs`/`testing` fingerprints never routed to their must-include skills (recall 0 by
  construction); fixed by aligning `inferredNeeds` with the taxonomy (`docs-writing`,
  `e2e-testing`).

## 2. Arm definitions (paired-trace counterfactual)

| Arm | Skill set given to the agent | What it isolates |
|---|---|---|
| `repotify` | v2 pipeline (`recommendV1`) selected set for the scenario fingerprint | the pipeline under test |
| `v1-baseline` | FROZEN v1 engine (`src/recommend.mjs`) defaultSet | legacy reference: is v2 better than v1? |
| `none` | no skills (bare agent) | absolute value of having skills at all (A−B) |
| `naive` | seeded random set, same *count* as `repotify`'s | whether recommendation quality matters beyond "any skills" (A−C) |
| `jev` | Jev decision model ranks `repotify`'s v2 ranked rows, top-3 by choice probability | routing-signal arm (decision model, not generative) |
| `oracle` | exactly the ground-truth `mustInclude` set | ceiling: separates "can the pipeline route" from "do the right skills help" |
| `placebo` | seeded random set like `naive`, but phase-2 content replaced with blanks | whether skill *content* matters vs. mere prompt structure |

> **Honesty note (P1, 2026-10-01):** before the engine-duality fix, the `repotify`
> arm ran the **v1** engine (`src/recommend.mjs`) — every pre-P1 pilot number
> labeled "repotify" (e.g. routing recall Δ +0.30 vs none) measures v1, not v2.
> Those runs are kept for history but must not be quoted as v2 evidence. The old
> arm is now honestly labeled `v1-baseline` (frozen reference).

Arms are **paired by (scenario, rep)**: the same scenario × rep index is the comparison unit.
The naive arm's seed is `hash(scenario_id, rep)` (mulberry32) — reproducible, and a fresh
draw per rep. `repotify` is deterministic; `naive` and model sampling are the random parts.

## 3. Two-phase protocol (causal chain kept intact)

A single call cannot measure skill *use*: an agent that only names skill ids never consumes
skill content. Every run is therefore two model calls:

- **Phase 1 — ROUTING.** Agent sees skill *cards* (`id`: 160-char summary), replies with one
  `SKILLS: <ids|NONE>` line. → routing metric.
- **Phase 2 — TASK.** Agent sees the *full content* of exactly the skills it chose
  (commit-pinned `SKILL.md` from the source repo, cached in `test/harness/cache/`,
  ≤ 4000 chars/skill; catalog dossier fallback when no body exists — e.g. MCP servers —
  recorded per skill in `content_sources`), replies with `DELIVERABLE:` + solution. → task metric.

## 4. Metric formulas

- **Correct routing rate (recall)** = `|chosen_valid ∩ mustInclude| / |mustInclude|`,
  where `chosen_valid` = declared ids that were actually offered (hallucinated ids are
  recorded separately, never counted). Reported per scenario × arm as mean over reps with a
  seeded bootstrap 95% CI (`report.mjs`).
- **Routing precision** = `|chosen_valid ∩ mustInclude| / |chosen_valid|` (0 when nothing
  chosen but something was required; 1 when nothing required and nothing chosen), plus F1.
  Recall alone rewards over-selection; precision keeps it honest.
- **Over-routing (violations)** = count of `chosen_valid ∩ mustNotInclude`.
- **Task success** = `Σ earned / Σ max` over the scenario's deterministic rubric
  (`contains` / `regex` (case-insensitive) / `not-contains` checks on the deliverable).
  Deliberately no LLM judge in v1: shallow but reproducible, zero judge cost/variance.
- **Token cost** = `(chars_in + chars_out) / 4` per phase. This is an *estimate*: the NIM
  endpoint used via the nvidia skill does not surface usage in `chat.py` output.
  Jev routing calls record the billed `usage.cost` returned by the API.
- **Recommender overhead** = `pipeline_ms` per run (the pipeline is local deterministic JS;
  tokens 0). The comparison is net value, not gross.
- **Retries** = attempts beyond the first per phase (0 = first try succeeded), max 2 per
  phase, temperature raised on retry. A run that exhausts retries records
  `contract_fail_route` / `contract_fail_task` and keeps its partial scores — the
  contract-fail rate is a reported metric, never silently dropped.

## 5. Repetitions and learning curves

- `--runs N` repeats every scenario × arm (default 1; pilot: 2). One score is not a result;
  the report prints means with bootstrap 95% CIs, and `--by-rep` prints the raw curve.
- Because reps are random draws (model sampling; naive arm reseeds per rep), treat n=2 as a
  smoke signal only. For effect-size claims: ≥ 10 reps/arm, or fewer scenarios × more reps
  (variance is the binding constraint at pilot scale).
- Failure attribution: `ok:false` records (driver errors) are kept in the JSONL and excluded
  from aggregates — they are reported as a separate count, never silently dropped.
- **Rep sizing (FAZ 7-MINI, 2026-10-01; web research):** standard error of a rate is
  `sqrt(p(1-p)/n)` — near 0%/100% pass rates need 1–2 trials, the 30–70% band needs 5–10,
  hunting tail failures needs 20+. Mini series (n=3–4/arm) are smoke signals only: frame
  their gates as **harm-gates** (delta ≥ 0, no per-scenario harm), never efficacy claims.
  For the 100-repo series, pre-register the primary comparator (`naive` — the incremental
  value of recommendation over naive injection) and size n to detect its delta; use
  paired bootstrap CIs (or McNemar) on scenario × rep pairs. Adaptive sampling: run few
  trials first, invest more reps where the result sits near the decision boundary.

## 6. Cost ceiling

- Per call: `--max-tokens 500`, short prompts (skill cards, not bodies, in phase 1).
- Pilot budget: 5 scenarios × 3 arms × 2 reps × 2 phases = 60 agent calls
  (~1k input + ≤500 output tokens each) + 5 Jev routing calls (~$0.00002 each).
- Hard stops per call: 120 s timeout (chat), 15 s (content fetch); content is cached, so
  repeated series pay the fetch cost once.
- **Reference actuals (FAZ 7-MINI series3, 2026-10-01):** 36 runs × 2 phases = 72 GLM
  calls, ~68k est. tokens (~1.9k/run), 0 driver errors; jev arm = 9 OpenRouter calls at
  $0.000322 total. Full mini task (pilots + series + debate): 95 GLM calls.
- **New scenarios (2026-10-01):** `mcp-server` (mcp-builder; TypeScript MCP tooling) and
  `supply-chain` (supply-chain-risk-auditor; dependency audit) added for the 100-repo
  series; both verified pipeline-reachable (`mustInclude` ⊆ `defaultSet`) via `--dry-run`.

## 7. Threats and blind spots (from the GLM hostile review, 2026-10-01)

1. **Single-turn, no tool use.** The harness measures one-shot generation, not multi-step
   agent trajectories (no tool calls, no retries by the agent itself, no skill *invocation*
   telemetry). Mitigation: this is v1 scope; the metric that matters here — does the right
   skill set change the output — is measurable in one turn.
2. **Rubrics are shallow.** Deterministic checks reward surface features; a fluent wrong
   answer can score. Accepted for the pilot (reproducibility > depth); deeper rubrics or a
   calibrated judge arrive with more scenarios.
3. **Skill content fidelity varies.** `content_sources` records `github` / `cache` /
   `catalog-dossier` / `catalog-fallback` per skill — any analysis must stratify by it.
4. **Naive arm controls count, not prompt length.** Token estimates are reported per arm so
   the length confound is visible, not hidden.
5. **Model monoculture.** v1 runs GLM-5.3 only; the driver registry makes a second model a
   config entry (`--driver`, `--model`), which the 100-repo series must use — single-model
   results cannot speak for "agents" in general.
6. **Ceiling effects (observed in pilot series2, n=2).** On docs/python-api/testing, task
   scores hit 1.0 in all arms — the bare model solves these tasks from priors, so task-score
   deltas ≈ 0 while routing deltas stay informative (repotify−none Δ recall +0.30 over
   10 pairs). For the 100-repo series: harder tasks whose rubrics require skill-specific
   content. **Hardening method that worked (FAZ 7-MINI, 2026-10-01):** rubrics keyed to
   conventions that live ONLY in the skill content (semgrep `--metrics=off` + third-party
   rulesets; webapp-testing `scripts/with_server.py`; writing-guidelines source URL +
   `file:line` format). Post-hardening: docs 1.0→0.60/0.33, python-api 1.0→0.57/0.29
   (repotify/none), testing 0.89→0.57 for none after the WHAT/HOW fix below.
7. **Contract fragility (observed in pilot).** Phase-1 retries concentrate in the repotify
   arm (12/15 retries; 3 contract-fails over 30 runs) — the ~14-card routing prompt is the
   hardest contract. Measured, not hidden (`retries`, `contract_fail_*`), but the routing
   prompt itself is a design variable worth A/B testing.
8. **Agent-side selection vs. ranker quality.** The jev arm (series-arms, 1 rep) showed
   Jev ranking the ground-truth skill top-1 in 4/5 scenarios, yet the agent selected it
   in only 1/5 — the bottleneck was the agent's phase-1 choice, not the ranker.
   Skill-card informativeness is a first-class variable.
9. **Task states the WHAT, the skill states the HOW (FAZ 7-MINI).** If the task prompt
   lists the skill's conventions, the bare model follows the task text and the ceiling
   never breaks (testing v1: bare model scored 1.0 by obeying the task). The task must
   describe only the goal; the conventions must live only in the skill content. Test:
   if the none arm scores ≥ 0.8, the task leaks the HOW — rewrite it.
10. **Rubric examples must not share entities with the checks (FAZ 7-MINI).** A format
    example in the task (`DRAFT.md:3: ...`) lets the model pass pattern checks by quoting
    the example. Use a different entity in examples than in checks (`README.md` in the
    example, `DRAFT.md` in the checks).
11. **Routing recall vs `none` is a plumbing check, not efficacy (FAZ 7-MINI, GLM
    hostile review).** The none arm has no skill cards, so its recall is 0 by definition
    and repotify−none Δrecall = +1.000 [1,1] is structural, not empirical. Report it as
    a sanity check (did the pipeline retrieve must-include); the efficacy routing
    comparisons are repotify vs `naive` / `jev`.
12. **Pooled deltas hide per-scenario harm (FAZ 7-MINI, GLM hostile review).** series3
    testing showed none 0.89 > repotify 0.72 while the pooled delta stayed positive.
    Standing gate: report per-scenario repotify−none task deltas and fail the gate if
    any scenario is < −0.10 (investigate transcripts before scaling).
13. **Rubric–content collinearity (FAZ 7-MINI, GLM hostile review).** Pattern-anywhere
    checks can reward quoting injected skill content rather than doing the task better.
    Guardrails: the none arm must score low on hardened rubrics (observed 0.29–0.57),
    and spot-check transcripts for quoting-vs-doing. If a check is passable by copying
    the skill text verbatim without solving the task, rewrite it.

## 8. Result format

One JSONL record per run (`event: "harness_run"`, fields: scenario, arm, rep, driver, model,
protocol, skill_set + source, chosen, content_sources, routing_*, task_*, rubric per-check,
retries, phase1/phase2 token estimates, latency). The schema is forward-compatible with the
FAZ 1 telemetry event log (append-only JSONL, content-free).

## 9. Sources

- Paired with/without control as the core causal design; outcome-first, then cost;
  deterministic checks preferred over LLM judges:
  ekson73/multi-agent-os `agentic-tool-evaluator/SKILL.md` (with/without control isolates the
  tool's effect); zalom/agent-skills `skill-evaluating/SKILL.md` (paired evals, grade outcomes
  not paths); ngh1aa/uiux-ai-workspace (do not reward a skill for causing more tool calls).
- Accept-set grading for routing (not single-expected) and regression-vs-baseline gates:
  swestash/swe-workflow-skills `docs/ROUTING-BENCHMARK.md`.
- Change one factor at a time; enough repetitions to separate stable effects from variability;
  per-run resource budgets (timeout, token budget; violations score zero):
  evalgate/skills `evaluate-ai-change/references/experiment-analysis.md`;
  "Beyond Prompts: Measuring and Optimizing LLM Tool-Agent Harnesses" (arXiv 2609.05736).
- NVIDIA SkillEvaluator three-tier model (structure → semantic → live with/without agent
  eval; reported +41 correctness / +39 effectiveness lift):
  open-software-factory `2026-09-15-skill-lint-validation-and-evaluation.md`.
- Jev decisions API contract (`{model, state, questions}`, typed choice/noul/score,
  calibrated probabilities, usage.cost): OpenRouter docs (2026-09-23), jev-cookbook,
  phantomyard/phantombot decision-model notes.
