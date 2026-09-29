# Supply Chain Risk Report — `omniroute`

**Scanned:** `.`  
**Manifests read:** `package.json`, `package-lock.json`  
**Scanned at:** 2026-09-28T22:08:59+00:00  
**Direct dependencies:** 1 (npm 1)

## Summary

- **1 of 1 dependencies have known advisories.** See the findings below.
- **3 transitive packages carry known advisories** at the locked versions — see Transitive advisories.
- 1 of 1 dependencies carry at least one finding, 1 of which reaches production.
- Weakest coverage: **Repository archived**, established for 0 of 1; the Coverage section lists every criterion.

## Production dependencies

1 dependency is declared as runtime dependencies and ship in the built artifact. Advisory status is given for every one, clean or not.

| Dependency | Version | Advisories | Other findings |
|---|---|---|---|
| `omniroute` | 3.8.50 | **1 advisory affects the installed 3.8.50** | — |

## Findings

### Reaches production

| Dependency | Version | Weekly downloads | Findings |
|---|---|---|---|
| `omniroute` | 3.8.50 | 53,702/wk | 1 advisory affects the installed 3.8.50 |

## Upstream repository and CI hygiene — OpenSSF Scorecard

These criteria describe each dependency's own repository, not the audited
project. Remediation, where any exists, is upstream.

No criterion in this tier was assessable for any dependency.

## Transitive advisories

3 packages of the 1241 registry-verified packages beyond the direct set (resolved by `package-lock.json`) carry known advisories at the locked versions. Only advisories were checked at this depth.

| Package | Version | Reaches | Advisories |
|---|---|---|---|
| `adm-zip` (npm) | 0.5.18 | production | GHSA-7q85-xj36-vmfc, GHSA-vwc7-r8mq-g2x9, GHSA-xcpc-8h2w-3j85 |
| `dompurify` (npm) | 3.4.8 | production | GHSA-55q2-fjhq-7xh7, GHSA-c2j3-45gr-mqc4, GHSA-cmwh-pvxp-8882, GHSA-vxr8-fq34-vvx9 |
| `next` (npm) | 16.3.1 | production | GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36 |

## Informational

Measured, not flagged.

- **Publish provenance**: 1 of 1 publish with build provenance.
- **Security policy published**: not determinable for any dependency in this project.
- **Download volume**: established for 1 of 1; median 53,702/week. Lowest: `omniroute` (53,702/wk).

## Coverage

What was and was not measured, per criterion.

| Criterion | Tier | Assessed | Flagged | Not assessable |
|---|---|---|---|---|
| Known advisories | A | 1/1 | 1 | 0 |
| Deprecated or yanked | A | 1/1 | 0 | 0 |
| Repository archived | A | 0/1 | 0 | 1 |
| Maintenance activity | A | 0/1 | 0 | 1 |
| Publisher concentration | B | 0/1 | 0 | 1 |
| Install-time script execution | B | 1/1 | 0 | 0 |
| Dangerous CI workflow | scorecard | 0/1 | 0 | 1 |
| CI token permissions | scorecard | 0/1 | 0 | 1 |
| Checked-in binaries | scorecard | 0/1 | 0 | 1 |
| Changes reviewed by a second person | scorecard | 0/1 | 0 | 1 |
| Publish provenance | info | 1/1 | 0 | 0 |
| Security policy published | info | 0/1 | 0 | 1 |
| Download volume | info | 1/1 | 0 | 0 |

## Not assessable

**Repository archived**

- 1 dependency — the GitHub API did not answer: `omniroute`

**Checked-in binaries**

- 1 dependency — the GitHub API did not answer: `omniroute`

**Changes reviewed by a second person**

- 1 dependency — the GitHub API did not answer: `omniroute`

**Dangerous CI workflow**

- 1 dependency — the GitHub API did not answer: `omniroute`

**Publisher concentration**

- 1 dependency — publishes from CI with provenance, so the effective publisher set is whoever can merge to the release branch — not externally observable: `omniroute`

**Security policy published**

- 1 dependency — the GitHub API did not answer: `omniroute`

**Maintenance activity**

- 1 dependency — the GitHub API did not answer: `omniroute`

**CI token permissions**

- 1 dependency — the GitHub API did not answer: `omniroute`

## Method and caveats

- gh is not authenticated. GitHub allows 60 requests/hour unauthenticated against 5000 authenticated, so repository signals may be unassessable.
- Optional tooling detected: npm. Not installed, so not used: bundler-audit, cargo-audit, osv-scanner, pip-audit.
- Every criterion except advisories applies to direct dependencies only. The 1241 registry-verified packages resolved by package-lock.json were checked for known advisories at their locked versions, and for nothing else.
- HTTP sources: 6 fetched, 1 served from cache (oldest 0.0h old), 0 refetched as stale, 0 unavailable offline, 1 errors.
