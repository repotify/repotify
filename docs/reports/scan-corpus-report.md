# Scanner false-alarm report (real corpus)

Date: 2026-09-28 · Scanner 1.2.0 · Command: `node test/eval/scan-corpus.mjs <clones> --details`

Sources (shallow clones at HEAD, the same commits as the 1.0.0 report):

- `anthropics/skills` @ `33375500bcea98d610eb30ce10ac4e59b89c390d`
- `obra/superpowers` @ `8ca22dba9a94f28898bbce59f2537ff4d87c747d`
- `trailofbits/skills` @ `82fe8226252622fa807643bdca1710901198553a`
- `vercel-labs/agent-skills` @ `063bee94c3f4df8453406c830b0a7df0f2860278`

| Scanner | Skills | verified | caution | quarantined | rejected | blocked rate |
|---|---|---|---|---|---|---|
| 1.0.0 | 127 | 101 | 22 | 3 | 1 | 3.1% |
| 1.1.0 | 127 | 100 | 21 | 3 | 3 | 4.7% |
| **1.2.0** | 127 | 100 | 19 | 3 | 5 | **6.3%**; false alarms 2/127 = **1.6%** (target ≤ 5%) |

Scanner 1.2.0 (second code review) reads shell structure and parses URLs as curl does. Against 1.1.0 it changed two
skills, both true positives: `genotoxic` and `vector-forge` pipe a third-party repository script into `sudo -E bash`
across a line continuation, a form 1.1.0 missed. The blocked rate is above the 5% target, but six of the eight blocked
skills are blocked by policy, not by mistake: two ship archives that cannot be scanned, and four run remote scripts from
hosts that are not official installers. The two false alarms are security write-ups (below).

Scanner 1.1.0 closed the bypasses found in code review (C1, I9): `sh -c "$(curl …)"`, download-then-execute, multi-stage
pipes, file uploads, attacker-controlled documentation context, unclosed detection fences and chained `echo` lines. The price
is two more blocked skills, both explained below. Descriptive words (theft, malware, keylogger, indicators, persistence,
backdoor …) were added to the documentation vocabulary so that security guides that *describe* attacks before showing them
stay at caution; without them the rate was 5.5%.

## Blocked skills (sent to the human review queue)

| Skill | Level | Reason |
|---|---|---|
| anthropics_skills/skills/web-artifacts-builder | quarantined | binary-file: `scripts/shadcn-components.tar.gz` cannot be scanned |
| trailofbits_skills/…/agentic-actions-auditor | rejected | remote-exec: `references/vector-f-subshell-expansion.md:51` |
| trailofbits_skills/…/devcontainer-setup | rejected | remote-exec: `resources/Dockerfile:98` |
| trailofbits_skills/…/modern-python | rejected | remote-exec: `references/security-setup.md:19` |
| trailofbits_skills/…/sharp-edges | quarantined | dangerous-command: `references/case-studies.md:186` |
| trailofbits_skills/…/trailmark/genotoxic | rejected | remote-exec: `references/mutation-frameworks.md:367` |
| trailofbits_skills/…/trailmark/vector-forge | rejected | remote-exec: `references/mutation-frameworks.md:364` |
| vercel-labs_agent-skills/skills/deploy-to-vercel | quarantined | binary-file: `Archive.zip` cannot be scanned |

- **New in 1.1.0: devcontainer-setup.** Its Dockerfile runs `sh -c "$(curl -fsSL https://github.com/deluan/zsh-in-docker/releases/…)"`,
  an unpinned third-party script. 1.0.0 missed this form entirely. This is a true positive under the policy.
- **New in 1.1.0: agentic-actions-auditor.** The line is prose that explains why `` `echo $(curl … | sh)` `` defeats tool
  allowlists. Inline code alone no longer demotes a finding (an attacker can wrap any command in backticks), so this is a
  false positive by design. A critical finding means `rejected`, and human review only applies to quarantined items,
  so the skill left the bundled catalog. It comes back when upstream rewords the line or quotes the command.
- **New in 1.2.0: genotoxic, vector-forge.** `curl -1sLf 'https://dl.cloudsmith.io/public/mull-project/…/setup.deb.sh' \`
  then `| sudo -E bash` on the next line. Cloudsmith hosts packages for anyone, so the host is not an official installer.
  True positive under the policy.
- The other four are unchanged from 1.0.0: two opaque archives, a GitHub release script piped into `sh`, and an embedded
  pickle payload containing `rm -rf /` (a false alarm: it is a case study of a pickle exploit).

**False alarms:** `agentic-actions-auditor` and `sharp-edges`, both of which describe attacks. A reviewer can approve a
quarantined item at one commit (`pipeline/reviewed.json`), but a rejected one stays out.

**For skill authors:** the scanner treats a runnable command next to descriptive words ("attackers use …", "e.g. …") as
something to review, because those words are written by the item's author. A negation right before the command ("Never
run …") or a reserved documentation domain (`example.com`, `*.example`, `*.test`) keeps an example at caution.

## Caution (non-blocking, shown with a badge)

- anthropics_skills/skills/claude-api: network-call, exfiltration, dangerous-command
- anthropics_skills/skills/docx: network-call
- anthropics_skills/skills/pptx: network-call
- anthropics_skills/skills/skill-creator: network-call
- anthropics_skills/skills/xlsx: network-call
- obra_superpowers/skills/brainstorming: network-call
- trailofbits_skills/plugins/audit-context-building/skills/audit-context-building: hidden-unicode
- trailofbits_skills/plugins/constant-time-analysis/skills/constant-time-analysis: dangerous-command, network-call
- trailofbits_skills/plugins/culture-index/skills/interpreting-culture-index: remote-exec
- trailofbits_skills/plugins/firebase-apk-scanner/skills/firebase-apk-scanner: network-call, dangerous-command
- trailofbits_skills/plugins/post-patch-validation/skills/post-patch-validation: network-call
- trailofbits_skills/plugins/spec-to-code-compliance/skills/spec-to-code-compliance: hidden-unicode
- trailofbits_skills/plugins/static-analysis/skills/sarif-parsing: network-call
- trailofbits_skills/plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor: network-call
- trailofbits_skills/plugins/testing-handbook-skills/skills/cargo-fuzz: network-call
- trailofbits_skills/plugins/testing-handbook-skills/skills/libafl: remote-exec, network-call
- trailofbits_skills/plugins/testing-handbook-skills/skills/libfuzzer: network-call
- trailofbits_skills/plugins/yara-authoring/skills/yara-rule-authoring: credential-access
- vercel-labs_agent-skills/skills/vercel-optimize: network-call

New network-call cautions (cargo-fuzz, libfuzzer, …) come from shell fences in Markdown, which 1.0.0 did not inspect.
`semgrep` left the list: 1.0.0 read `..` as a host name (review finding M17).
