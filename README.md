# devin — adversarial review plugin

Independent adversarial code review via the [Devin CLI](https://docs.devin.ai/cli),
with read access to your real repository — and, because one CLI fronts many
vendors' models, the ability to run **several reviewers over the same diff at
once**.

Works in both Claude Code and Codex.

## Usage

```
/devin:review                            # working tree vs origin/HEAD (or main/master)
/devin:review --base v1.4.0              # against a specific ref
/devin:review --staged                   # staged changes only
/devin:review --uncommitted              # uncommitted only (vs HEAD)
/devin:review --focus "auth, data loss"  # steer the reviewer
/devin:review --model kimi-k3-high       # escalate to a stronger reviewer
/devin:review -- src/billing             # scope to paths
/devin:review --dry-run                  # what would be reviewed; spends nothing
/devin:review --allow-hooks              # proceed in a repo that declares hooks

/devin:panel                             # THE FEATURE: 3 vendors, in parallel
/devin:panel --models swe-1-7,gpt-5-6-sol-high,kimi-k3-high
/devin:panel --concurrency 2             # bound how many run at once

/devin:challenge                         # challenge the design, not the bugs
/devin:models                            # what can this account run, and what does it cost?
/devin:setup                             # is the toolchain ready? how do I fix it?
/devin:status                            # readiness + what a review would cover

/devin:rescue "the login test fails"     # diagnose and FIX — this one edits files
/devin:rescue "why is this slow" --read-only   # diagnose only, edits nothing
```

Or directly, with no plugin machinery at all:

```bash
node /path/to/devin-review-cc/skills/devin-review/scripts/devin-review.mjs panel --base main
```

## Why a panel

Every other review plugin gives you one model's opinion. The Devin CLI reaches
Cognition's SWE models, OpenAI's GPT-5.6, Moonshot's Kimi K3, Zhipu's GLM, and
Anthropic's Claude through a single binary — so `panel` runs several of them over
the identical diff, in parallel, each blind to the others.

```
| Model          | Verdict | Findings              | Time |
| -------------- | ------- | --------------------- | ---- |
| swe-1-7        | REVISE  | 1 CRITICAL, 1 HIGH    | 23s  |
| glm-5-2        | REVISE  | 1 CRITICAL, 1 MEDIUM  | 13s  |
| kimi-k3-high   | — (quota) | —                   | 2s   |
```

…followed by each review in full.

…and, above the reviews, a **corroboration map**:

```
**Corroborated — 2 site(s) flagged by more than one model.**
- `calc.py:1-2` — 2 models (swe-1-7, glm-5-2), max severity CRITICAL
  - `swe-1-7#1` `add` returns `a - b` instead of `a + b`.
  - `glm-5-2#1` add() returns a-b instead of a+b, inverting its documented behavior

**Single-source — 1 site(s) flagged by exactly one model.**
Each is either the sharpest finding in the set or a hallucination.
```

That map is computed arithmetically — same file, overlapping line ranges — never
by asking a model. **The panel does not merge or summarise the reviews, on
purpose.** Handing three reviews to a fourth model and asking for "the consensus"
produces a reviewer with no repository access, no ability to check any claim, and
a strong bias toward whatever was phrased most confidently. It would launder
three independent signals into one derivative opinion and hide the disagreements
— the most useful thing a panel produces. Correlation is arithmetic; adjudication
is left to whoever can read the code.

Pick different **vendors**, not different checkpoints of one model: two Opus
tiers reviewing the same diff is one opinion billed twice. The tool warns about
single-family panels, and about `claude-*` models, which correlate with the
assistant orchestrating the review and therefore share its blind spots.

The default panel is `swe-1-7,glm-5-2,kimi-k3-high` — three vendors, two of them
free. That is a robustness choice as much as a cost one: paid capacity is what
runs out mid-week, and a default panel that returns nothing the moment a quota
trips is a default panel nobody trusts. A partially failed panel still prints
what it got and names what it lost.

## The findings contract

The **structured report is the source of truth**; the markdown is a rendering of
it. Models are asked for one JSON object, modelled on the Codex plugin's review
schema:

```json
{
  "verdict": "SHIP" | "REVISE" | "RETHINK",
  "summary": "A terse ship/no-ship assessment.",
  "findings": [{
    "severity": "critical" | "high" | "medium" | "low",
    "title": "...", "body": "...", "recommendation": "...",
    "file": "billing.py", "line_start": 88, "line_end": 94,
    "confidence": 0.82, "grounding": "verified" | "inferred"
  }],
  "next_steps": ["..."]
}
```

Only the **envelope** is structured. `body` and `recommendation` are free prose
with no shape imposed, because constraining a reviewer's *argument* to a schema
makes the argument worse — the fields exist so findings can be sorted, addressed
and correlated, not to discipline the thinking.

Three consequences worth knowing:

- **Findings are addressable.** `swe-1-7#2` refers to one specific claim, so a
  review can be discussed without quoting it back.
- **`grounding` is reported and used.** `verified` means the reviewer opened the
  call sites; `inferred` means it reasoned from the diff. It defaults to
  `inferred` when a model omits it — never to `verified`.
- **`confidence` is displayed, not swallowed.** The Codex plugin requires a
  confidence score on every finding and then never renders it; here it is shown,
  and a missing one shows as `n/a` rather than a fabricated 0.5.

Devin cannot enforce a schema the way the Codex CLI can, so the parser is
forgiving: fenced or bare JSON, preamble prose tolerated, one malformed finding
dropped rather than the whole report, and output that will not parse at all is
still printed in full with a caveat. `--json` gives you the validated structure
on every review path, single or panel.

## Two lenses

`review` and `challenge` ask genuinely different questions, so they have
different output contracts. Both work with `--panel`.

| | `/devin:review` | `/devin:challenge` |
|---|---|---|
| Question | What is **wrong** with this? | Is this the **right shape**? |
| Assumes | design is settled | code works, tests pass |
| Looks for | correctness, edge cases, error handling, concurrency, data loss, auth, contract breaks | load-bearing assumptions, the alternative not taken, behaviour under scale and partial failure, what it locks in, fit with the existing codebase |
| Output | `### HIGH <claim>` + Where / Failure / Confirmed / Fix | `### CHALLENGE <claim>` + Assumption / Breaks when / Confirmed / Alternative |
| Verdict | SHIP · REVISE · RETHINK | SOUND · RECONSIDER · WRONG-SHAPE |

The verdict vocabularies are deliberately disjoint: a transcript can contain both
reviews, and the reconciler must never have to guess which lens reached which
conclusion.

Both lenses demand a concrete failure condition on every finding and drop
anything unfalsifiable, and both mark each finding VERIFIED (established by
reading the code) or SUSPECTED (inferred from the diff).

## How the reviewer is kept read-only

This is the property the tool rests on, so it is worth being precise about what
enforces it — and what does not.

1. **Non-interactive mode is the real guarantee.** Devin's Normal permission
   mode auto-approves read-only tools and requires human approval for every
   write and every shell command. In `--print` mode there is no human, so those
   calls are rejected outright. A reviewer cannot write to your repository
   because there is nobody there to say yes.
2. **An explicit deny list**, passed via `--agent-config`, blocks `edit`,
   `write`, `notebook_edit`, `exec`, `write_to_process`, `run_subagent`,
   `request_scope`, `mcp_call_tool` and the `Write(**)` scope. Deny rules are
   evaluated before allow rules.
3. **System instructions** tell the model plainly that it has no shell.
4. `allowed-tools` is also set, but **nothing here relies on it** — in testing it
   did not actually restrict the toolset.

Mode selection lives in exactly one function (`resolveMode`) so the invariant can
be tested in exactly one place. Only `rescue`, and only without `--read-only`,
ever yields a writing mode.

### What the permission model does *not* cover: repository hooks

Devin runs **project lifecycle hooks as shell commands** — at session start,
before the model does anything, and regardless of which tools the agent is
allowed. Denying `exec` does not touch them. Hooks can be declared in
`.devin/hooks.v1.json`, `.devin/config.json`, `.devin/config.local.json`, and —
because Devin reads Claude Code's settings too — `.claude/settings.json` and
`.claude/settings.local.json`.

This was found by adversarial review and confirmed by reproduction: a
`SessionStart` hook in a scratch repository wrote a file during a review that had
`exec` and `Write(**)` denied.

So `devin-review` **refuses to start a session in a repository that declares
hooks** (exit 6), naming the files and events it found. Warning would be the
wrong response — the commands run before anyone reads a warning. Detection keys
on an actual hook *declaration*, not on a config file existing, since nearly
every repository worth reviewing has a `.claude/settings.json`; an unparseable
config that mentions hooks fails closed. `--allow-hooks` proceeds anyway, for
the common case where the hooks are yours.

This is the honest boundary. Reviews are read-only with respect to the
*reviewer's tools*; hooks are a separate execution channel, and the tool's answer
to them is refusal rather than a guarantee it cannot make.

### The failure mode you will actually hit

When Devin rejects an unapproved tool call in print mode, it **ends the turn and
prints nothing at all** — exit 0, empty stdout, everything the model had worked
out discarded. So a reviewer that idly reaches for `git log` does not produce a
slightly worse review; it produces no review, and you pay for the tokens anyway.

That is why the prompt is so insistent about the missing shell, and why the tool
classifies this case as `blocked_tool` with an explanation rather than shrugging
at an empty result. A single retry usually succeeds.

## Rescue: the one command that writes

`review`, `panel` and `challenge` critique a diff. `rescue` takes a **problem
statement** instead — "the login test fails after my change" — reads the
repository, diagnoses the root cause, and **edits files to fix it**.

It refuses to run outside a git repository, because git recoverability is the
entire safety model, and it never touches staging or history. Its report ends
with an exact diff of every file it changed, computed from working-tree
snapshots taken either side of the run, so your own uncommitted work is never
attributed to it.

**On verification:** by default rescue can edit files but cannot run commands.
Devin offers no permission mode that auto-approves shell commands without also
auto-approving everything else, so the honest default is to let it edit and have
it say plainly that it could not verify by running.

`--allow-commands` lifts that by switching to bypass mode. `git`, `rm` and `sudo`
are denied outright — `git` as a whole command, not a list of subcommands, because
an enumerated list missed `git clean`, and `git clean -fd` destroys untracked
files, which is the one class of change git cannot give back and therefore the
one that breaks the recovery model this tool depends on.

Be clear-eyed about what that denial is worth: **a command blacklist is not a
sandbox.** It removes the direct route, and a determined agent could still reach
git through `sh -c`, `env`, or an absolute path. Bypass mode is a deliberate
opt-in, not a containment boundary. Commit or stash before using it, and read the
diff afterwards. The no-refactor and no-weakening-tests rules are prompt-level
instructions, not enforcement, for the same reason.

## Requirements

Node 18+, `git`, and an authenticated `devin` on `PATH`. That makes it a local
toolchain: it works in Claude Code and local Cowork, but not in cloud Cowork,
claude.ai/code, or chat.

```bash
/devin:setup     # checks all of the above and names the specific fix
```

Authentication is `devin auth login`, an interactive browser flow.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | output printed |
| 2 | setup problem: not a git repo, bad `--base`, unknown model, `devin` missing |
| 3 | no output produced — see the named class below |
| 4 | blocked by the credential pre-flight |
| 5 | every model in a panel failed |
| 6 | the repository declares lifecycle hooks (see above); `--allow-hooks` overrides |

Exit 3 names why: `blocked_tool` (the reviewer reached for a denied tool — retry
usually works), `quota` (out of budget for that model; a free model still
works), `auth`, `org_policy`, `context_overflow`, or `empty_output`.

On exit **4**, do not re-run with `--allow-secrets` unprompted. The diff leaves
your machine, so waiving the scan is the user's call.

## Cost

Paid models consume Devin usage quota; `swe-1-7` and `glm-5-2` are free. A panel
multiplies cost by the number of paid members, so the tool prints a rough
estimate before it runs and `--dry-run` prints it and stops. `models` shows live
per-MTok pricing read from your account rather than a hardcoded table.

## Prior art

This is a sibling of [agy-review](https://github.com/ianandersonlol/agy-review)
(Gemini via the Antigravity CLI), and both descend from the structure of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). The diff
collection, credential pre-flight, temp-file handling and rescue snapshotting are
shared lineage; the panel, the model roster, and the permission model are
specific to Devin.

Running all three on a genuinely risky change gives you four labs' opinions.
Reconcile them yourself — never ask one tool to produce another's.

## Tests

```bash
npm test    # node --test, no dependencies
```

MIT.
