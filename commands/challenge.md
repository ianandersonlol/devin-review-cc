---
description: Challenge the design and approach of your change via the Devin CLI, not its bugs
argument-hint: [--base REF] [--staged] [--focus "TEXT"] [--model ID] [--panel] [-- paths...]
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git diff --stat:*)
---

Ask whether this is the **right shape of solution at all** — not whether it has
bugs. The reviewer assumes the code works and interrogates the approach: what it
takes for granted, what it forecloses, how it behaves at scale and under partial
failure, and whether it fits how this repository already solves the same class
of problem.

Use `/devin:review` when you want defects. Use this when the open question is
the design.

Arguments: $ARGUMENTS

## Steps

1. Run it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" challenge $ARGUMENTS
```

`--panel` or `--models a,b,c` works here too, and design is where disagreement
between models is most informative — there is rarely one right answer.

2. Exit codes are identical to `/devin:review`. Handle them the same way.

3. Present the output verbatim, then add your own assessment.

## Reading a design challenge well

The verdict vocabulary is deliberately different from the defect lens:
**SOUND** / **RECONSIDER** / **WRONG-SHAPE**, so a transcript containing both
passes can never confuse which produced which conclusion.

Expect a higher rate of context-blind objections than from a defect review.
Design critique depends on constraints the reviewer cannot see — deadlines,
a migration already underway, a deliberate decision made three conversations
ago. A challenge you can answer with "yes, and we chose that knowingly" is not
a bad challenge, but it **is** one you should answer rather than pass along
unexamined. Say which objections we have already resolved, and why.

Do not start redesigning anything unless the user asks.
