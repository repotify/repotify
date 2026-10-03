---
name: dependency-care
description: Keeps dependencies current without breaking the build.
---

# Dependency care

## Anti-patterns

| Anti-pattern | Problem | Do instead |
|---|---|---|
| Update everything at once | Hard to debug | Update incrementally |
| Ignore security alerts | Vulnerabilities | Address by severity |
| Push to main without asking for review | Broken builds | Open a pull request |
