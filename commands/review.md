---
description: Adversarial review of your working diff via the Devin CLI with real repo access
argument-hint: [--base REF] [--staged] [--uncommitted] [--focus "TEXT"] [--model ID] [-- paths...]
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git diff --stat:*), AskUserQuestion
---

Get an independent adversarial review of the current change from a model that is
not you, via the Devin CLI. The reviewer runs **read-only** and non-interactively
but has **read access to the whole repository**, so it verifies findings against
real code and call sites instead of guessing from the diff.

This is the **defect lens**: it hunts for what is broken. To challenge the design
and approach instead, use `/devin:challenge`. To get several models' opinions at
once, use `/devin:panel`.

Arguments: $ARGUMENTS

## Steps

1. Run the review. Pass `$ARGUMENTS` straight through — the script parses them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" review $ARGUMENTS
```

Add `--repo <absolute path to the repository>` if the shell's working directory
is not inside it. Claude Code starts commands in your project, so it never needs
this; Antigravity runs every command from its own scratch directory, so it
always does.

2. Interpret the exit code before anything else:
   - **0** — review printed. Continue to step 3.
   - **4** — blocked by the secret-shape scan. Do NOT rerun with
     `--allow-secrets` on your own initiative. Show the user which lines matched
     and ask whether to scope the review to safe paths or waive the scan.
   - **3** — no review was produced. The message names the class, the script
     has ALREADY retried the retryable ones once (with a corrective note naming
     what went wrong), and it kept the temp work dir — the printed path holds
     the request and each attempt's session transcript if you need to see what
     the model was doing. **`blocked_tool`** means it called a denied tool and
     Devin ended the turn without printing anything; nothing was written to the
     repo. **`empty_report`** means it finished on narration with no findings
     or verdict. For either, a different model is the pragmatic next step.
     `quota` means the account is out of budget for that model — a free model
     (`swe-1-7`, `glm-5-2`) will work. `auth` means `devin auth login`.
   - **2** — setup problem (not a git repo, bad ref, unknown model, devin
     missing). Suggest `/devin:setup`, which diagnoses exactly what is wrong.
   - **6** — the repository declares Devin lifecycle **hooks**. Devin runs these
     as shell commands at session start, before the model acts and regardless of
     which tools it is allowed, so they sit outside the read-only guarantee. The
     output names the files and events found. `--allow-hooks` overrides it, but
     that is the **user's call, not yours** — show them what was found and ask.
     Their own repo with their own hooks is usually fine; a fork or someone
     else's branch is exactly why the check exists.
   - **8** — the repository configures Devin MCP servers. Stdio server commands
     start while the session connects, before the model or tool permissions can
     constrain them. The output names the files. `--allow-repo-mcp` is the
     user's decision after inspecting those servers; never add it on your own.
   - anything else — surface Devin's stderr verbatim.

3. Present the review to the user **verbatim first**, unedited. Do not soften,
   filter, or reorder the findings. This is the whole point of a second opinion.

4. Then add your own short assessment underneath, clearly separated. For each
   finding, say whether you **agree**, **disagree**, or **need to check** — and
   where you disagree, say why, citing the code. The reviewer cannot see this
   conversation and does not know the constraints we've discussed, so some
   findings will be context-blind. Flag those explicitly rather than silently
   dropping them.

5. Do not start fixing anything unless the user asks. Report, then wait.

## Notes

- Default scope is the working tree vs the merge-base with `origin/HEAD`/`main`/
  `master`, so committed-on-branch **and** uncommitted work are reviewed together.
- The default model is `deepseek-v4-flash-high`: 1M of context at $0.14/$0.28 per
  MTok, so cents per review, and from DeepSeek rather than Anthropic. Escalate
  with `--model` when the change is genuinely risky, or drop to a free reviewer
  (`swe-1-7`, `glm-5-2`) when it is not — `/devin:models` lists what the account
  can use, with prices.
- **Do not pick a `claude-*` model.** It correlates with you, so it is not an
  independent voice; the script warns when you do. Prefer a different lab.
- **This command is one voice.** For several, use `/devin:panel`, whose default
  council is four vendors at once — the feature this plugin exists for. For a
  cross-tool council, run this alongside the agy (Gemini) and Codex (GPT)
  plugins and reconcile the results yourself.
- Paid models consume Devin usage quota; free models do not. `--dry-run` shows
  exactly what would be sent and spends nothing.
