---
description: Review the same diff with several models in parallel and compare what they found
argument-hint: '[--models a,b,c] [--base REF] [--staged] [--focus "TEXT"] [-- paths...]'
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git diff --stat:*)
---

Run several different models over the **same diff at the same time**, each
blind to the others, and compare what they found. This is what the Devin CLI is
uniquely good for: one binary fronts models from Moonshot, xAI, DeepSeek, Zhipu,
Cognition, OpenAI, Google and others, so a genuine multi-vendor panel is a single
command rather than four separate toolchains.

Arguments: $ARGUMENTS

## Steps

1. Run the panel:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" panel $ARGUMENTS
```

Add `--repo <absolute path to the repository>` if the shell's working directory
is not inside it. Claude Code starts commands in your project, so it never needs
this; Antigravity runs every command from its own scratch directory, so it
always does.

Default council is `kimi-k3-high,grok-4-6-high,deepseek-v4-flash-high,glm-5-2` —
four vendors: Moonshot, xAI, DeepSeek, Zhipu. Three of them are paid, so a bare
panel costs a few tens of cents on a normal diff. Override with `--models a,b,c`.
`--concurrency N` bounds how many run at once (default 4, so the council runs in
one wave).

2. Exit codes are the same as `/devin:review` (including **6** for repository
   hooks and **8** for repository MCP startup — never pass `--allow-hooks` or
   `--allow-repo-mcp` on your own initiative), plus:
   - **5** — *every* model produced nothing. The per-model reasons are printed;
     read them before retrying, because `quota` across the board means a
     different roster is needed, not another attempt.

   A panel that partially fails still exits **0** and prints what it got. That
   is deliberate: three reviews are worth having. The report lists which models
   returned nothing and why — each retryable failure was already retried once,
   with a corrective note — and the temp work dir is kept and named on stderr,
   holding the request and every attempt's session transcript, so a silent or
   timed-out model's behaviour can actually be inspected.

3. Present the output. Each review streams the moment its model finishes, in
   completion order; the **Panel summary** at the end holds the comparison
   table and the **corroboration map** splitting findings into corroborated and
   single-source. Read the summary first anyway, then the reviews — and keep
   that structure when presenting: do not collapse four reviews into one
   summary.

   Because reviews stream, run the panel as a background task and poll its
   output: the fastest model answers minutes before the slowest, and you can
   verify its findings against the code while the rest are still running.

   Findings are addressable as `model#id` (e.g. `swe-1-7#2`). Use those addresses
   when you discuss them rather than re-quoting the text, and pass `--json` if
   you want the validated structure to filter or sort on.

4. **Then do the reconciliation, because nothing else will.** The script
   deliberately does not synthesize: a further model asked to merge the reviews
   has no repository access, cannot check any claim, and reliably prefers
   whatever was stated most confidently. That job is yours, and you have the
   code. Specifically:

   - **Weight heavily what two or more models found independently** — the
     "Corroborated" section has already identified these for you.
   - **Look hardest at the "Single-source" list.** Each is either the sharpest
     finding in the set or a hallucination; check it against real code and say
     which. Note that correlation is arithmetic and errs toward splitting, so
     two single-source entries at nearby lines may be one bug described twice,
     and findings with no line number are never correlated at all.
   - **Read any "unstructured" reviewer in full.** Its output did not parse, so
     it sat out the correlation map entirely — its findings are not in there.
   - **Check `grounding` before repeating a claim.** `inferred` means the model
     reasoned from the diff without opening the call sites.
   - **Where they contradict each other, read the code and say who was right.**
     Do not average the verdicts, and do not count votes. The report flags
     disagreement explicitly; that flag is an instruction to go look.
   - **Flag context-blind findings.** No reviewer can see this conversation.
   - **Give your own verdict, marked as yours**, separate from theirs.

5. Do not start fixing anything unless the user asks.

## Notes

- Model diversity is the entire point. A panel of `claude-opus-5-high` and
  `claude-sonnet-5-high` costs twice as much to buy an echo — the script warns
  about single-family panels and about Claude models, which correlate with you.
- Cost scales with the number of paid models, and three of the four default
  council members are paid. The script prints a rough estimate before running;
  `--dry-run` prints it and stops. `--models swe-1-7,glm-5-2` is the free pair,
  and makes a panel that costs nothing at all.
- For the riskiest changes, a panel here plus `/agy:review` and
  `/codex:adversarial-review` gives six labs' opinions. Reconcile them all;
  never ask one tool to produce another's.
