---
name: repotify
description: Sets this project up with a vetted, conflict-free "playlist" of agent skills, MCP servers and tools chosen for this exact repo. Use when the user pastes the Repotify link, asks which skills or tools to add, wants their coding agent upgraded for this project, or asks to update installed skills.
---

# Repotify

Recommend and install a small, conflict-free set of security-vetted skills and tools for THIS project. The `repotify` CLI does the heavy lifting (project scan, scoring, conflicts, context budget, security checks). Your job is judgment and a clear, short explanation.

`repotify <command>` below means: the launcher recorded in `repotify.lock.json` at `items.repotify.launcher` (for example `node "/path/to/repotify/bin/repotify.mjs"`), followed by the command.

## Flow

1. **Fingerprint.** Run `repotify fingerprint`. Use its summary; do not open source files for this step. If it lists installed skills or MCP servers, also run `repotify audit`: what earns its place, what to remove or fix, and why. Show that to the user with your picks; delete nothing without their OK.
2. **Intent, only if needed.** Run `repotify questions --json`. It lists only questions whose answer would change the picks (often none), most decisive first. Answer what you can from the fingerprint and the user's words; ask only what you cannot infer, at most 3 questions.
   - Claude Code: use the AskUserQuestion tool (project type: single choice; the others: multiSelect; at most 4 options per question).
   - Other agents: a short numbered list.
3. **Candidates.** Run `repotify recommend --type <projectType> --needs <a,b> --priorities <p> --stacks <s> --platforms <p>`, omitting flags you have no answer for. The table is conflict-free (one row per job), security-gated and within the context budget. ★ marks the default set; rows marked installed are already in the project and keep their job.
4. **Judge.** Think about the whole project, not only its stack: what would make this agent feel like a pro version for this repo? Keep every core item. Keep ★ items unless you have a concrete reason not to. You may add a non-★ row when the project clearly needs it. Never invent items: use only ids from the table.
   For every chosen item, write one sentence: what it is and why it matters for THIS project, citing a concrete fact (a dependency, a file, the user's goal).
5. **Present.**
   - Claude Code: AskUserQuestion with multiSelect, grouped as "Core", "For your stack", "For your mission" (add a fourth group only if needed), at most 4 options per question. Label = item name; description = your one-sentence reason plus badges: ✓ verified, ⚠ caution (say plainly what it does), 💎 gem, 🔥 trending, ⏳ pays off once (say so). Open with "Repotify picked these for your project because…".
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
- Never run `repotify enable` yourself: it belongs to the user.
- To take something out again: `repotify remove <id>`.
- Keep it brief: the user wants a great setup, not a lecture.

## Later sessions

- `repotify update --check` lists vetted updates for installed items and items that left the catalog. Apply only with the user's OK: `repotify update --apply <ids>`.
- Tracker hook on: a session may open with a `Repotify:` line (the project changed, or an update waits). Act on it with the user's OK.
- Router hook on: a request may carry a `Repotify router:` line naming installed skills. Decide for each whether it applies.
- `repotify ui` shows the user how picks are made (local, read-only).
- If the user wants their own skill or repository in the catalog, run `repotify suggest` in it and give them the link it prints: nothing is sent until they submit the form.
- At most once a week, after the user has actually used an installed item: if `repotify vote --due` prints `due`, ask one quick question ("Did <item> help? 👍/👎") and record it with `repotify vote <id> up|down`, or `repotify vote --dismiss` if they skip.
- Repotify records anonymous usage signals (item ids, stack and need categories, votes; never code, file names or repo names) on this machine only. Nothing is sent: `repotify sync` is the only way out, and it asks the user first. The user can turn recording off with `repotify telemetry off`.
