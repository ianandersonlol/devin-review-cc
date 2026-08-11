// The two review lenses, and the rescue request.
//
// `defect` asks "what is broken here". `design` asks "is this the right shape" —
// a different question, so it gets a different output contract and a distinct
// verdict vocabulary. Keeping the verdict words disjoint means a panel
// transcript containing both lenses can never confuse which produced which.

import { EXAMPLE_PLACEHOLDERS } from "./findings.mjs";

/**
 * Why this section is worded so insistently about the shell:
 *
 * In non-interactive mode, a tool call Devin cannot auto-approve does not fail
 * gracefully — it ends the turn and discards everything the model had produced,
 * leaving an exit code of 0 and an empty stdout. A reviewer that reaches for a
 * tool it does not have therefore does not get a slightly worse review, it gets
 * no review at all, and the user pays for the tokens regardless. Drawing the
 * boundary precisely is the cheapest fix available.
 *
 * It says "read-only shell" rather than "no shell" because that is now the
 * truth. `--permission-mode auto` classifies each command instead of refusing
 * all of them, so `git log` runs and `echo x > f` does not — and a reviewer told
 * it had no shell at all would decline to use the one genuinely useful tool it
 * has. Since these instructions no longer have a config file to travel in
 * (Devin dropped `system-instructions` along with `--agent-config`), this prompt
 * is the only place the boundary gets stated.
 */
const SHARED_REPO_ACCESS = `## You have read access to the entire repository

This is the most important instruction. Do NOT review the diff in isolation.
Use your read, grep, and file-search tools on the repo at {{REPO_ROOT}} to:

- read each changed file IN FULL, not just the hunks
- find every CALLER of every function whose signature, return value, error
  behaviour, or nullability changed, and check each call site still holds
- check whether tests exist for the changed paths, and whether they actually
  cover the new behaviour or just the happy path — by READING them. You cannot
  run them, and trying ends your turn (see below).
- look for OTHER places in the codebase with the same bug or the same pattern
  that the author fixed here but missed there
- verify claims in comments and commit messages against the real code

A finding you confirmed by reading code is worth ten you inferred from a hunk.

## Finish within your budget

You are on a wall clock, and **a review that never reaches its final message is
worth exactly nothing** — a run that times out mid-investigation scores zero
however good the analysis was. That is a worse outcome than a shorter report.

So triage rather than audit. Go deep on the two or three changes most likely to
be wrong; skim the rest. Read the files that carry risk in full, not every file
that changed. Once you can support a few solid findings, **stop reading and
write the report** — and if you are running long, write it immediately with what
you have rather than pressing on.

## You cannot change anything, and trying DESTROYS your review

Read this twice. It is the single most common way a review here is lost.

The \`edit\` and \`write\` tools are denied. So is any shell command that changes
anything: a \`>\` redirect, \`mkdir\`, \`rm\`, \`mv\`, \`touch\`, \`git add\`,
\`git commit\`, installing a package.

**One such attempt ends your turn instantly and throws away everything you have
worked out.** Not a warning, not an error you can recover from — your entire
review is discarded and nothing is printed. There is no second chance.

In particular: **do NOT write your report to a file.** Your report is what you
print as your final message. There is no file to save it to and attempting to
create one loses the report you just spent the whole session writing.

Prefer your \`read\`, \`grep\` and file-search tools — they are what this job
needs, and they are never rejected. The shell is a narrow supplement, and the
list of what it will accept is SHORT and EXACT:

**Allowed** — and only when run BARE from the directory you are already in,
which is the repository root:
\`git log\`, \`git show\`, \`git blame\`, \`git diff\`, \`ls\`, \`cat\`,
\`head\`, \`tail\`, \`wc\`, \`rg\`.

**Rejected — each one ends your turn and destroys your review:**

- \`cd anywhere\`, or \`git -C /path ...\`. The repository path is printed above,
  but using it is what breaks this. Plain \`git log\` runs; \`git -C /path log\`
  is rejected. This looks like the careful, explicit thing to do, and it is the
  single most common way a review is lost here.
- **Running tests, builds or tooling**: \`npm\`, \`yarn\`, \`pnpm\`, \`pytest\`,
  \`cargo\`, \`make\`, \`go\`, \`tsc\`, or executing any script. **You cannot run
  the test suite.** Do not try it even to check whether a test passes — judge
  the tests by reading them, and say plainly that you could not execute them.
- Installing anything, or any network access (\`curl\`, \`wget\`).
- Anything that writes, as above.

If a command is not on the allowed list, do not run it. There is no way to ask
permission and no way to recover.

Do not spawn subagents — they cannot write either, and they cost you time you
need for the review.`;

/**
 * The structured output contract.
 *
 * Only the envelope is structured. `body` and `recommendation` are free prose
 * with no shape imposed on them, because constraining a reviewer's *argument*
 * to a schema reliably makes the argument worse — the fields exist so findings
 * can be sorted, addressed and correlated, not to discipline the thinking.
 *
 * Devin cannot enforce a schema the way the Codex CLI can, so this asks firmly
 * and the parser is forgiving. A model that answers in prose anyway still gets
 * its review printed; it just does not get correlated.
 */
function OUTPUT_CONTRACT({ verdicts, verdictGuide, bodyGuide, recommendationGuide, severityGuide }) {
  const ph = EXAMPLE_PLACEHOLDERS;
  return `## Output format — JSON only

Return ONE JSON object and nothing else. No preamble, no explanation around it,
no markdown outside it. If you wrap it in a fence, use \`\`\`json.

\`\`\`json
{
  "verdict": ${verdicts.map((v) => `"${v}"`).join(" | ")},
  "summary": "${ph.summary}",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "${ph.title}",
      "body": "${bodyGuide.replace(/\n/g, " ")}",
      "file": "${ph.file}",
      "line_start": 88,
      "line_end": 94,
      "confidence": 0.0,
      "grounding": "verified" | "inferred",
      "recommendation": "${recommendationGuide}"
    }
  ],
  "next_steps": ["${ph.nextStep}"]
}
\`\`\`

### Field rules

- **verdict.** ${verdictGuide}
- **severity.** ${severityGuide ?? "How costly this is if it goes wrong in production."}
- **file / line_start / line_end.** Point at the code you are actually talking
  about. A finding nobody can locate cannot be checked, and will be discarded.
- **grounding.** \`verified\` ONLY if you opened the surrounding code and its
  call sites and established this. \`inferred\` if you reasoned from the diff.
  Guessing here is worse than useless: the reader uses this to decide what to
  re-check, so a false \`verified\` sends them past the thing that was wrong.
- **confidence.** 0 to 1, and honest. Do not cluster everything at 0.9. If a
  conclusion rests on an inference, say so in the body and lower the number.

### Bar for a finding

Report only material findings. No style, naming, or cleanup notes; no
speculation you cannot tie to a code path. Prefer one strong finding over
several weak ones, and do not pad. If you genuinely find nothing substantive
after reading the surrounding code, return an empty \`findings\` array and say
so in the summary — that is a useful answer, and inventing findings to look
thorough is not.

Never invent a file, a line, a call path, or runtime behaviour you cannot
support from what you actually read.`;
}

const DEFECT_LENS = {
  title: "Adversarial code review",
  intro: `You are an adversarial reviewer. Your job is to find what is WRONG with this
change — not to summarize it, not to praise it. Assume the author is competent
and has already thought about the obvious cases; look for what they missed.`,
  body: `## What to look for

Correctness and edge cases; error and failure handling; concurrency and
ordering; data loss and destructive operations; auth, permissions, and input
validation; resource leaks; API/contract breaks for existing callers; state
that can go inconsistent on a partial failure.`,
  format: OUTPUT_CONTRACT({
    verdicts: ["SHIP", "REVISE", "RETHINK"],
    verdictGuide: `SHIP when you cannot support a substantive finding. REVISE when the
implementation has defects that must be fixed but the approach is right.
RETHINK when the defects indicate the approach itself is wrong.`,
    bodyGuide: `A concrete failure: specific inputs or a sequence of events, then the wrong
result that follows. If you cannot write one, drop the finding entirely.`,
    recommendationGuide: "The smallest safe change that fixes it.",
  }),
};

const DESIGN_LENS = {
  title: "Adversarial design review",
  intro: `You are challenging the APPROACH, not hunting for bugs. Assume the code does
what the author intended and that it passes its tests. Your job is to ask
whether this is the right shape of solution at all: what it takes for granted,
what it forecloses, and where it breaks under conditions the author has not
considered.

Do not report implementation defects. If you spot an outright bug, note it in
one line at the very end under "Incidental defects" and move on — someone else
is running that pass.`,
  body: `## What to interrogate

- **Assumptions.** What must stay true for this design to hold? Which of those
  are load-bearing, unstated, and outside the author's control?
- **The road not taken.** What is the obvious alternative approach, and what
  does this one buy that the alternative does not? If the alternative is
  simpler and the change does not clearly beat it, say so.
- **Scale and load.** Where does this stop working — 10x the data, 10x the
  concurrency, a slow dependency, a partial outage?
- **Coupling and reversibility.** What does this lock in? How hard is it to
  undo in six months? Does it add a dependency, a schema, a wire format, or a
  public contract that will be expensive to change?
- **Failure semantics.** When it breaks, how does it break — loudly, silently,
  or half-committed? Is that the failure mode the caller wants?
- **Fit.** Does this match how the rest of this repository already solves the
  same class of problem? Divergence is not automatically wrong, but it should
  be deliberate. Read the neighbouring code and find out.`,
  format: OUTPUT_CONTRACT({
    verdicts: ["SOUND", "RECONSIDER", "WRONG-SHAPE"],
    verdictGuide: `SOUND when the approach genuinely fits its problem. RECONSIDER when a
specific part of the design should change. WRONG-SHAPE when the whole approach
is the wrong one.`,
    bodyGuide: `State the assumption the design takes for granted, then the concrete
real-world condition under which it stops holding. If you cannot name a
condition, drop the challenge entirely.`,
    recommendationGuide:
      "What you would do instead, and honestly, what that alternative costs.",
    severityGuide: "Severity here means consequence if the assumption breaks, not bug severity.",
  }),
};

export const LENSES = { defect: DEFECT_LENS, design: DESIGN_LENS };

export function isLens(name) {
  return Object.prototype.hasOwnProperty.call(LENSES, name);
}

// The verdict vocabularies live in findings.mjs, which owns the schema. Kept as
// a re-export so existing importers do not need to care where they moved to.
export { VERDICTS } from "./findings.mjs";

/** Assemble the full review request written to the 0600 temp file. */
export function buildRequest({ lens, repoRoot, branch, description, filesChanged, focus, diff }) {
  const spec = LENSES[lens];
  const sections = [
    `# ${spec.title}`,
    "",
    spec.intro,
    "",
    `Repository: ${repoRoot}`,
    `Branch: ${branch}`,
    `Scope: ${description}`,
    `Files changed: ${filesChanged}`,
    "",
    SHARED_REPO_ACCESS.replace("{{REPO_ROOT}}", repoRoot),
    "",
    spec.body,
  ];

  if (focus) {
    sections.push("", "## Focus from the author", "", focus);
  }

  sections.push(
    "",
    spec.format,
    "",
    `Output the JSON object only. Do not narrate your process, do not show your
working, do not restate these instructions, and do not write anything before or
after the JSON.`,
    "",
    "## The diff under review",
    "",
    "```diff",
    diff.replace(/\n$/, ""),
    "```",
    "",
  );

  return sections.join("\n");
}

// ── rescue ───────────────────────────────────────────────────────────────────

const RESCUE_RULES = `## Hard constraints

These are absolute. Violating any of them makes your work unusable.

- **Never touch git history or state.** No commit, no push, no reset, no
  checkout, no rebase, no stash, no branch, no tag, no \`git add\`. Leave staging
  exactly as you found it. The user reviews your edit and decides what to do
  with it.
- **Smallest change that fixes the problem.** Do not refactor adjacent code, do
  not reformat, do not rename, do not "improve" things you were not asked about,
  do not upgrade dependencies.
- **Do not touch files unrelated to the problem.** If a fix genuinely requires a
  change elsewhere, make it and say so explicitly in your report.
- **Never delete a file** unless deleting it IS the fix, and say so loudly.
- **Do not weaken a test to make it pass.** If the test is what is wrong, say so
  and explain why rather than editing it into agreement with broken code.`;

const RESCUE_OUTPUT = `## Output format

Four level-3 sections, in this order. Be brief and concrete.

### Root cause
What is actually wrong, and why it produces the reported symptom. If you could
not determine it, say so plainly instead of guessing.

### Change made
Every file you touched and what you changed in it. If you changed nothing, say
so and explain why.

### Verification
What you ran to prove the fix works, and the result. If you could not run
anything, say that explicitly — an unverified fix must be labelled as such.

### Risks and gaps
What you could not check, what might break elsewhere, and what the user should
look at before keeping this. Do not write "none" reflexively; there is almost
always something.`;

/**
 * Build a rescue request.
 *
 * @param {boolean} readOnly      propose a fix without editing anything
 * @param {boolean} allowCommands the run may execute shell commands
 */
export function buildRescueRequest({ problem, repoRoot, branch, readOnly, allowCommands, contextDiff, focus }) {
  const sections = [
    "# Rescue request",
    "",
    readOnly
      ? `Diagnose the problem below and propose the smallest safe fix. You are in
read-only mode: the edit and write tools are denied, and so is any command that
changes anything. Read-only commands (\`git log\`, \`ls\`, \`cat\`) ARE available
and worth using. Calling a denied tool ends your turn and discards your work, so
describe the change you would make rather than attempting it.`
      : `Diagnose and FIX the problem below by editing files in this repository.
You have write access to the working tree.`,
    "",
    `Repository: ${repoRoot}`,
    `Branch: ${branch}`,
    "",
    "## The problem",
    "",
    problem,
  ];

  if (!readOnly) {
    sections.push(
      "",
      allowCommands
        ? `You may run shell commands to reproduce the problem and verify your fix.
Prefer running the single relevant test over a whole suite. Commands that touch
git history, \`rm\`, and \`sudo\` are denied and calling one ends your turn.`
        : `You have NO shell in this run: the exec tool is denied, and calling it ends
your turn and discards your work. Fix the problem by reading and editing files
only, then say plainly in your report that you could not verify the fix by
running it. An honest unverified fix is useful; a lost turn is not.`,
    );
  }

  if (focus) sections.push("", "## Additional guidance from the author", "", focus);

  if (contextDiff && contextDiff.trim()) {
    sections.push(
      "",
      "## The author's uncommitted work, for context",
      "",
      "This is what they have been changing. The problem is often, but not",
      "always, caused by something in here. Treat it as a lead, not a verdict.",
      "",
      "```diff",
      contextDiff.replace(/\n$/, ""),
      "```",
    );
  }

  sections.push(
    "",
    "## Investigate before you act",
    "",
    `Read the relevant files IN FULL and follow the call sites. A fix you
established by reading the surrounding code is worth ten you guessed at.`,
    "",
    readOnly
      ? RESCUE_RULES.replace(
          "- **Smallest change that fixes the problem.**",
          "- **Propose the smallest change that fixes the problem.**",
        )
      : RESCUE_RULES,
    "",
    RESCUE_OUTPUT,
    "",
    `Output the report only. Do not narrate your process and do not restate these
instructions. Begin directly with the "### Root cause" heading.`,
    "",
  );

  return sections.join("\n");
}
