# Benchmarks

Every number here comes from a command in this repository; how to reproduce each one is at the end.

## Recommendation quality

The scenario set (`eval/scenarios/`, 42 projects) says, for each kind of project, which items must be in the default
set and which must not. A *violation* is a must-not item that was recommended anyway: a web testing skill in a Flutter
app, Word and PowerPoint skills in a project whose dependencies only show Excel.

| Engine | Must-include hits | Violations | Cluster duplicates |
|---|---|---|---|
| 0.1.0: items scored one by one | 89 / 91 (97.8%) | 14 | 0 |
| **0.2.0: evidence, platforms, coverage** | **91 / 91 (100%)** | **0** | **0** |

Both engines were run on the same 42 scenarios (the 37 of 0.1.0, five new ones, and stricter must-nots on four). What
changed is described in [ARCHITECTURE.md](ARCHITECTURE.md#the-recommendation-engine).

## Security scanner

| Test | Result |
|---|---|
| Deliberately malicious samples (`test/fixtures/malicious/`) | 37 / 37 caught at their expected level |
| Benign look-alikes (`test/fixtures/benign/`) | 24 / 24 pass below their ceiling |
| Real skills from four public collections | 127 skills: 100 verified, 19 caution, 3 quarantined, 5 rejected |
| False alarms on those real skills | 2 / 127 (1.6%); target ≤ 5% |

The corpus is `anthropics/skills`, `obra/superpowers`, `trailofbits/skills` and `vercel-labs/agent-skills` at the
commits listed in [the corpus report](docs/reports/scan-corpus-report.md). The 0.2.0 scanner gives exactly the same
verdicts as 1.2.0 on all 127 skills (re-run on 2026-09-29).

### Scanning long lines

A skill can hide work in one very long line. The scanner must stay linear; a timing test holds each case under 1.5 s.
Times for 20,000 repeats on a laptop (lower is better):

| Case | 0.1.0, Node 24 | 0.2.0, Node 24 | 0.1.0, Node 18 | 0.2.0, Node 18 |
|---|---|---|---|---|
| Download chain (`curl -o x ;` × 20,000) | 1,966 ms | **483 ms** | 2,073 ms | **544 ms** |
| Pipes (`curl \|` × 20,000) | 227 ms | 223 ms | 236 ms | 255 ms |
| Uploads (`curl -F x` × 20,000) | 139 ms | 176 ms | 160 ms | 161 ms |

Before 0.2.0 the download chain case re-read each later command once per earlier download; it failed the timing test
on Node 18 in CI and on slower machines.

## Context cost

| What the agent reads | Budget | Now |
|---|---|---|
| `skill/repotify/SKILL.md` | 1,500 tokens | 1,373 |
| The whole flow: skill, fingerprint, questions, a 30-row table, install summary, the agent's own writing | 5,000 tokens | within budget (`test/token-budget.test.mjs`) |

## Reproduce

```bash
npm test                                   # includes the timing and token-budget tests
npm run eval -- --verbose                  # recommendation quality, per scenario
node eval/scan-corpus.mjs <clones> --details   # scanner on real skills (clone the four collections first)
```
