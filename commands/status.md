---
description: Show devin readiness plus exactly what a review would cover right now
argument-hint: '[--base REF] [--staged] [--uncommitted] [--json] [-- paths...]'
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git rev-parse:*)
---

Show two things at once: whether the toolchain is ready, and precisely what a
review would send if you ran one now. Spends **nothing**.

Arguments: $ARGUMENTS

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" status $ARGUMENTS
```

Add `--repo <absolute path to the repository>` if the shell's working directory
is not inside it. Claude Code starts commands in your project, so it never needs
this; Antigravity runs every command from its own scratch directory, so it
always does.

## What to do with it

Always exits **0** — it is a report, not a gate.

- **Scope line.** What would be reviewed, how many files, how many bytes. If it
  says the diff is large, suggest scoping with `-- <paths>` or `--staged` before
  running a panel: a large diff multiplied by three models is where cost and
  context limits actually bite.
- **Credential pre-flight.** `would BLOCK` means a review would exit 4. Show the
  user *before* they run it, not after.
- **Repo ships `.devin/config.json`.** Worth mentioning if the repository is not
  the user's own: project-level Devin config outranks the read-only config the
  reviewer runs with. In the normal case — their own repo, their own file — this
  is unremarkable and does not need alarming.
- **Repository hooks.** If `status` reports declared hooks, a review will refuse
  to run (exit 6) until the user passes `--allow-hooks`. Explain why rather than
  reaching for the flag: hooks execute shell commands at session start, outside
  the reviewer's permission model.
- **Repository MCP.** `a session would be BLOCKED` means project or local MCP
  config will start server commands before permissions exist. Explain the risk;
  `--allow-repo-mcp` is the user's override after inspection, not an automatic
  fix.
- **Not ready.** Send them to `/devin:setup` rather than diagnosing here.

`--json` gives the same content machine-readably.
