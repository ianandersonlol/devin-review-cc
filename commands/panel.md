---
description: Review the same diff with several models in parallel and compare what they found
argument-hint: '[--models a,b,c] [--base REF] [--staged] [--focus "TEXT"] [-- paths...]'
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git diff --stat:*)
---

Run several different models over the **same diff at the same time**, each
blind to the others, and compare what they found. This is what the Devin CLI is
uniquely good for: one binary fronts models from Cognition, OpenAI, Moonshot,
Zhipu, Google and others, so a genuine multi-vendor panel is a single command
rather than three separate toolchains.

Arguments: $ARGUMENTS

## Steps

1. Run the panel:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" panel $ARGUMENTS
```

Default roster is `swe-1-7,glm-5-2,kimi-k3-high` — three vendors, two of them
free. Override with `--models a,b,c`. `--concurrency N` bounds how many run at
once (default 3).

2. Exit codes are the same as `/devin:review` (including **6** for repository
   hooks — never pass `--allow-hooks` on your own initiative), plus:
   - **5** — *every* model produced nothing. The per-model reasons are printed;
     read them before retrying, because `quota` on all three means a different
     roster is needed, not another attempt.

   A panel that partially fails still exits **0** and prints what it got. That
   is deliberate: two reviews are worth having. The report lists which models
   returned nothing and why.

3. Present the output. The report leads with a comparison table, then a
   **corroboration map** splitting findings into corroborated and single-source,
   then each review in full. Keep that structure — do not collapse three reviews
   into one summary.

   Findings are addressable as `model#id` (e.g. `swe-1-7#2`). Use those addresses
   when you discuss them rather than re-quoting the text, and pass `--json` if
   you want the validated structure to filter or sort on.

4. **Then do the reconciliation, because nothing else will.** The script
   deliberately does not synthesize: a fourth model asked to merge three reviews
   has no repository access, cannot check any claim, and reliably prefers
   whatever was stated most confidently. That job is yours, and you have the
   code. Specifically:

   - **Weight heavily what two or more models found independently** — the
     "Corroborated" section has already identified these for you.
   - **Look hardest at the "Single-source" list.** Each is either the sharpest
     finding in the set or a hallucination; check it against real code and say
     which. Note that correlation is arithmetic and errs toward splitting, so
     two single-source entries at nearby lines may be one bug described twice.
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
- Cost scales with the number of paid models. The script prints a rough estimate
  before running; `--dry-run` prints it and stops. Free models (`swe-1-7`,
  `glm-5-2`) make a panel that costs nothing at all.
- For the riskiest changes, a panel here plus `/agy:review` and
  `/codex:adversarial-review` gives four labs' opinions. Reconcile them all;
  never ask one tool to produce another's.
