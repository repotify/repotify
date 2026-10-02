# Engine map — `src/recommend.mjs` vs `lib/pipeline/recommend/` (FAZ 11, Q-E)

**Finding:** `src/recommend.mjs` ("v1 engine") is NOT dead. It is load-bearing.
Do NOT delete it. Any consolidation is a real refactor — proposed to Ahmet as
part of DECISION-PACKAGE-FAZ11.md, not executed unilaterally.

## Who imports `src/recommend.mjs`

| Importer | Imports | Role |
|---|---|---|
| `pipeline/loadouts.mjs` (tracked, v1 catalog pipeline) | `qualityScore`, `trustScore` | `value()` ranking for loadout picking; trust gate (`trustScore(...) !== null`) |
| `test/harness/arms.mjs` | `recommend` | harness "repotify" arm = v1 `recommend` defaultSet |
| `test/recommend*.test.mjs`, `test/token-budget.test.mjs`, `test/enable.test.mjs` | `recommend`, `formatTable`, `pickLoadout`, `buildDemand`, `platformMismatch`, `fitScore` | v1 engine unit tests |

## What v2 (`lib/pipeline/recommend/`) does NOT reuse

**Update 2026-10-02 (option 1, first step):** v2 now shares v1's primitives instead of
re-deriving them — `score.mjs` imports `fitScore`, `qualityScore`, `adoptionScore`,
`communityScore` and `WEIGHTS`; `index.mjs` imports `buildDemand` and `pickLoadout`.
`test/eval/run.mjs` measures v2 (`recommendLocal`), the engine the CLI serves.

## The overlap (why this is tech debt, not just duplication)

- Jury scoring primitives (`qualityScore(jury)`, `trustScore(level)`) live in v1's
  `src/recommend.mjs` and are consumed by the **tracked** v1 catalog pipeline
  (`pipeline/loadouts.mjs`) — while v2's recommend path has its own scoring in
  `lib/pipeline/recommend/score.mjs`.
- The eval runner measures v2 since 2026-10-02. The harness's "repotify" arm still
  measures the **v1** engine. If v2 is the shipped engine, the harness measures the wrong thing;
  if v1 is still the reference, the CLI migration (FAZ 10 d1) created two truths.

## Consolidation options (Ahmet decides)

1. **Extract shared primitives** (`qualityScore`, `trustScore`, `fitScore`,
   `buildDemand`) into `lib/scoring/` imported by both engines; v1 and v2 become
   thin shells. Medium blast radius: `pipeline/loadouts.mjs`, eval, harness, tests.
2. **Freeze v1**: declare `src/recommend.mjs` the frozen reference for eval/harness
   baselines ("v1 arm"), never extend it; all new work in v2. Smallest change,
   but the harness "repotify" arm keeps measuring v1 — rename it to `v1-baseline`.
3. **Full migration**: port remaining v1 consumers to v2 and delete
   `src/recommend.mjs`. Largest blast radius; needs the harness/eval rewritten
   against v2 first.

Recommendation to Ahmet: option 2 now (honest labeling, zero risk), option 1
as a scheduled phase after "bas".
