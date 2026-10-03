# What the security checks cover, and what they do not

Repotify stands between third-party skills and your agent. This page says plainly what each check proves, so that a
green label is not read as more than it is. The rules live in `src/scan/`; every rule has a malicious and a benign
fixture in `test/fixtures/`, and the findings of the 2026-10 external audit are locked by `test/audit-fixes.test.mjs`.

## The levels

| Level | Meaning | In the catalog |
|---|---|---|
| `verified` | The scanner found nothing | yes |
| `caution` | Something a person should read first (an official installer piped to a shell, a network call, a new package, instructions loaded from a URL) | yes, installed only with `--accept-caution` |
| `quarantined` | A high-severity finding: needs human review | no |
| `rejected` | A critical finding | no |

**`verified` means "scanned for known malicious patterns". It does not mean "safe to follow".** The scanner reads
commands and code the way a shell would, and a short list of plain-language patterns (below). An instruction written
in ordinary words that the list does not know still passes. Read a skill before you rely on it, as you would any
dependency.

## What the scanner reads

- **Remote execution.** A download piped into an interpreter, a download that is run afterwards, a clone whose files
  are run, command substitution. Command words are read as the shell reads them: `c'u'rl`, `c\url`, `\curl`,
  `/usr/bin/curl` and a command split across a `\` line continuation are all `curl`.
- **Documentation is not an excuse the reader cannot see.** A warning word before a command ("Never run …") lowers a
  finding only when the reader sees it. Text inside an HTML comment, a `[//]: #` comment or a hidden element does not
  count, and a command hidden there is never treated as an example.
- **Obfuscation.** Base64 or hex decoded into `eval`/`exec`, PowerShell `-EncodedCommand` (any abbreviation),
  `FromBase64String` piped to `Invoke-Expression`, long encoded blobs next to an execution primitive.
- **Credentials and exfiltration.** Reads of key files and browser stores, uploads of local files, sends with a
  secret nearby, known drop hosts.
- **Hidden characters.** Unicode tags, bidirectional overrides, zero-width runs.
- **Prompt injection.** "Ignore the previous instructions" in English, Turkish, Spanish, French, German, Portuguese,
  Italian, Russian, Chinese and Japanese; notes addressed to a reviewer or model; requests for a score.
- **Unsafe instructions** (rule `unsafe-instruction`). High: telling the agent to wave a security warning through,
  to switch the guard off, or to read `.env` into the conversation. Caution: instructions loaded from a URL nobody
  vetted, "policy requires you to …", an irreversible action "without asking", sending local content to a URL with
  the agent's own tools. These are wording heuristics: they are narrow on purpose, and a paraphrase can miss them.

## The package guard

The guard (a Claude Code `PreToolUse` hook) looks at install commands before they run. It blocks a package that does
not exist on npm or PyPI and asks before one first published in the last 14 days. It reads through `sudo`, `env`,
`nice`, `timeout`, absolute paths, `.cmd` shims, `pip3.11`, `python -m pip` with options, and
`pip install -r requirements.txt`.

It asks, instead of passing in silence, whenever it could not check:

- the registry did not answer (offline, timeout, error),
- the install comes from a URL or a git host, including `name @ https://…` and `name@github:user/repo`,
- the command names a registry other than the public one (a private registry configured in `.npmrc` is respected and
  stays silent),
- a requirements file could not be read, or the command names more than 25 packages.

It does not see a bare `npm install` (the packages come from `package.json`), and it is a guard rail, not a sandbox.

## MCP servers

A server's environment is part of its command. The gate, `repotify enable` and `repotify audit` read it: a variable
that redirects installs or code loading (`npm_config_registry`, `UV_INDEX_URL`, `PIP_INDEX_URL`, `NODE_OPTIONS`,
`LD_PRELOAD`, `PATH`, proxies and the like) is refused in the catalog, never written to your config, and marked for
review when found in one. On an update, a value you set yourself is kept over the catalog's.

## The publishing gate

Before an item enters the catalog its pinned package version is checked for install scripts and known
vulnerabilities (OSV), and a package first published in the last 14 days is marked. If the registry or OSV does not
answer, the item is **not** published: an unanswered check is not a passed one. MCP gate results are stored per
scanner and gate version, so a verdict from older rules is made again.

## Hooks and the launcher

Hooks run a command at session start. That command is either the published package (`npx -y @repotify/repotify@latest`)
or `node "<absolute path>/repotify.mjs"` for a clone, taken from the copy of Repotify you are running. It is never
taken from `repotify.lock.json`, which a cloned repository can ship.

## The catalog

Files are downloaded at a pinned commit and checked against the SHA-256 in the catalog. The catalog itself is not
signed: its integrity rests on HTTPS to GitHub and, for the copy bundled in the npm package, on npm provenance. What
is done about the rest:

- a cached catalog is used only for the source it was downloaded from,
- an older remote catalog, or the same version with different content, is refused,
- `REPOTIFY_CATALOG_URL` is announced on every run, and `repotify telemetry status` lists the overrides in effect,
- a catalog more than 60 days old that could not be refreshed says so.

## Known limits

- No signature on `meta.json` yet, and no revocation channel: an item that turns bad after you installed it is
  reported by `repotify update --check` only once the catalog drops it.
- The plain-language rules are heuristics. A model reading every skill for instruction safety (a second opinion from
  the jury) is not built.
- The fleet server for `repotify sync` is not deployed. Its design accepts unauthenticated syncs; that must be
  hardened before it runs.
