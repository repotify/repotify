<p align="center"><img src=".github/assets/banner.png" alt="repotify: thousands of agent skills, the right ones for your repo" width="100%"></p>

<h3 align="center">Thousands of agent skills. The right ones for your repo.</h3>

<p align="center">Repotify finds the agent skills developers publish on GitHub, vets each one for risk,<br>and installs the best picks for your project in Claude Code, Cursor, Codex or Gemini CLI.</p>

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

1. **Read.** It looks at your manifests and file names. Your code is never read or sent anywhere.
2. **Ask.** At most three quick questions, and only what the project doesn't already answer.
3. **Pick.** One best skill, MCP server or tool per job, from a catalog where every item passed a security scan and every skill was reviewed by three AI models.
4. **Install.** Each skill comes from a pinned commit, is hash-checked and scanned again on your machine. Hooks and MCP servers stay off until you switch them on.

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
| Checking trust | Skim install scripts and hope | Shell-aware scan plus an LLM jury |
| Fitting the project | Guess which ones apply | One pick per job, nothing overlapping |
| Staying lean | Context fills with unused instructions | Stays inside a context budget |

## Clean up what you already have

`repotify audit` looks at the skills already in your project and tells you which to keep and which to drop, with the reason. It never deletes anything.

<p align="center"><img src=".github/assets/audit.svg" alt="repotify audit: keeps the skills that serve the project, suggests removing ones for other stacks or duplicate jobs, and flags a skill that fails the security scan" width="100%"></p>

## Commands

| Command | What it does |
|---|---|
| `repotify` | Reads your project and installs the repotify skill for your agent |
| `repotify recommend` | Shows the picks for this project |
| `repotify install <ids…> --yes` | Installs the skills you choose |
| `repotify enable <id>` | Switches on a hook or MCP server, after showing you the change |
| `repotify audit` | Judges the skills you already have |
| `repotify suggest` | Offers your own skill to the catalog |

Works with **Claude Code**, **Cursor**, **Codex**, **Gemini CLI** and any agent that reads `.agents/skills`. All commands, the security model and privacy: [docs/GUIDE.md](docs/GUIDE.md).

## Roadmap

- [x] Audit of installed skills, picks by evidence, Linux, macOS and Windows
- [ ] A catalog of 1,000+ vetted skills, MCP servers and tools, found around the clock by an AI research lab
- [ ] Rankings that learn from what developers keep and remove
- [ ] MCP mode: your agent calls Repotify as a tool

## Contributing

Wrote a great skill? Run `repotify suggest` in its repository. Found a bug or a false alarm? [Open an issue](https://github.com/repotify/repotify/issues). Want to code? Start with [CONTRIBUTING.md](.github/CONTRIBUTING.md).

---

<p align="center">⭐ If Repotify helped your agent, a star helps other developers find it.<br><sub>MIT license · <a href="https://repotify.github.io/repotify/">Website</a> · <a href="https://www.npmjs.com/package/@repotify/repotify">npm</a> · <a href="CHANGELOG.md">Changelog</a> · <a href=".github/SECURITY.md">Security</a> · <a href="docs/i18n/README.tr.md">Türkçe</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a></sub></p>
