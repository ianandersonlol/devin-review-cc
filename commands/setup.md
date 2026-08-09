---
description: Check that devin, git, and node are ready for reviews, and explain how to fix what is not
argument-hint: '[--json]'
allowed-tools: Bash(node:*), Bash(devin --version:*), Bash(devin auth status:*), AskUserQuestion
---

Verify the local toolchain `devin-review` depends on, and give the user a
concrete fix for anything that is not ready. Spends **nothing**.

Arguments: $ARGUMENTS

## Steps

1. Run the check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/devin-review/scripts/devin-review.mjs" setup $ARGUMENTS
```

Exit **0** means ready, exit **2** means something needs fixing. The output
already contains a per-component status and an ordered remediation list.

2. Present the output. If everything is ready, keep it to a line or two — do not
   pad a clean result.

3. If something is not ready, act on the specific problem:

   - **devin not found on PATH.** Point the user at <https://docs.devin.ai/cli>
     for the install command. Do not attempt to install it yourself.

   - **devin present but not logged in.** `devin auth login` opens an
     interactive browser flow, so you cannot do it for them. Tell the user to
     type `! devin auth login` to run it in this session, complete the sign-in,
     and re-run `/devin:setup`.

   - **logged in but models did not respond.** Connectivity or a proxy. Devin
     reads proxy settings from `~/.config/devin/config.json`.

   - **default model missing.** The account cannot use `swe-1-7`. Run
     `/devin:models` and pass `--model` with something it can.

   - **node too old.** The scripts need Node 18+. Point at <https://nodejs.org>.

   - **git missing.** Install git and put it on PATH.

4. Do not re-run the check in a loop. Run it once after a fix the user confirms
   they made, and report the result.

## Notes

- `devin models list` is the readiness probe. It exercises the binary end to end
  and spends nothing, but it is a *responds* signal — the CLI can answer from a
  cached roster, so `devin auth status` is what actually establishes auth. The
  output reports them separately for that reason.
- This command checks the toolchain only. For what a review would actually cover
  in the current repository, use `/devin:status`.
