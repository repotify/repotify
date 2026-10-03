<p align="center"><img src=".github/assets/banner.png" alt="repotify: thousands of agent skills, the right ones for your repo" width="100%"></p>

<h3 align="center">Thousands of agent skills. The right ones for your repo.</h3>

<p align="center">Repotify finds the agent skills and MCP servers developers publish, vets each one for risk,<br>and installs the best picks for your project in Claude Code, Cursor, Codex or Gemini CLI.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@repotify/repotify"><img alt="npm" src="https://img.shields.io/npm/v/@repotify/repotify?style=flat-square&labelColor=000000&color=3FE8B8&label=npm"></a>
  <a href="https://github.com/repotify/repotify/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/repotify/repotify/ci.yml?branch=main&style=flat-square&labelColor=000000&label=ci"></a>
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-3FE8B8?style=flat-square&labelColor=000000">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3FE8B8?style=flat-square&labelColor=000000"></a>
</p>

> [!NOTE]
> **🤖 For AI agents.** If the user asked you to set up Repotify for their project, run the published npm package (with provenance) in their project folder: `npx -y @repotify/repotify@latest`. Then follow the `repotify` skill it installs into your skills folder (for example `.claude/skills/repotify/SKILL.md`, `.cursor/skills/repotify/SKILL.md` or `.agents/skills/repotify/SKILL.md`). Nothing beyond that skill is installed until the user approves it.

## Get started

In your project folder:

```bash
npx -y @repotify/repotify@latest
```

Or just tell your agent: **"Set up Repotify for this project: https://github.com/repotify/repotify"**

<p align="center"><img src=".github/assets/demo.svg" alt="A terminal: Repotify reads the project, recommends one pick per job, keeps react-native-skills out, and installs the picks" width="100%"></p>

## How it works

<p align="center"><img src=".github/assets/how-it-works.svg" alt="Four steps: read the project, ask at most three questions, pick one scanned item per job, install from a pinned commit" width="100%"></p>

1. **Read.** It looks at your manifests and file names, and at which runtimes this computer has. Your code is never read or sent anywhere.
2. **Ask.** Only the questions whose answer would change the picks: at most three, often none. Each is asked once.
3. **Pick.** One best skill, MCP server or tool per job, from a catalog where every item passed a security scan and was classified by a decision model. A find from the crawl joins your default set only with proof that people use it; without it, it is listed as an alternative.
4. **Install.** Each skill comes from a pinned commit, is hash-checked and scanned again on your machine. Hooks and MCP servers stay off until you switch them on.
5. **Keep up.** Two optional hooks keep the setup working after day one: the tracker and the router (below).

## See the decision

`repotify ui` opens a page on your own computer that draws the catalog as a tree. Orange is still in play, green is picked; each answer you give settles a branch, until only the picks are left. It reads; it cannot install or change anything.

<p align="center"><img src=".github/assets/ui.gif" alt="repotify ui: the catalog as a tree. The whole catalog starts in play; the project's files and three answers narrow it to the picks" width="100%"></p>

## After the install

- **The tracker** (a session-start hook) remembers which stacks and needs your project showed. When you add something new, say a payment library, it tells your agent once which new picks fit. Once a week it also checks for vetted updates and for skills that no longer earn their place.
- **The router** (a hook that runs before each request) works out what kind of work the request is (a bug, a plan, a review, a slow query), names the installed skills made for it and tells the agent to decide about those. When nothing fits it says nothing. It runs on your computer in about a tenth of a second, understands English and Turkish, and only ever writes skill names into the agent's context. Measured on 240 requests written by another model: it named a fitting skill for 94% of the requests a skill should handle, and stayed silent on 78% of those none should ([details](docs/BENCHMARKS.md#the-skill-router)).

You switch both on yourself: `repotify enable repotify-tracker repotify-router`.

## How the catalog is built

Agents pick skills by reading a one-line description. Repotify reads the whole skill first, and what people say about it.

1. **Find.** A crawler fetches every skill folder of a repository once into a content store: 4,651 skill folders from 54 repositories so far. MCP servers come from the official MCP registry: of more than 36,000 servers, 13,547 install locally from npm or PyPI.
2. **Vet.** Every file is read the way a shell would read it (hidden downloads, credential grabs, prompt injection). For an MCP server, the exact version the catalog pins is checked for install scripts and known vulnerabilities, and the package must have a command that starts a server.
3. **Classify.** A decision model ([Jev](https://openrouter.ai/docs/guides/community/jev)) reads each skill's full `SKILL.md` and answers typed questions with a probability: is it software work at all, what is its one main job, which language, framework or product is it for, is it tied to one product, what is it for, does it pay off once or every time, and how good is it. Rules act only on confident answers and send the rest to a human. Against 49 hand-labelled skills: main job right 88% of the time (a jury's free-form labels: 52%), language 98% (86%), off-topic caught 98% (88%).
4. **Research.** Stars can be bought, so four research agents read what else there is about a repository: forum threads, star history against real installs, directories and curated lists. Of the 90 repositories researched, 19 looked inflated; skills from three of them (471 skills) wait for a human instead of entering the catalog.
5. **Decide.** Rules turn all of this into catalog items with no network and no model call, so a changed rule rebuilds the catalog in seconds without fetching or asking anything again. 431 crawled skills and 24 MCP servers passed; they join 93 hand-vetted items. A crawled item joins a default set only with proof of real use (installs, or downloads and a starred repository); the rest are listed as alternatives.
6. **Pick.** Your project's manifests decide which jobs are wanted. One vetted item per job, inside a context budget; hand-vetted picks first.

The models run when the catalog is built, so you need no API key and no model calls: `repotify recommend` is deterministic and runs offline.

## Telemetry policy

Repotify is built to learn from anonymous usage signals. No collection server is running yet, so today nothing leaves your machine; this is what applies when one does:

- **Default-ON with a notice.** The first time anything could be recorded, the CLI prints a notice on stderr. Nothing is measured before that.
- **Kill switches.** `repotify telemetry off` (persisted), `REPOTIFY_TELEMETRY=0`, or `DO_NOT_TRACK=1` turn it off; nothing is sent and nothing is written when disabled.
- **What is measured.** Which catalog items were shown, installed, invoked, kept after 7/30 days or removed, and your votes — plus a random install id and agent type. Never: code, prompts, file names, repository names, user names, transcripts or IP addresses.
- **Fleet learning.** Signals stay in a local queue. Only `repotify sync` sends anything, only anonymous aggregates, and only after you confirm on the terminal. The fleet server admits, snapshots, gates and distributes a shared policy with k-anonymity (at least 5 contributing syncs per published bucket, 24-hour quarantine). Published is the proof — which skills measure best at which jobs — never the recipe: raw data, taste profiles, scoring formulas and bandit weights stay private.

## Why Repotify

<table>
<tr>
<td width="33%" valign="top">

**Fits your project**<br>
Excel in your dependencies brings the spreadsheet skill, not Word and PowerPoint. A mobile app never gets web-only skills.

</td>
<td width="33%" valign="top">

**Nothing sketchy gets in**<br>
Every skill is read the way a shell and curl would read it, so known tricks like hidden downloads, credential grabs and prompt injection get caught.

</td>
<td width="33%" valign="top">

**No bloat**<br>
One item per job, inside a context budget. Your agent stays fast instead of carrying instructions it never uses.

</td>
</tr>
</table>

## By hand vs. Repotify

| | By hand | With Repotify |
|---|---|---|
| Finding skills | Dig through GitHub, read dozens of READMEs | Evidence-based picks for your stack |
| Checking trust | Skim install scripts and hope | Shell-aware scan, a decision model, research beyond stars |
| Fitting the project | Guess which ones apply | One pick per job, nothing overlapping |
| Staying lean | Context fills with unused instructions | Stays inside a context budget |

## Clean up what you already have

`repotify audit` looks at the skills already in your project and tells you which to keep and which to drop, with the reason and what each one costs in tokens. It also reads the MCP servers your agents have configured: one whose command fails the security scan is marked for removal, one that is not pinned to a version or keeps a secret in its config file is marked for review. It never deletes anything.

Some skills pay off once: a codebase map is great on day one, then keeps loading its description every session and its full instructions every time it triggers. The classifier marks these (⏳ in the candidate table), and after two weeks `audit` tells you it has done its job:

```
consider graphify   Pays off once (codebase knowledge graph); installed 33 days ago, so it has likely
                    done its job ... (~90 tokens every session; ~10304 tokens per use)
```

<p align="center"><img src=".github/assets/audit.svg" alt="repotify audit: keeps the skills that serve the project, suggests removing ones for other stacks or duplicate jobs, and flags a skill that fails the security scan" width="100%"></p>

## The website

[repotify.github.io/repotify](https://repotify.github.io/repotify/): 24 languages, one page per catalog item with public comments.

## Commands

| Command | What it does |
|---|---|
| `repotify` | Reads your project and installs the repotify skill for your agent |
| `repotify recommend` | Shows the picks for this project |
| `repotify questions` | Lists only the questions whose answer would change the picks |
| `repotify ui` | Draws the decision as a tree on a local page |
| `repotify install <ids…> --yes` | Installs the skills you choose |
| `repotify enable <id>` | Switches on a hook or MCP server, after showing you the change |
| `repotify audit` | Judges the skills and MCP servers you already have |
| `repotify track` | Says what changed in the project and which new picks fit |
| `repotify suggest` | Offers your own skill to the catalog |

Works with **Claude Code**, **Cursor**, **Codex**, **Gemini CLI** and any agent that reads `.agents/skills`. All commands, the security model and privacy: [docs/GUIDE.md](docs/GUIDE.md).

## Roadmap

- [x] Audit of installed skills, picks by evidence, Linux, macOS and Windows
- [x] Every skill classified by a decision model: main job, language, lifecycle, off-topic gate
- [x] Skills that pay off once are flagged when they have done their job
- [x] Website with per-skill comments
- [x] A catalog built from a crawl: every skill fetched once, classified, researched beyond its stars
- [x] MCP servers from the official registry, picked by real use
- [x] Questions that only ask what changes the picks; the decision drawn as a tree (`repotify ui`)
- [x] Hooks that keep the setup current and point the agent at the skill that fits
- [ ] The crawl running around the clock over thousands of repositories
- [ ] Rankings that learn from what developers keep and remove (measurement and the learner are built; the collection server is not live)
- [ ] MCP mode: your agent calls Repotify as a tool

## Contributing

Wrote a great skill? Run `repotify suggest` in its repository. Found a bug or a false alarm? [Open an issue](https://github.com/repotify/repotify/issues). Want to code? Start with [CONTRIBUTING.md](.github/CONTRIBUTING.md).

---

<p align="center">⭐ If Repotify helped your agent, a star helps other developers find it.<br><sub>MIT license · <a href="https://repotify.github.io/repotify/">Website</a> · <a href="https://www.npmjs.com/package/@repotify/repotify">npm</a> · <a href="CHANGELOG.md">Changelog</a> · <a href=".github/SECURITY.md">Security</a> · <a href="docs/i18n/README.tr.md">Türkçe</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a></sub></p>
