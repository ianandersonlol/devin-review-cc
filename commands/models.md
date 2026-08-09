---
description: List the models your Devin account can use, with prices and free tiers
argument-hint: '[--json]'
allowed-tools: Bash(node:*)
---

Show what this Devin account can actually run, grouped by family, with pricing
and which are free. Spends nothing.

Arguments: $ARGUMENTS

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" models $ARGUMENTS
```

## Steps

1. Run it. Exit **2** means devin is missing or not logged in — send the user to
   `/devin:setup`. Exit **3** means the roster could not be read.

2. Present it, but **do not dump all 37 families** unless asked. The roster is
   long and mostly irrelevant to picking a reviewer. Summarise what matters:
   which families are free, which are cheap, and which the user already uses.

3. When helping choose a reviewer, optimise for **independence first, capability
   second**:
   - A `claude-*` model correlates with you and is the weakest choice for a
     second opinion, whatever its benchmark scores. The listing flags these.
   - For a panel, pick different *vendors*, not different checkpoints of one
     model. Two Opus tiers reviewing the same diff is one opinion billed twice.
   - Free models (`swe-1-7`, `glm-5-2`) are genuinely good reviewers and make
     panels that cost nothing. Escalate to paid models for risky diffs, not
     reflexively.

## Notes

- The roster is per-account and changes; that is exactly why this command reads
  it live rather than quoting a table from documentation that will rot.
- `--json` gives the parsed roster including context windows and per-MTok
  prices, if you need to branch on it.
