---
name: repotify
description: Sets this project up with a vetted, conflict-free "playlist" of agent skills, MCP servers and tools chosen for this exact repo. Use when the user pastes the Repotify link, asks which skills or tools to add, wants their coding agent upgraded for this project, or asks to update installed skills.
---

# Repotify

Recommend and install a small, conflict-free set of security-vetted skills and tools for THIS project. The `repotify` CLI does the heavy lifting (project scan, scoring, conflicts, context budget, security checks). Your job is judgment and a clear, short explanation.

`repotify <command>` below means: the launcher recorded in `repotify.lock.json` at `items.repotify.launcher` (for example `node "/path/to/repotify/bin/repotify.mjs"`), followed by the command.

## Flow

1. **Fingerprint.** Run `repotify fingerprint`. Use its summary; do not open source files for this step. If it lists installed skills, also run `repotify audit`: it says which ones earn their place and which to remove, with reasons and token cost (a once-skill like a codebase map is flagged after two weeks: it has done its job but still costs tokens every session). Show that to the user with your picks; delete nothing without their OK.
2. **Intent, only if needed.** Run `repotify questions --json`. Answer each question yourself from the fingerprint and from what the user already said. Ask the user only what you cannot infer, at most 3 questions.
   - Claude Code: use the AskUserQuestion tool (project type: single choice; priorities and needs: multiSelect; at most 4 options per question, so offer the 4 most plausible).
   - Other agents: a short numbered list.
3. **Candidates.** Run `repotify recommend --type <projectType> --needs <a,b> --priorities <p>`, omitting flags you have no answer for. The table is already conflict-free, security-gated and within the context budget. ★ marks the default set.
4. **Judge.** Think about the whole project, not only its stack: what would make this agent feel like a pro version for this repo? Keep every core item. Keep ★ items unless you have a concrete reason not to. You may add a non-★ row when the project clearly needs it. Never invent items: use only ids from the table.
   For every chosen item, write one sentence: what it is and why it matters for THIS project, citing a concrete fact (a dependency, a file, the user's goal).
5. **Present.**
   - Claude Code: AskUserQuestion with multiSelect, grouped as "Core", "For your stack", "For your mission" (add a fourth group only if needed), at most 4 options per question. Label = item name; description = your one-sentence reason plus badges: ✓ verified, ⚠ caution (say plainly what it does), 💎 gem, 🔥 trending, ⏳ pays off once (say so: useful now, `repotify audit` will say when to remove it). Open with "Repotify picked these for your project because…".
   - Other agents: a numbered list; the user replies "all" or "1,3,5".
6. **Install.** Run `repotify install <ids...> --yes`. It installs skills.
   - ⚙ items (hooks, MCP servers) change how you yourself run, so you never switch them on. The install output prints `repotify enable <id>`: give the user that command to run themselves (in Claude Code they can type `! <command>`). After an MCP server is enabled, the agent needs a restart.
   - ⚠ caution items need the user's explicit OK for that item: show the finding first, then add `--accept-caution`.
   - Tools are never run automatically: show their steps and let the user run them.
   - If an id fails, report the reason; do not retry with other names.
7. **Report.** One short summary: what was installed where, and any manual step left.

## Rules

- Install only ids that appear in `repotify recommend` output. Never install other packages or skills through Repotify.
- Never bypass the security gate, and never edit `repotify.lock.json` by hand.
- Never run `repotify enable` or `repotify update --enable-auto-check` yourself: they belong to the user.
- To take something out again: `repotify remove <id>`.
- Keep it brief: the user wants a great setup, not a lecture.

## Later sessions

- `repotify update --check` lists vetted updates for installed items and items that left the catalog. Apply only with the user's OK: `repotify update --apply <ids>`. If the user wants a weekly reminder, give them `repotify update --enable-auto-check` to run once.
- If the user wants their own skill or repository in the catalog, run `repotify suggest` in it and give them the link it prints: nothing is sent until they submit the form.
- At most once a week, after the user has actually used an installed item: if `repotify vote --due` prints `due`, ask one quick question ("Did <item> help? 👍/👎") and record it with `repotify vote <id> up|down`, or `repotify vote --dismiss` if they skip.
- Repotify sends anonymous usage signals (item ids, stack and need categories, votes; never code, file names or repo names) to rank items. The user can turn this off with `repotify telemetry off`.
