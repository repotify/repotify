# Code review — 2026-09-28

A fresh reviewer read the whole first version against its design document, ran the test suite on Node 20 and
22 plus the evaluation set, and probed the scanner, installer, guard and loader with throwaway scripts. Verdict: **ready with
fixes**. It praised the architecture, install safety and test discipline, and found two critical issues: the scanner could be
bypassed, and the shipped catalog recommended a package with a critical RCE.

After the first round of fixes (scanner, client, pipeline and catalog), a second fresh review of those fixes found that C1, I3, I9, M14 and M16 were only partly fixed, and that two fixes
had regressed their neighbours; see [Second review](#second-review) below. The tables in this section describe the state
after both rounds. Most fixes are pinned by a test named after the finding (`grep -rn "C1:\|I3:\|M4:\|re-review" test/`).

After both rounds: tests 300/300 on Node 22 (294 plus 6 skipped `node:sqlite` tests on Node 18 and 20), evaluation 80/81
must-include hits with 0 violations, real-corpus blocked rate 6.3% (2 of the 8 blocked skills are false alarms; see
`docs/reports/scan-corpus-report.md`).

## Critical

| # | Finding | Fix |
|---|---|---|
| C1 | Common remote-exec forms (`sh -c "$(curl …)"`, download then run, `curl … \| tee … \| bash`, `curl -F file=@…`) came out `verified`. Attackers could also trigger demotions: an unclosed ```` ```yara ```` fence, a `# https://example.com` comment, `deno.land/x/<anyone>`, and `echo ok; cat ~/.ssh/id_rsa`. | Scanner 1.1.0 added rules for command substitution, download-then-execute, multi-stage pipes and file uploads, closed the unclosed-fence and chained-`echo` demotions, and added nine malicious fixtures. Scanner 1.2.0 (second review) parses URLs as curl does, reads shell structure instead of matching whole lines, and takes allowlist decisions only from the command's own destinations. The installer allowlist holds dedicated installer hosts or exact install paths, compared after URL normalisation. |
| C2 | The bundled catalog was built before the OSV gate and recommended `omniroute@3.8.50` (GHSA-hf57-cqmx-p4gr) as a default item. | The catalog was rebuilt with the current gate. `omniroute` is quarantined and left its loadouts. Security records carry `gateVersion`, and a test fails if a bundled item was gated by an older scanner or gate. Eval scenarios now require that `omniroute` is **not** recommended. |

## Important

| # | Finding | Fix |
|---|---|---|
| I1 | An unwritable `~/.repotify` crashed `recommend` and `start`. This happens in the Codex `workspace-write` and Claude Code sandboxes. | Config, telemetry, notice and cache writes are best-effort. `installId` returns null when it cannot persist. `bin` prints one line (`repotify: <message>`) instead of a stack trace. |
| I2 | A failed `update --apply` on an MCP item deleted the user's server and lock entry. | MCP updates happen in place. Consent and config writability are checked first, and the lock changes only on success. |
| I3 | The package guard blocked private scoped packages, `workspace:` specs and custom registries, and missed newline, subshell, `--prefix` and `yarn workspace` forms. | The tokenizer splits on newlines, `(`, `)`, backticks and `$(`. Custom registry flags and `.npmrc` scopes skip the check. Local specs are recognized anywhere in the token. A scoped package missing from the public registry gets "ask", not "block". |
| I4 | `github-mcp` wrote `"<your token>"` into MCP config files, which overrode the real environment variable and invited committing a token. | Placeholder env values are never written. The catalog entry has no `env` (docker `-e` passes the shell variable through). The steps say to export the token in the shell, and the install summary prints MCP steps. |
| I5 | Jury summaries of discovered items were published unchecked (second-order prompt injection). | Summaries with links, code or shell syntax, or with any scanner finding, are declined. |
| I6 | An item the scanner passed could not be pulled, although SECURITY.md promised quarantine. | `pipeline/denylist.json` (repo, optional path and commit) quarantines items before publishing. |
| I7 | The npm name `repotify` is unclaimed, yet every instruction started with `npx -y repotify@latest`. | README, README.tr, AGENTS.md and SKILL.md are clone-first until the package is published. The launcher actually used is recorded in the lock, and the skill and hook call it. **Still open for the maintainer: reserve the npm name.** |
| I8 | The real-run report was missing, the README claimed a jury score for items that had none, and the design notes were incomplete. | `docs/reports/pipeline-run-2026-09-28.md` has been added. All 24 bundled skills now carry three-juror verdicts. The README says tools and MCP servers are editorial picks that only the gate checks. The deviations section of the plan was completed. |
| I9 | Words such as "example", quotes or inline code on the same line demoted critical findings in Markdown. | A documentation word must come before the match, or the match must be quoted. Inline code alone and shell fences never demote. Descriptive security vocabulary keeps attack write-ups at caution. `agentic-actions-auditor` is now rejected for attack prose in a reference file and left the catalog (see the corpus report). |

## Minor

| # | Fix |
|---|---|
| M1 | `start` in the home or root folder skips the self-install and writes no lock. |
| M2 | The local re-scan covers exactly the downloaded files, including `node_modules/` paths. |
| M3 | `remove` only deletes lock targets shaped like `<agent>/skills/<one segment>`. |
| M4 | Offline mode and 304 return the newest of cache and bundled. A corrupt cache does not send its ETag. |
| M5 | A single juror reports agreement 0.5 (below the bar). Only full panels are cached. Cache keys include a taxonomy stamp. |
| M6 | The Worker stores one vote per install and item (upsert). Rate limiting still relies on the client-chosen install id, because no IP is stored by design. |
| M7 | The TOML duplicate check understands quoted table names and ignores comments. Env keys are quoted. |
| M8 | Tool steps are numbered instead of being joined with `&&`. |
| M9 | The weekly SessionStart hook is opt-in and uses the recorded launcher (`node "<clone>/bin/repotify.mjs"` for clone installs). With the npx launcher it still starts npx on each session. |
| M10 | Entry checks use `realpath` + `pathToFileURL` (paths with spaces, symlinks). |
| M11 | Clones use a blob filter. Skill folders above 400 files or 30 MB are refused before they are read. |
| M12 | `size.bytes` and the no-op `stripPackagePins` were removed. `seed.mjs` is a thin wrapper around `runPipeline`. |
| M13 | Staging happens in `<agent dir>/.repotify-staging/`, outside the skills folder, so a crash cannot leave a duplicate skill. |
| M14 | MCP command and args are scanned locally before anything is written. |
| M15 | `vote` needs a lock entry. |
| M16 | Self-update compares versions and never overwrites a newer installed skill. |
| M17 | The URL host regex no longer accepts dot-only hosts (`semgrep` is `verified` again). |

## Found while verifying the fixes

- **Launcher detection on Node 18/20.** Running the suite through `npx node@20` failed one test. `npm_command=exec`
  leaks into every child process of an npx run, so a clone started that way recorded the npx launcher. Detection now
  looks only at where the code lives (`_npx` or `node_modules` in the path).
- **Human approvals did not work end to end.** The end-to-end install run recommended `agentic-actions-auditor` (approved
  in `reviewed.json`), and then the client's local re-scan refused it, as it would every approved item. Also, the
  approval had lifted a *rejected* item, which the security policy does not allow (critical findings are rejected). Now `reviewed.json` lifts only quarantined
  items. The client accepts such an item only when every high finding of its local re-scan is one recorded in the
  catalog entry the reviewer approved; critical findings and findings the reviewer never saw still block. The approval
  for `agentic-actions-auditor` was withdrawn, and the item left the catalog.

## Second review

A second fresh reviewer read the first round of fixes in a clean checkout, reproduced every number, and tried to bypass the
new rules. Verdict: **with fixes**. Every item below is fixed and pinned by
`test/scan-rereview.test.mjs` or a `re-review` test.

| # | Finding | Fix |
|---|---|---|
| C-1 | Still `verified`: a URL with a user part (`https://api.github.com@evil-cdn.io/`), a known-API URL in a trailing comment, PowerShell `irm … \| iex`, `curl -d @.env`, `wget --post-file`, and a known-API URL elsewhere on the line. | URLs are parsed with `new URL()`; a user part is never trusted. The upload rule and the exfiltration window trust only the send statement's own literal destinations. PowerShell forms and all upload forms were added. |
| I-1 | Still `caution`: user parts and `..` segments in installer URLs, `\| /bin/bash`, `\| sudo -E bash`, `\| env bash`, line continuations, two-line download-then-run, `source <(curl …)`, backtick substitutions, `$(…)` inside an `echo` string, attacker-written descriptive words, and a payload in a `.rules` file. | `src/scan/shell.mjs` splits text into pipelines (quotes, substitutions, redirections, continuations, table cells) in linear time. Any fetch piped into an interpreter that runs its input is remote exec. A download that a command within the next lines runs is remote exec. A critical remote-exec match in documentation goes to human review unless a negation comes right before it. Running a detection-rule file is a finding. |
| I-2 | The download-then-execute regex backtracked cubically (29.5 s for a 22 KB line). | Replaced by the shell reader. Every regex quantifier between two parts is bounded. A timing test scans 220 KB lines in well under a second. |
| I-3 | The same regex rejected ordinary lines (`wget … ; tar …; ./configure`, a Markdown table row, `\|\| sh fallback.sh`). | A download counts only when the command that runs is the downloaded file. Table rows and `\|\|` are not pipes. Piping JSON into `python3 -c "…json.load(sys.stdin)…"` is data, unless the inline code executes it. |
| I-4 | MCP updates skipped the local setup scan. | `checkMcpSetup` runs before an install and before an update. |
| I-5 | The guard stopped checking `npm i -f x` and `pip install -i https://pypi.org/simple x`. | Custom-registry flags are per ecosystem; public registry URLs are still checked. |
| I-6 | The bundled catalog shipped a *rejected* item lifted by an approval that was not a human's. | Fixed before this review ended (see above). The bundled-catalog test now also checks that the recorded findings justify each level. |
| I-7 | The docs overstated what was fixed. | This file, the corpus report and the design notes were corrected. |
| (declined) | `hooks.slack.com` was a known API although anyone can create an incoming webhook. | Only the Slack Web API path (`slack.com/api/`) is known now. |
| M-a | The downgrade guard held for one run only. | An older copy leaves the newer version and launcher in the lock. |
| M-b | `e.g.` never matched the documentation vocabulary. | Fixed. |
| M-c | The summary filter blocked harmless punctuation and let instructions through. | It now declines hosts, flags and agent-directed text. |
| M-d | MCP updates dropped env values the user added, and silently did nothing without recorded agents. | User env values are kept (JSON and TOML); agents are inferred from lock targets. |
| M-e | A test hook lived in `runCli`. | `bin/` calls a testable `main()`; the hook is gone. |
| M-f | Launcher detection recorded npx for clone runs. | Fixed before this review ended. |
| M-g | The clone launcher is an absolute path in `repotify.lock.json` and in the opt-in SessionStart hook in `.claude/settings.json`. | **Open, for the maintainer to decide.** Writing the hook to `.claude/settings.local.json` and keeping the launcher out of the shared lock are the likely fixes. |
| M-h | `inInlineCode` was dead code. | Removed. |
| M-i | npm aliases were looked up by alias name; only the project `.npmrc` was read. | Aliases resolve to the real package; `~/.npmrc` scopes are respected. |

Plan issue raised by the reviewer: an implementing agent must not approve its own exceptions. `docs/guides/operations.md` now
says approvals in `pipeline/reviewed.json` are a maintainer's decision, and none is present.

## Declined by the reviewers

The reviewers left these to the design or to the maintainer: whether caution items should be recommended (they are, with a
badge and explicit consent), catalog signing (the catalog is verified by hashes instead), Node 18 execution (tests later passed on 18.20.8), Windows behaviour of the guard hook, agent folder
paths (checked against each agent's official docs), editorial choices, provider availability and analytics law.
