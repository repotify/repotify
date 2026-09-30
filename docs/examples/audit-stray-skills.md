# Example: auditing a project full of stray skills

Real output from `repotify audit` on a Next.js invoicing app (Stripe, pdfkit) whose `.claude/skills` folder had
collected skills over time: some useful, some for other stacks, two doing the same job, and one copied from a random
repository. None of them was installed by Repotify.

```text
$ repotify audit
.claude/skills: 8 skills, 639 chars of always-on context
  keep     changelog-writer                No sign it is out of place here.
  REMOVE   cloud-helper                    Security scan: rejected (credential-access). Remove it.  (-31 chars)
  consider flutter-widgets                 Written for flutter, which this project does not use.  (-92 chars)
  keep     pdf-invoices                    Serves PDF reading and generation.
  consider pptx                            Slide decks: nothing in this project needs it.  (-52 chars)
  consider react-native-skills             Built for react-native, expo, which this project does not use.  (-83 chars)
  consider release-notes                   Does the same job as changelog-writer (near-identical description); keep one.  (-111 chars)
  keep     test-driven-development         Tests written first are the agent's main defence against confident but wrong code.
  Removing the suggested ones frees 369 chars of always-on context.

Nothing was deleted. Ask the user before removing anything.
Other folders to delete once the user agrees: .claude/skills/cloud-helper, .claude/skills/flutter-widgets, .claude/skills/pptx, .claude/skills/react-native-skills, .claude/skills/release-notes
```

What each verdict means:

- **REMOVE** `cloud-helper`: the security scan rejects it (it reads cloud credentials). This is the one to delete now.
- **consider** `flutter-widgets` and `react-native-skills`: written for stacks this project does not use. Their
  descriptions sit in the agent's context in every session for nothing.
- **consider** `pptx`: slide decks; nothing in this project makes them.
- **consider** `release-notes`: the same job as `changelog-writer`; Repotify keeps the lighter one.
- **keep** `pdf-invoices`: the project depends on `pdfkit`, so a PDF skill earns its place. `test-driven-development` is
  part of the core.

Nothing is deleted by the audit. An agent following the Repotify skill shows this to the user and removes folders only
after they agree; items Repotify installed itself come with `repotify remove <id>` instead of a folder path.
