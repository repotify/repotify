# Benchmarks

Every number here comes from a command in this repository; how to reproduce each one is at the end.

## Recommendation quality

The scenario set (`test/eval/scenarios/`, 49 projects) says, for each kind of project, which items must be in the default
set and which must not. A *violation* is a must-not item that was recommended anyway: a web testing skill in a Flutter
app, Word and PowerPoint skills in a project whose dependencies only show Excel.

| Engine | Must-include hits | Violations | Cluster duplicates |
|---|---|---|---|
| 0.1.0: items scored one by one | 89 / 91 (97.8%) on 42 scenarios | 14 | 0 |
| 0.2.0: evidence, platforms, coverage | 95 / 95 (100%) on 44 scenarios | 0 | 0 |
| 0.2.0 + stack experts (catalog) | 108 / 108 (100%) on 49 scenarios | 0 | 0 |
| 2.0.0: the v2 engine the CLI serves, 91 items | 108 / 108 (100%) on 49 scenarios | 0 | 0 |
| 2.0.0 with the first crawled catalog (548 items, 95 repositories read) | 108 / 108 (100%) on 49 scenarios | 0 | 0 |
| **2.0.0 with the catalog derived from the full store (442 items)** | **108 / 108 (100%)** on 49 scenarios | **0** | **0** |

The 0.1.0 row uses the 42 scenarios that existed when the new engine was written (the 37 of 0.1.0, five new ones,
stricter must-nots on four); two more (command-line tools built with Typer and commander) came from checking real
repositories; five more (Angular, Laravel, Rails, Java, .NET) came with the stack experts, and each stack scenario now requires
its own expert and rejects the others'. The catalog grew sixfold (91 to 548 items) without a new violation: a crawled
item joins a default set only with evidence about itself, and otherwise waits as an alternative. The default set
averages 14.5 items (the two new hooks are in every set and cost no context) and 4,233 of the 6,000 characters of
context budget. The scenarios check default sets; what else the table offers was checked by reading it (see
[the full store](#the-pipeline-on-the-full-store)). CI fails below 97% hits or on any violation. What changed is described in
[ARCHITECTURE.md](ARCHITECTURE.md#the-recommendation-engine).

### On real repositories

Spot checks on public projects (fingerprint and default set, beyond the core):

| Repository | Detected | Picks beyond the core |
|---|---|---|
| `OpenZeppelin/openzeppelin-contracts` | Solidity, smart contracts | smart-contract review, Semgrep, property-based tests, supply-chain audit |
| `shadcn-ui/taxonomy`, `vercel/commerce` | Next.js web app | React composition and performance, frontend design, web UI review, web app tests |
| `fastapi/full-stack-fastapi-template` | FastAPI + React web app | the same web set, property-based tests |
| `flutter/samples` | Flutter (mobile and web samples) | frontend design, web UI review, property-based tests |
| `obytes/react-native-template-obytes` | Expo app with a web target | React Native skills plus the web set |

## The classifier

A decision model reads each skill and answers typed questions; rules act on confident answers only. Against 49
hand-labelled skills (`test/classify/`, re-run on 2026-10-03 with the taxonomy of 80 jobs):

| Question | Decision model | A jury's free-form labels |
|---|---|---|
| Is it software work at all | 47 / 48 (98%) | 42 / 48 (88%) |
| Its one main job | 42 / 48 (88%) | 25 / 48 (52%) |
| Language or framework | 42 / 43 (98%) | 37 / 43 (86%) |
| Tied to one product | 49 / 49 (100%) | no such label |
| Pays off once, every task or now and then | 35 / 41 (85%) | no such label |

With 58 jobs the main job was right 94% of the time; with 80 there are more ways to be nearly right. Four hand labels
were brought up to the larger taxonomy where a new job is the plain answer (a game skill is game development).

## Questions

`repotify questions` tries every answer against the engine and lists a question only when an answer to it would change
the default set. A test checks, for three fixture projects, that every option it lists changes the picks by exactly
the count it shows (`test/questions.test.mjs`). Over the seven fixture projects it lists one or two questions, and
three for an empty folder; a question is asked once.

## The skill router

The router is measured on requests paired with the skills that should handle them (none, for small commands and
questions), against 20 skills with their real descriptions and catalog jobs. It may name up to three skills.

| Set | Requests | A fitting skill is named | The first named is a fitting one | Silent when none fits |
|---|---|---|---|---|
| Written while building the router, and tuned on (three sets) | 247 | 98–100% | 84–88% | 100% |
| Written by another model, first round (read once, then tuned on) | 130 | 89% when first measured | 80% | 72% when first measured |
| **Written by another model, second round (never tuned on)** | **240** | **94.4%** (English 95.0%, Turkish 93.8%) | **78.8%** | **77.5%** (English 85%, Turkish 70%) |

The last row is the claim: those 240 requests were written by GLM-5.3 from the skills' descriptions alone
(`pipeline/router-evalset.mjs --round 2`), in English and Turkish, in four voices, and measured once after the last
change to the router. The rows above it show what tuning on a set does to its numbers, which is why they are not the
claim. Where it is wrong it is mostly loud, not deaf: about one request in five that no skill should handle still gets
a skill named, and the agent is told to decide, not to obey.

## Security scanner

| Test | Result |
|---|---|
| Deliberately malicious samples (`test/fixtures/malicious/`) | 45 / 45 caught at their expected level |
| Benign look-alikes (`test/fixtures/benign/`) | 28 / 28 pass below their ceiling |
| Real skills from four public collections | 127 skills: 99 verified, 17 caution, 3 quarantined, 8 rejected |
| False alarms on those real skills | 2 / 127 (1.6%); target ≤ 5% |

The corpus is `anthropics/skills`, `obra/superpowers`, `trailofbits/skills` and `vercel-labs/agent-skills` at the
commits listed in [the corpus report](reports/scan-corpus-report.md) (re-run on 2026-10-02 with scanner 1.4.0, which
gives the same verdicts as the scanners it replaced on all 127 skills). Three more skills are rejected than in the
report's first run: they tell the agent to clone a third-party repository and build or run it, which the scanner treats
as remote code execution since 2026-10-01. The false alarms are still the same two.

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

## The pipeline on the full store

Measured on 2026-10-03 and 2026-10-04 with the store of one crawl, on a server with 4 CPUs and 24 GB of memory unless
a laptop is named.

| Step | Measured |
|---|---|
| Discovery | 19,502 candidate repositories; 12,062 are not forks and have 10 stars or more |
| Crawl (laptop, 4 at a time) | 12,567 repositories read, 42 with an error; 7,533 hold skills: 419,581 skill folders, 317,666 distinct, 302,087 distinct `SKILL.md` texts |
| Restore on another machine | 7,533 of 7,533 repositories fetched again at their recorded commits in 77 minutes, none failed; 21 GB |
| Security scan, scanner 1.5.0 | 419,581 folders in 78 minutes with three processes: 376,515 verified, 22,544 caution, 8,724 quarantined, 11,798 rejected |
| Scanner 1.5.0 against 1.4.0 | Of 264,963 distinct folders both scanned, 113 changed level, every one to a stricter level |
| A second `observe` run | 12,525 repositories unchanged, nothing read again; the plan of what to ask in 59 seconds |
| Classification | 3,035 questions, none failed, $0.68 ($0.00022 each). 25,015 skill folders are answered about; 62,061 askable skills are not |
| Derive | 422,194 stored skills considered, 25,015 judged, 325 skills and 24 MCP servers listed, in about 20 seconds |
| Research | 890 repositories researched; 71 of the 74 repositories the derived skills come from, none of them flagged for inflated stars |

**What keeps a classified skill out** (24,613 of them, most common first): license missing or not accepted (5,189),
not software work (4,571), tied to a product a project cannot show (3,301), no single clear job (2,272), a copy or
near copy (1,783), kept in a repository's own agent folder (1,544), description not in English (1,101), the security
scan (1,002), purpose does not fit the job (832), samples or contributor tooling (598), about its own project (556),
a repository waiting for a human look (512) and its mirrors (307).

**Copies.** 197,505 skill names are in the store; 27,583 of them are used by two repositories or more with different
texts. On a sample of 1,009 such pairs (the best-known holder against another), the share of four-word runs both
texts have falls into two heaps: under a tenth for 523 pairs, half or more for 402, and 84 in between. Every pair
read between 0.25 and 0.7 was one skill at two revisions, which is where the rule's bar for same-named skills (a
fifth) comes from. A rewritten skill escapes it: one collection's `mcp-builder` shares 21% with the current
original, another's `slack-gif-creator` 3%. Those are caught by name, not by text.

**The crawler's silent exit.** With the event loop blocked for 2 to 18 seconds at a time (what storing a large
repository does), 13 of 75 requests to GitHub's tree API never settled on Node 24, and the process exited with
"unsettled top-level await". On an idle loop 48 of 48 settled. With the fix (a deadline on the body, another attempt,
and the store yielding every 50 ms) 60 of 60 settled under the same blocking.

**Limits of these numbers.** The copy bars and the limits were set by reading this same store, so the counts above
describe it and do not predict another crawl. The catalog's 241 arrivals were read by one reader, once; that read
removed classes of junk (leaked vendor skills, translations, benchmark output, skills about their own repository) but
is not a proof that none is left: skills written for a host framework or a narrow field (trading, clinical text,
protein folding) are still listed as alternatives when the decision model called them general. Only skills the model
was asked about can be listed, and the budget reached 8% of the distinct texts, the best-known repositories first.

## Context cost

| What the agent reads | Budget | Now |
|---|---|---|
| `skill/repotify/SKILL.md` | 1,500 tokens | 1,498 |
| One setup as the agent reads it: the start output, the skill, `questions --json`, the table and the install summary | — | 2,899 on average, 2,822–2,982 over the seven fixture projects (`node test/eval/flow-tokens.mjs`) |
| The whole flow: skill, fingerprint, questions, a 30-row table, install summary, the agent's own writing | 5,000 tokens | within budget (`test/token-budget.test.mjs`) |

Tokens are characters / 3.5, the conservative rule Repotify budgets with.

## Reproduce

```bash
npm test                                   # includes the timing and token-budget tests
npm run eval -- --verbose                  # recommendation quality, per scenario
node test/eval/router.mjs                  # the skill router, every request set
JEV_API_KEY=… node test/classify/compare.mjs   # the classifier against the hand labels (a few cents)
node test/eval/flow-tokens.mjs             # what one setup costs the agent, per fixture project
node test/eval/scan-corpus.mjs <clones> --details   # scanner on real skills (clone the four collections first)
```
