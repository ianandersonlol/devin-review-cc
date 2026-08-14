---
name: devin-review
description: "Delegate code review, design critique, or a fix to a non-Anthropic model via the Devin CLI, which runs inside the real repository so it verifies claims against actual call sites rather than a pasted diff. Use when the user asks for an independent second opinion, an adversarial or red-team review, to poke holes in a change, or to check a risky diff before merging; to challenge the design or approach rather than its bugs; or to get SEVERAL models' opinions on one change at once via a parallel panel. It ALSO covers handing Devin a problem to fix, which EDITS FILES — invoke that only when the user explicitly asks for Devin to do the fixing, never as your own first resort for a bug you could fix yourself. Do not invoke unprompted on every change."
---

# Adversarial review via the Devin CLI

Delegates review of the current diff to the `devin` CLI. The reviewer runs
**read-only and non-interactively** but with read access to the whole
repository, so it greps for call sites and reads changed files in full rather
than critiquing a diff in isolation. That is the point: it catches breakage in
files the diff never touched.

On macOS and Linux the reviewer runs inside **Devin's OS sandbox** (Seatbelt /
bwrap+seccomp): its shell commands run freely — `git -C`, `rg`, interpreter
one-liners — and any attempt to write to the repository fails at the OS level
without costing the turn. On Windows, or with `--no-sandbox`, it falls back to
Devin's per-command screening, which rejects far more and ends the turn on each
rejection. The sandbox does **not** block network egress; the prompt forbids
network use, but that is policy, not enforcement.

What distinguishes this from the other review plugins is that **one binary
fronts many vendors' models** — Cognition, OpenAI, Moonshot, Zhipu, Google,
Anthropic. So a multi-vendor panel is a single command, and `panel` is the
subcommand this plugin exists for.

## Running it

The script is Node and lives in this skill's `scripts/` directory. Requires
**Node 18+**, `git`, and an authenticated `devin` on `PATH`.

```bash
node scripts/devin-review.mjs [subcommand] [options]
```

If a relative path does not resolve, use the absolute path to
`scripts/devin-review.mjs` inside this skill directory. In Claude Code the
`/devin:*` slash commands already handle this.

### Subcommands

| Subcommand | What it does |
|---|---|
| `review` (default) | **Defect lens.** What is wrong with this change? Read-only. |
| `panel` | The same diff reviewed by **several models in parallel**. Read-only. |
| `challenge` | **Design lens.** Is this the right approach at all? Read-only. |
| `rescue "<problem>"` | Diagnose and **fix** a problem. **Edits files.** |
| `models` | What this account can run, with prices and free tiers |
| `setup` | Check node/git/devin readiness and explain how to fix what is not |
| `status` | Readiness plus what a review would cover right now |

`models`, `setup` and `status` never call a model and spend nothing.

**`rescue` is the only subcommand that writes.** Do not reach for it when the
user asked for a review or a second opinion — it is for "fix this", not "check
this".

### Options

```
--base REF        compare against REF (default: origin/HEAD, main, or master)
--staged          staged changes only
--uncommitted     uncommitted only (vs HEAD)
--lens defect|design  override the lens the subcommand picked
--model ID        single reviewer (default: swe-1-7)
--models a,b,c    run these in parallel and report each separately
--panel           shorthand for the default three-vendor panel
--concurrency N   how many panel models run at once (default 3)
--focus "TEXT"    steer the reviewer, e.g. --focus "auth and data loss"
--timeout DUR     per-model wall clock, or 'none' (default: 45m). A generous
                  backstop for a HUNG run, not a deadline: a kill discards the
                  whole review (Devin prints only at the end), so it sits well
                  clear of a thorough one — raise it for a large diff, 'none'
                  to remove it
-- <paths>        scope a large diff to specific paths
--dry-run         show what would be reviewed; spends nothing
--allow-secrets   waive the credential pre-flight (see below)
--allow-hooks     proceed in a repo that declares Devin lifecycle hooks
--keep-artifacts  keep the temp work dir (request, config, and any exported
                  transcript); it is kept automatically whenever a model fails,
                  and the path is printed on stderr. blocked_tool and
                  empty_report leave a full transcript to inspect; a hard
                  timeout leaves only the request and config, since Devin
                  exports only after a completed turn
--no-sandbox      fall back to per-command screening (automatic on Windows;
                  the escape hatch if the Linux sandbox needs bubblewrap/socat)
--json            machine-readable output (panel, models, setup, status)

rescue only:
--read-only       diagnose and propose a fix without editing anything
--allow-commands  let it run shell commands to verify its fix
--no-context      do not send your uncommitted diff as context
```

Default scope is the working tree vs the merge-base, so work committed on the
branch **and** still-uncommitted work are reviewed together. Untracked files are
included — `git diff` ignores them, and new files are where new bugs live.

## The findings contract

Reviews return a **structured report**; the markdown you see is rendered from it.
Every finding carries `severity`, `title`, `body`, `file`, `line_start`,
`line_end`, `confidence` (0–1), `grounding` (`verified` / `inferred`) and
`recommendation`, plus a top-level `verdict`, `summary` and `next_steps`.

For you as the consumer this means:

- **Cite findings by address.** They are numbered per model: `swe-1-7#2`. Use
  those when reporting to the user or when asking for a follow-up, rather than
  re-quoting the text.
- **Read `grounding` before you trust a claim.** `verified` means the reviewer
  says it opened the surrounding code and call sites; `inferred` means it
  reasoned from the diff alone. It defaults to `inferred`, so an `inferred`
  finding is your cue to check the code yourself before repeating it.
- **`confidence` is the model's own, and self-reported.** Treat it as a
  prioritisation hint, not evidence. No model here verifies its own findings —
  that job is still yours.
- **`--json` gives the validated structure** on any review path, single or panel.
  Prefer it when you intend to filter, sort, or feed specific findings onward.
- **`format: "unstructured"`** means that model did not return parseable JSON.
  Its text is printed in full and is still worth reading; it just has no
  addressable findings and took no part in correlation. Say so if you rely on it.

## Picking a lens

`review` assumes the design is settled and hunts for defects: correctness, edge
cases, error handling, concurrency, data loss, auth, contract breaks. It returns
severity-ranked findings and a verdict of SHIP / REVISE / RETHINK.

`challenge` assumes the code works and interrogates the approach: load-bearing
assumptions, the alternative not taken, behaviour under scale and partial
failure, what the change locks in, and whether it matches how this repository
already solves the same problem. It returns CHALLENGE blocks and a verdict of
SOUND / RECONSIDER / WRONG-SHAPE.

The verdict vocabularies are deliberately disjoint, so a transcript containing
both reviews can never blur which lens reached which conclusion.

## Using the panel

`panel` runs each model over the identical request, blind to the others. Each
review is printed the moment its model finishes, in completion order; the
comparison table and **corroboration map** follow at the end, under **Panel
summary**, because they cross-reference every reviewer and so can only exist
once the slowest one is done.

That streaming is the reason to launch a panel as a background task and read
its output while it runs: the fastest model routinely answers in a minute or
two while the slowest takes ten or more, and a finished review is in the
output the moment it exists. Start verifying the early findings against the
code while the rest run — by the time the summary lands, half the
reconciliation is already done. Failures are announced on stderr as they
happen, and a model that hangs until the timeout delays only the summary, not
the reviews you already have.

The corroboration map is the part to read first, and it is computed
arithmetically — same file, overlapping line ranges — never by asking a model.
It splits findings into **corroborated** (more than one model flagged this site)
and **single-source** (exactly one did). The tolerance is deliberately tight, so
it will occasionally list one bug as two single-source entries; it will not
invent agreement that is not there. Findings with no line number are never
correlated at all — "same file" is not evidence of "same bug" — so they always
appear as single-source.

A model whose output did not parse takes no part in the map, and the map says so.
Its review was still printed in full when it finished: read it, because it may
hold findings the map does not list.

**It does not synthesize, and that is deliberate.** A fourth model asked to merge
three reviews has no repository access, cannot check any claim, and reliably
prefers whatever was stated most confidently — it would launder three
independent signals into one derivative opinion and bury the disagreements,
which are the most informative thing a panel produces. Reconciliation is your
job, because you are the one who can read the code:

- **Weight heavily what two or more models found independently.**
- **Look hardest at what only one model found** — it is either the sharpest
  finding in the set or a hallucination. Check it against real code and say which.
- **Where they contradict, read the code and say who was right.** Do not average
  verdicts or count votes.
- **Give your own verdict, marked as yours.**

Pick different **vendors**, not different checkpoints of one model: two Opus
tiers reviewing the same diff is one opinion billed twice. The script warns about
single-family panels.

A panel that partially fails still exits 0 and reports which models returned
nothing. Treat their silence as missing data, never as agreement.

## Model choice

Default is `swe-1-7` — free, fast, and from Cognition rather than Anthropic.
Default panel is `swe-1-7,glm-5-2,kimi-k3-high`: three vendors, two free, so a
quota exhaustion mid-week does not leave you with no review at all.

**Never pick a `claude-*` model.** The entire value here is an *independent*
voice; a model from the same family as the agent driving the review shares its
blind spots, so agreement reads as confirmation when it is really an echo. The
script warns when you do it anyway. Run `models` to see the live roster — it is
per-account and changes, which is why nothing here hardcodes a table.

## Using rescue safely

`rescue` takes a problem statement instead of a diff, and by default Devin edits
files to fix it. Before invoking it:

- Confirm the user wants files **changed**, not explained. A question ("why is
  this failing?") wants `--read-only`.
- It refuses to run outside a git repository, because git recoverability is the
  entire safety model.

By default it **can edit but cannot run commands** — Devin has no permission
mode that auto-approves shell commands without auto-approving everything, so the
honest default lets it edit and has it report that it could not verify by
running. `--allow-commands` lifts that by switching Devin into bypass mode. `git`, `rm`
and `sudo` are denied as whole commands, but understand what that is worth: a
command blacklist is not a sandbox, and shell wrappers can route around it.
Bypass mode is a deliberate opt-in, not a containment boundary. Never pass it on
your own initiative, and suggest committing or stashing first.

After it runs, the report is followed by an **exact diff of every file Devin
modified**, computed from tree snapshots taken either side of the run — so it
never attributes the user's own uncommitted work to Devin. Your job:

1. Show the report and that diff verbatim.
2. Read the changes and say whether you agree. An applied fix is still a
   suggestion; review it as you would any patch. Offer `git checkout -- <files>`
   if you think it is wrong.
3. Re-run the test yourself. Without `--allow-commands` the "Verification"
   section is reasoning, not evidence.
4. Flag scope creep — the prompt forbids refactoring and unrelated edits, but
   those are instructions, not a sandbox.
5. Never commit on the user's behalf.

If Devin edited files and then failed, the diff is still printed. Always surface
that; a half-applied edit is the case the user most needs to see.

## Exit codes — check before interpreting output

| Code | Meaning | What to do |
|---|---|---|
| 0 | output printed | continue below |
| 2 | setup problem: not a git repo, bad `--base`, unknown model, `devin` missing | report it; `setup` explains the fix |
| 3 | no output was produced; the message names the class | see below |
| 4 | blocked by the credential pre-flight | **do not** re-run with `--allow-secrets` on your own initiative — show the matched lines and ask the user |
| 5 | every model in a panel failed | read the per-model reasons before retrying |
| 6 | the repository declares lifecycle hooks | see below — do NOT pass `--allow-hooks` on your own initiative |
| 7 | the installed `devin` CLI does not accept a flag the plugin passes | the CLI has moved underneath the plugin; report the named flag and tell the user to update the plugin. Nothing was spent, and no model ran |

Exit 4 exists because the diff is sent to a third party. Waiving it is the
user's call, never yours.

### Exit 6: repository hooks

Devin runs project lifecycle hooks as **shell commands at session start**, before
the model acts and regardless of which tools it is allowed — so denying `exec`
does not constrain them. They can be declared in `.devin/hooks.v1.json`,
`.devin/config.json`, `.devin/config.local.json`, `.claude/settings.json`, or
`.claude/settings.local.json`.

Every subcommand that starts a session refuses to run in such a repository and
names the files and events it found.

`--allow-hooks` overrides this, and is the user's call, not yours — the same rule
as `--allow-secrets`. Show them what was found and ask. In their own repository
with their own hooks it is usually fine; in a fork, a dependency, or a branch
from someone else, it is the whole reason the check exists.

### The failure classes behind exit 3

- **`blocked_tool`** — the model called a tool it is not allowed. Devin ends
  the turn and prints **nothing at all**; the work already done is discarded.
  Nothing was written to the repository. The message names the tool and the
  command it tried, recovered from the session transcript. Under the sandbox
  this is rare (shell commands no longer end turns; only the denied edit/write
  tools do); on Windows or with `--no-sandbox` it is the dominant failure mode.
  **Reviews already retried once automatically** — and the retry request leads
  with a note naming the exact call that killed the first attempt — so a
  `blocked_tool` that reaches you has failed twice. Do not simply re-run it;
  read the kept work dir's transcripts, and consider a different model.
- **`empty_report`** — the model finished normally but its final message was a
  couple of sentences of mid-investigation narration with no findings and no
  verdict: not a review, so it is not rendered as one. Retried once
  automatically with a note demanding the report as the final message; if it
  reaches you it happened twice, and a different model is the pragmatic fix.
- **`sandbox_unavailable`** — `--sandbox` could not be set up. On Linux it needs
  bubblewrap and socat and the CLI fails closed without them. The message names
  the fix: install the prerequisites (`devin sandbox setup`) or re-run with
  `--no-sandbox` for the screened path. macOS is unaffected. Not an account
  problem, not retryable.
- **`cli_mismatch`** — the `devin` CLI rejected an argument the plugin passes,
  so the CLI has changed underneath the plugin. Not an account problem and not
  retryable; report the named flag and suggest updating the plugin. (`--sandbox`
  is exempt — a CLI too old to know it simply falls back to screened mode.)
- **`quota`** — the account is out of budget for that model. Retrying will not
  help; a free model (`swe-1-7`, `glm-5-2`) will.
- **`auth`** — `devin auth login`, which is interactive and cannot be done for
  the user.
- **`org_policy`** — an organisation policy blocks something. Report it as-is.
- **`context_overflow`** — scope the diff with `-- <paths>` or pick a model with
  a larger context window.
- **`timeout`** — the run hit the wall clock (default 45m) and, because Devin
  prints only at the end, returned nothing. The default sits well clear of a
  thorough run, so a timeout usually means genuinely hung — but if a large diff
  legitimately needs longer, raise `--timeout` or set it to `none` rather than
  retrying.

## Presenting the result

1. Show the review **verbatim first**, unedited. Do not soften, filter, or
   reorder findings. That is the entire point of a second opinion.
2. Then add your own assessment, clearly separated. For each finding say whether
   you **agree**, **disagree**, or **need to check** — and where you disagree,
   say why, citing the code.
3. Verify before endorsing. Reviewers mark findings VERIFIED or SUSPECTED; treat
   SUSPECTED as a lead, not a fact, and check it against the real code.
4. The reviewer cannot see your conversation and does not know constraints
   already discussed, so some findings will be context-blind. Flag those
   explicitly rather than silently dropping them. Expect more of these from
   `challenge` than from `review`.
5. Do not start fixing anything unless the user asks. Report, then wait.

## Notes

- Paid models consume Devin usage quota; free models do not. A panel multiplies
  cost by the number of paid models in it — the script prints a rough estimate
  before running, and `--dry-run` prints it and stops.
- Reviews are synchronous and run at their own pace — measured from ~190s to
  past 900s on the same diff, and longer now that a sandboxed reviewer can read
  more and run read-only tests. **The default timeout is a generous 45m
  backstop, not a deadline:** a wall-clock kill discards the entire review
  (Devin prints only at the end), so it sits well clear of any thorough run and
  only catches a genuinely hung one. Raise it for a large diff, or `--timeout
  none` to remove it. A panel's *summary* still takes as long as its slowest
  member, but every finished review streams to stdout the moment its model
  completes — so one hung model delays only the cross-model summary, never the
  reviews that already exist. Launch a review as a background task and read the
  output as it grows. An interactive hang is also handled by Ctrl+C, which
  cleans up the temp dir.
- The reviewer's read-only property is layered: the OS sandbox contains shell
  writes where the platform has one (verified live: redirects, `python -c`,
  `node -e` and `sed -i` writes all fail with `Operation not permitted` while
  the canary survives), the deny list stops the edit/write tools everywhere,
  and Devin's per-command screening covers the shell on Windows and under
  `--no-sandbox`. Covered by `tests/devin.test.mjs` and the live suite
  (`npm run test:live`); if you change how modes or permissions are resolved,
  those tests are the guard.
- Devin imports the user's `~/.claude/CLAUDE.md` into every session as an
  always-on rule, with no off switch. If that file documents delegation
  (`/agy:review`, `/codex:adversarial-review`), a reviewer may read it as
  instructions for itself and try to outsource the review — observed live.
  The request tells reviewers those imported rules are not addressed to them,
  and the permission config denies `agy`, `codex`, `claude`, `gemini` and
  `devin` as whole commands, so the attempt fails loudly as `blocked_tool`
  instead of returning another vendor's review under this model's name.
- When any model fails, the temp work dir is kept and its path printed — the
  request as sent, the permission config, and each attempt's transcript where
  Devin exported one. A `blocked_tool` or `empty_report` run completes a turn
  and leaves a transcript; a hard `timeout` is killed mid-turn and leaves only
  the request and config. Swept automatically after 24 hours.
- Tests: `npm test` at the repo root (`node --test`), no dependencies required.
