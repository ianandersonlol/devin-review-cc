---
description: Hand a problem to Devin to diagnose and fix — this one edits your files
argument-hint: '"<problem statement>" [--read-only] [--allow-commands] [--no-context] [-- paths...]'
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git diff:*), Bash(git rev-parse:*), AskUserQuestion
---

Delegate a **problem** to Devin, rather than a diff. It reads the repository,
diagnoses the root cause, and edits files to fix it.

**This is the only devin command that writes to your working tree.**
`/devin:review`, `/devin:panel` and `/devin:challenge` are read-only by
construction and stay that way.

Arguments: $ARGUMENTS

## Before running

1. **Confirm the user actually wants files edited.** If the request reads like a
   question ("why is this slow?", "what's causing this?") rather than an
   instruction to fix, prefer `--read-only`, which diagnoses and proposes
   without touching anything. When genuinely ambiguous, use `AskUserQuestion`
   once: `Fix it (edits files)` / `Diagnose only (--read-only)`.

2. **Check the tree is recoverable.** Run `git status --short`. Rescue refuses
   to run outside a git repository, but a repo with a large pile of uncommitted
   work is still worth flagging: Devin's edits will land alongside it. Mention
   it and let the user decide; do not commit or stash on their behalf.

## Running it

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" rescue $ARGUMENTS
```

Bare words are the problem statement. `--` still introduces path scoping, so
`rescue "tests fail" -- src/auth` narrows the context diff to `src/auth`.

Exit codes match the other commands: **0** report printed · **2** setup problem
(not a git repo, devin missing) · **3** no report (`blocked_tool`, `quota`,
`auth`) · **4** blocked by the credential pre-flight on your context diff ·
**6** the repository declares lifecycle hooks.

On **3** with `blocked_tool`, do not assume nothing changed: Devin may have
edited files and *then* reached for a denied command. The change diff is printed
regardless — read it.

## The shell question

By default rescue **can edit files but cannot run commands.** Devin has no
permission mode that auto-approves shell commands without also auto-approving
everything else, so the honest default is to let it edit and have it report
plainly that it could not verify the fix by running it. The prompt tells it to
say so rather than to claim otherwise.

`--allow-commands` lifts that, at a real cost: it switches Devin into its bypass
mode, where every tool auto-approves. `git`, `rm` and `sudo` are denied as whole
commands — `git` entirely, because `git clean -fd` destroys untracked files and
that is the one thing the "just revert it" recovery model cannot undo.

Say plainly what that denial is and is not: **a command blacklist is not a
sandbox**, and shell wrappers can route around it. Offer the flag when
verification genuinely matters — a flaky test, a fix that cannot be judged by
reading — suggest committing or stashing first, and never pass it on your own
initiative.

## After it runs

The command prints Devin's report (Root cause / Change made / Verification /
Risks and gaps) followed by an **exact diff of every file it modified**. That
diff is computed from tree snapshots taken immediately before and after the
run, so it shows Devin's changes only — never the user's own uncommitted work.

Your job:

1. **Present the report and the diff verbatim.** Do not summarize the diff away.
2. **Read the changes yourself and say whether you agree.** A rescue fix is a
   suggestion that happens to already be applied, not a verdict. Check it
   against the surrounding code the same way you would review a patch. If you
   think it is wrong or papers over the real problem, say so plainly and offer
   to revert: `git checkout -- <files>`.
3. **Verify independently.** Run the relevant test yourself. This matters more
   here than in other rescue tools, because without `--allow-commands` Devin
   could not run anything at all — its "Verification" section is reasoning, not
   evidence.
4. **Flag scope creep.** The prompt forbids refactoring, reformatting, and
   unrelated edits. If the diff contains any, call it out — that is a signal the
   fix wandered.
5. **Never commit on the user's behalf.** Rescue deliberately leaves staging and
   history untouched so the decision stays theirs.

If Devin exited non-zero or produced no report, the change diff is **still
printed** when it had already edited something. Always surface that — a
half-applied edit is exactly the situation the user must know about.

## Notes

- `--read-only` runs the same diagnosis on the reviewer permissions: edit
  tools denied, and on macOS/Linux a read-only OS sandbox where commands run
  but cannot write to the repository. It is the right default for "explain
  this to me".
- Your uncommitted diff is sent as context by default, since the problem is
  often in it. `--no-context` omits it. The credential pre-flight applies to
  that context exactly as it does for a review.
- Rescue takes a single `--model`; a multi-model panel is refused, because two
  agents editing one working tree would interleave their changes into a patch
  neither intended.
- Devin is told never to touch git history, never to weaken a test into passing,
  and to make the smallest change that fixes the problem. The git denials are
  enforced by the permission layer; the rest are prompt-level constraints —
  which is why you review the diff.
