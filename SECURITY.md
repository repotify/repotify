# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories ("Report a vulnerability" on this repository). Do not open a public issue for security problems. We aim to acknowledge reports within 3 days.

## Reporting a malicious or risky catalog item

Open a private advisory with the item id, the commit and what you observed. Confirmed items are added to `pipeline/denylist.json` (repository, optional path and commit), which quarantines them in the next catalog build, and clients stop recommending them. Installed copies stay locked to the reviewed commit; `repotify update --check` warns about items that left the catalog.

## What Repotify guarantees

- Catalog files are verified against `meta.json` hashes; an older catalog than the one you already have is refused.
- Skill files are downloaded from a pinned commit, checked against catalog SHA-256 hashes and re-scanned locally before they are written.
- Repotify never overwrites a folder it did not create and never runs third-party tools for you.
- Repotify itself has zero runtime dependencies and publishes with npm provenance.

## Writing skills that pass the scanner

The scanner reads a runnable command next to descriptive words ("attackers use …", "e.g. …") as something a human must
review, because the item's author writes those words. To show a dangerous command as an example, put a negation right
before it ("Never run …") or use a reserved documentation domain (`example.com`, `*.example`, `*.test`). Scripts that
download and run installers should use the vendor's official install URL.

## What it does not guarantee

A scanner cannot prove that code is safe. `verified` means "no known risky pattern was found", not "audited". Treat `caution` findings as real and read them before accepting.
