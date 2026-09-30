# Benchmarks

Every number here comes from a command in this repository; how to reproduce each one is at the end.

## Recommendation quality

The scenario set (`eval/scenarios/`, 44 projects) says, for each kind of project, which items must be in the default
set and which must not. A *violation* is a must-not item that was recommended anyway: a web testing skill in a Flutter
app, Word and PowerPoint skills in a project whose dependencies only show Excel.

| Engine | Must-include hits | Violations | Cluster duplicates |
|---|---|---|---|
| 0.1.0: items scored one by one | 89 / 91 (97.8%) on 42 scenarios | 14 | 0 |
| **0.2.0: evidence, platforms, coverage** | **95 / 95 (100%)** on 44 scenarios | **0** | **0** |

The 0.1.0 row uses the 42 scenarios that existed when the new engine was written (the 37 of 0.1.0, five new ones,
stricter must-nots on four); two more (command-line tools built with Typer and commander) came from checking real
repositories. The default set averages 11.4 items and 3,589 of the 6,000 characters of context budget. CI fails below
97% hits or on any violation. What changed is described in [ARCHITECTURE.md](ARCHITECTURE.md#the-recommendation-engine).

### On real repositories

Spot checks on public projects (fingerprint and default set, beyond the core):

| Repository | Detected | Picks beyond the core |
|---|---|---|
| `OpenZeppelin/openzeppelin-contracts` | Solidity, smart contracts | smart-contract review, Semgrep, property-based tests, supply-chain audit |
| `shadcn-ui/taxonomy`, `vercel/commerce` | Next.js web app | React composition and performance, frontend design, web UI review, web app tests |
| `fastapi/full-stack-fastapi-template` | FastAPI + React web app | the same web set, property-based tests |
| `flutter/samples` | Flutter (mobile and web samples) | frontend design, web UI review, property-based tests |
| `obytes/react-native-template-obytes` | Expo app with a web target | React Native skills plus the web set |

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
