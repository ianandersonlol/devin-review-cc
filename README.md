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
/devin:review --allow-repo-mcp           # proceed in a repo that configures MCP servers

/devin:panel                             # THE FEATURE: 4 vendors, in parallel
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
Moonshot's Kimi K3, xAI's Grok, DeepSeek, Zhipu's GLM, Cognition's SWE models,
OpenAI's GPT-5.6 and Anthropic's Claude through a single binary — so `panel` runs
several of them over the identical diff, in parallel, each blind to the others.

From a real run of `--models swe-1-7,glm-5-2,kimi-k3-high`:

```
| Model          | Verdict | Findings              | Time |
| -------------- | ------- | --------------------- | ---- |
| swe-1-7        | REVISE  | 1 CRITICAL, 1 HIGH    | 23s  |
| glm-5-2        | REVISE  | 1 CRITICAL, 1 MEDIUM  | 13s  |
| kimi-k3-high   | — (quota) | —                   | 2s   |
```

Each review streams to stdout the moment its model finishes — the fastest
model's findings are readable while the slowest is still working — and the
**Panel summary** (that table, plus a **corroboration map**) is printed at the
end, once every reviewer is accounted for:

```
**Corroborated — 2 site(s) flagged by more than one model.**
- `calc.py:1-2` — 2 models (swe-1-7, glm-5-2), max severity CRITICAL
  - `swe-1-7#1` `add` returns `a - b` instead of `a + b`.
  - `glm-5-2#1` add() returns a-b instead of a+b, inverting its documented behavior

**Single-source — 1 site(s) flagged by exactly one model.**
Each is either the sharpest finding in the set or a hallucination.
```

That map is computed arithmetically — same file, overlapping line ranges — never
by asking a model, and it is tuned to under-merge. Fabricating agreement would
forge the one signal a panel exists to produce, so a finding with no line number
is never correlated at all: "same file" is not evidence of "same bug". **The panel does not merge or summarise the reviews, on
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

The default council is `kimi-k3-high,grok-4-6-high,deepseek-v4-flash-high,glm-5-2`
— four vendors: Moonshot, xAI, DeepSeek, Zhipu. Spreading across four accounts is
a robustness choice as much as a decorrelation one: paid capacity is what runs
out mid-week, and one provider having a bad hour costs you a quarter of the
council rather than the council. A partially failed panel still prints what it
got and names what it lost. `glm-5-2` is free; the other three run a few tens of
cents on a normal diff, and `--dry-run` prices it before you spend anything.

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
| `body` holds | a concrete failure: inputs, then the wrong result | the assumption, and the condition under which it breaks |
| `recommendation` holds | the smallest safe fix | the alternative approach, and what it costs |
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

1. **The OS sandbox** (`--sandbox`: macOS Seatbelt, Linux bwrap+seccomp) is the
   strongest layer, used everywhere the platform supports it. Combined with our
   `Deny(Write(**))` rule, the repository is read-only to the reviewer's shell
   at the **syscall level**: verified live, `echo x > target`, `python3 -c
   "open(...,'w')"` and `sed -i` all fail with `Operation not permitted` while
   the file survives — and, crucially, the failed command does **not** end the
   turn. Windows has no sandbox (the flag hard-fails there), and `--no-sandbox`
   opts out, e.g. on a Linux box without bubblewrap/socat, where Devin fails
   closed rather than running unsandboxed.
2. **An explicit deny list**, passed as `permissions.deny` in the config given
   to `--config`, blocks `edit`, `write`, `notebook_edit`, `write_to_process`,
   `run_subagent`, `request_scope`, `mcp_call_tool` and the `Write(**)` scope.
   Deny beats allow and beats the permission mode, and it held in testing
   against a repo-local `.devin/config.json` that tried to allow what we deny.
   On the non-sandboxed paths this is the real guarantee that files cannot be
   edited.
3. **Devin's command classifier**, via `--permission-mode auto`, is what governs
   the *shell* when the sandbox is off. It judges each command: `ls` and `git
   log` are approved, `echo x > f` is rejected — and each rejection ends the
   turn. With the sandbox on, Devin instead auto-approves shell commands and
   lets the sandbox contain them, which is why sandboxed reviewers may run
   `git -C`, `rg` and interpreter one-liners that the classifier refuses.
4. **The prompt** states the boundary, so the model does not waste a turn
   discovering it. Since Devin removed `system-instructions` along with
   `--agent-config`, this is now the only channel for it. It has two variants,
   because the sandboxed and screened worlds have different rules.

**What the sandbox does not cover:** network egress. `curl` ran to completion
inside a sandboxed session during verification. The prompt forbids network use
— a reviewer reads **untrusted diffs**, and a prompt-injected "to verify this,
run `curl …`" in a stranger's PR is the delivery mechanism to worry about — but
that is policy, not enforcement. Devin has domain filtering under the
`sandbox.*` config keys; its docs call it unstable, so this plugin does not set
it, and preserves yours if you do. The screened (non-sandbox) path rejects
network commands outright, as before. Also outside the sandbox: writes to the
system temp directory succeed (Seatbelt-style profiles allow process scratch
space); the repository is what the guarantee is about.

**A reviewer has a read-only shell, not no shell.** `exec` appears in
**neither** the allow list nor the deny list, and that is load-bearing rather
than an oversight. Putting a tool in `permissions.allow` *auto-approves* it:
with `exec` allowed, Devin ran `echo pwned > file` and wrote the file even
under `--permission-mode auto`, with no sandbox to catch it. The same
permission object serves both the sandboxed and screened paths, so it is built
for the weaker one. `write_to_process` stays denied for the mirror-image reason
— the classifier judges a command *string*, so `exec("python3")` reads as
read-only, and being able to type into that process afterwards would be an
unclassified shell.

The evasions are tested rather than assumed. `npm run test:live` runs a real
reviewer against the installed CLI and asserts it cannot edit a file, cannot
write one through the shell, cannot write through an interpreter
(`python3 -c`, `node -e`), a nested shell (`sh -c '… > f'`) or an in-place
editor (`sed -i`) — and can still run `ls`. The sandboxed variants assert the
same canary survives **and** that the turn does: a contained write failure must
cost an error message, not the review.

Mode selection lives in exactly one function (`resolveMode`) so the invariant can
be tested in exactly one place. Only `rescue`, and only without `--read-only`,
ever yields a writing mode.

### The CLI moves underneath the plugin

The Devin CLI auto-updates. In 3000.4.16 it removed `--agent-config`, which this
plugin passed as the *first* argument on every invocation — so every model in a
panel died at argv parsing with the same `unexpected argument` error, which reads
like a broken plugin rather than a CLI that moved.

So before any session starts, `devin-review` reads `devin --help` and checks that
every flag it is about to pass still exists, refusing with exit 7 and naming the
missing flag if not. `devin-review setup` reports the same thing. Probing beats
pinning a version: it asks the binary in front of it what it actually supports.
If `--help` cannot be read at all, the run proceeds — refusing to review code
because a help screen would not parse is worse than the problem.

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

### Repository MCP servers are also a pre-session execution channel

Devin loads project MCP configuration from `.devin/mcp_config.json` and local
project configuration from `.devin/mcp_config.local.json`. A configured stdio
server command starts while the session connects—before the model acts and
before any tool permission is checked. A panel can start it once per worker.

`devin-review` therefore refuses to start any session in a repository carrying
either file (exit 8), including on the existing print transport. The error names
the files. `--allow-repo-mcp` is the explicit override for repositories whose
servers you have inspected and trust. This is separate from `mcp_call_tool` in
the reviewer deny list: that rule concerns model tool calls after startup and
cannot contain the server process that has already launched.

### The failure mode you used to hit constantly

When Devin refuses a tool call in print mode, it **ends the turn and prints
nothing at all** — exit 0, empty stdout, everything the model had worked out
discarded. So a reviewer that reaches for a tool it does not have produces no
review, and you pay for the tokens anyway. The sandbox exists to make this
rare — a contained command *fails* instead of being *refused* — but the denied
edit/write tools still end turns everywhere, and on Windows or `--no-sandbox`
every screened rejection still does.

The two ways this happens are not equally visible, which is the part that made it
hard to diagnose. A call rejected for *needing confirmation* prints a warning to
stderr. A call blocked by our own **deny list prints nothing whatsoever** — exit
0, empty stdout, empty stderr — so classifying on stderr alone reported the deny
list as a generic "returned no output" and sent you looking for a network fault.

Every run therefore passes `--export`, which writes the session transcript as
JSON, and that transcript is the only witness to what the model actually tried.
The tool reads it, classifies the run as `blocked_tool`, and names the tool and
the command:

```
swe-1-7 produced nothing [blocked_tool] — retrying once with a corrective note...
```

**Reviews retry once, automatically — and the retry is not a blind re-send.**
The naive version was measured failing: a model whose *first* move is
deterministically the denied one (glm-5-2 opens by introspecting installed
packages through an interpreter) fails an identical second request identically.
So the retry request now leads with a note naming the exact call that killed
attempt one and pointing at the file-read route instead, and it exports its
transcript to a separate path so the first attempt's evidence survives. The
retry is reported rather than silent, so a model that is reliably failing does
not hide behind a review that looks like it cost one run. `blocked_tool`,
`empty_report` and unexplained `empty_output` are retried; a timeout is not,
because retrying a run that already burned its whole budget doubles the wait
for a cause that will still be true. **`rescue` never retries**, because it may
already have edited files.

**The default timeout is a generous 45m backstop, not a deadline.** A
wall-clock kill discards the entire review — Devin prints only at the end — so
cutting off a reviewer that is being thorough (reading widely, running read-only
tests under the sandbox) is the worst return a timeout can give. The old 15m
default was doing exactly that; a real review was measured at 828s. So the
ceiling is set high, purely to bound a genuinely HUNG run (a stalled process, or
in a panel one dead worker blocking the others), never to hurry a thorough one.
Raise `--timeout` for a large diff, or `--timeout none` to remove it entirely
(matching the Codex plugin, which runs to completion). An interactive hang is
also handled by Ctrl+C, which cleans up the temp dir.

**A finished turn is not necessarily a review.** One observed mode: a model
completes normally and its entire final message is two sentences of
mid-investigation narration — no findings, no verdict. That used to be rendered
verbatim under a "Reviewer:" heading, presenting zero review content as a
review. It is now classified `empty_report` and retried with a note demanding
the report as the final message. The bar is deliberately conservative: only
*short* output with no verdict word, no severity word, no `file:line` citation
and no mention of a finding is reclassified, so a genuine prose review is still
printed rather than discarded.

**When any model fails, the work dir is kept** and its path printed — the
request as sent, the permission config, and every attempt's transcript where
Devin exported one. A `blocked_tool` or `empty_report` run completes a turn, so
its transcript is there to answer "what was that model doing"; a hard `timeout`
is killed mid-turn, before Devin's after-each-turn export runs, so it leaves
only the request and config. `--keep-artifacts` keeps the dir unconditionally.
Kept or leaked (a hard kill cannot run cleanup handlers), work dirs are swept on
a later start once they are a day old — measured by the newest mtime of the dir
*and its contents*, so a long-running review that keeps re-exporting is never
mistaken for a leak.

A panel that loses a reviewer still exits 0 — most of a council is worth having
— but says so **above the findings**, not only at the bottom:

```
> ⚠ 1 of 3 model(s) returned nothing (`swe-1-7` — blocked_tool).
> Their silence is missing data, not agreement that the change is fine.
```

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
| 7 | the installed Devin CLI is incompatible with this plugin version |
| 8 | the repository configures Devin MCP servers; `--allow-repo-mcp` overrides |

Exit 3 names why: `blocked_tool` (the reviewer reached for a denied tool — it
was already retried once with a corrective note), `empty_report` (it finished
on narration instead of a report — also already retried), `sandbox_unavailable`
(the OS sandbox prerequisites are missing on Linux — install bubblewrap/socat or
pass `--no-sandbox`), `quota` (out of budget for that model; a free model still
works), `auth`, `org_policy`, `context_overflow`, `empty_output`, or `timeout`
(the run hit the wall clock — a generous 45m by default, raise it or set
`--timeout none` if a large diff legitimately needs longer). On any of these the
work dir is kept and named, with whatever transcript was exported inside.

On exit **4**, do not re-run with `--allow-secrets` unprompted. The diff leaves
your machine, so waiving the scan is the user's call.

## Cost

Paid models consume Devin usage quota; `swe-1-7` and `glm-5-2` are free. A panel
multiplies cost by the number of paid members, so the tool prints a rough
estimate before it runs and `--dry-run` prints it and stops. `models` shows live
per-MTok pricing read from your account rather than a hardcoded table.

Three of the four default council members are paid, so a bare `/devin:panel` is
not free. The cheap end of the roster still is: `--models glm-5-2,swe-1-7` costs
nothing at all, and the single-reviewer default (`deepseek-v4-flash-high`, at
$0.14/$0.28 per MTok) is cents per review.

## Known quirks that are not this plugin's doing

Recorded so nobody spends an afternoon rediscovering them.

**Model selection is a CLI-only concept.** The Devin *MCP server*'s
`devin_session_create` has no documented way to choose a model, and passing
`additional_args` to do it is rejected on production with
`additional_args is not supported` — despite the tool's own description
presenting it as an ordinary per-session option, noting only that it is
"staging-only and server-allowlisted". Use the CLI's `--model`, which is what
this plugin does.

**Your `~/.claude/CLAUDE.md` is loaded into every Devin session** as a
user-level always-on rule — `devin rules list` reports it as `CLAUDE [Claude]`
— and `~/.claude/skills` plus `~/.agents/skills` are mounted as model-invocable
skills. This is **not** harmless. If your CLAUDE.md documents how to obtain
second opinions — an `/agy:review` or `/codex:adversarial-review` playbook —
the reviewer reads that as instructions for itself: a real swe-1-7 run, asked
for an adversarial review, tried to invoke `/agy:review --dry-run --base
HEAD~1`, flags lifted verbatim from the user's global config, and lost both
attempts to the blocked call. Inside the sandbox the real binary is on PATH
and shell commands are auto-approved, so the call can even *succeed* — and the
"independent" review comes back quietly laundered through the very vendor you
did not pick. No config key disables the import (`claude`, `rules.claude`,
`imports.claude` and `agent.rules.claude` were all tried), so this plugin
counters it in the two places it can: the request tells the reviewer that
imported rules belong to a different agent and must be ignored, and the
permission config denies `agy`, `codex`, `claude`, `gemini` and `devin` as
whole commands, so a reviewer that tries to outsource its opinion fails
loudly (`blocked_tool`, named in the retry note) rather than delegating
silently. If your own CLAUDE.md carries a delegation playbook, consider also
moving it behind an `@import` — Claude Code resolves imports; Devin ingests
only the raw file text.

**`rg` and `grep` are rejected as shell commands under per-command screening.**
Devin wants its own grep tool used instead. This is only a trap because a
rejected command destroys the whole turn, which is why the screened-path prompt
names them explicitly. Inside the sandbox they simply run.

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
