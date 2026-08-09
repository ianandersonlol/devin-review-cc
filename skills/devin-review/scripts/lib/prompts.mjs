// The two review lenses, and the rescue request.
//
// `defect` asks "what is broken here". `design` asks "is this the right shape" —
// a different question, so it gets a different output contract and a distinct
// verdict vocabulary. Keeping the verdict words disjoint means a panel
// transcript containing both lenses can never confuse which produced which.

/**
 * Why this section is worded so insistently about the shell:
 *
 * In non-interactive mode, a tool call Devin cannot auto-approve does not fail
 * gracefully — it ends the turn and discards everything the model had produced,
 * leaving an exit code of 0 and an empty stdout. A reviewer that idly reaches
 * for `git log` therefore does not get a slightly worse review, it gets no
 * review at all, and the user pays for the tokens regardless. Telling the model
 * plainly what it does not have is the cheapest fix available.
 */
const SHARED_REPO_ACCESS = `## You have read access to the entire repository

This is the most important instruction. Do NOT review the diff in isolation.
Use your read, grep, and file-search tools on the repo at {{REPO_ROOT}} to:

- read each changed file IN FULL, not just the hunks
- find every CALLER of every function whose signature, return value, error
  behaviour, or nullability changed, and check each call site still holds
- check whether tests exist for the changed paths, and whether they actually
  cover the new behaviour or just the happy path
- look for OTHER places in the codebase with the same bug or the same pattern
  that the author fixed here but missed there
- verify claims in comments and commit messages against the real code

A finding you confirmed by reading code is worth ten you inferred from a hunk.

## You have no shell

The exec, edit, and write tools are denied in this session. Do not attempt to
run commands, edit files, or write anything — not even to scratch space. If you
call a denied tool, your turn ends immediately and your entire review is thrown
away. Everything you need is reachable by reading and searching files.`;

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
  format: `## Output format

Emit findings in descending severity. Format each one as a level-3 markdown
heading holding one severity word followed by the claim, then four bullets.
Severity is exactly one of CRITICAL, HIGH, MEDIUM, LOW. Like this:

### HIGH Retry loop double-charges on a timeout
- **Where:** \`billing/charge.py:88\`
- **Failure:** concrete inputs or sequence of events, then the wrong result. If
  you cannot write a concrete failure scenario, drop the finding entirely.
- **Confirmed:** say VERIFIED if you read the surrounding code and call sites to
  establish this, or SUSPECTED if it is inferred from the diff alone.
- **Fix:** the smallest safe change.

After the last finding, close with a level-3 heading reading exactly
"Verdict: SHIP" or "Verdict: REVISE" or "Verdict: RETHINK", then one paragraph.
If REVISE or RETHINK, list the specific blocking items.

Rules: no praise sections, no restating the diff, no style or formatting nits
unless they cause a real bug. If you genuinely find nothing substantive after
reading the surrounding code, say so plainly and return SHIP — do not invent
findings to look thorough.`,
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
  format: `## Output format

Emit challenges in descending order of consequence. Format each as a level-3
markdown heading holding the word CHALLENGE and a one-line claim, then four
bullets:

### CHALLENGE Cache invalidation is left to the caller
- **Assumption:** what the design takes for granted, stated plainly.
- **Breaks when:** the concrete real-world condition that invalidates it. If you
  cannot name a condition, drop the challenge entirely.
- **Confirmed:** VERIFIED if you established this by reading the surrounding
  code and its existing patterns, SUSPECTED if inferred from the diff alone.
- **Alternative:** what you would do instead, and honestly, what it costs.

After the last challenge, close with a level-3 heading reading exactly
"Verdict: SOUND" or "Verdict: RECONSIDER" or "Verdict: WRONG-SHAPE", then one
paragraph. If RECONSIDER or WRONG-SHAPE, name the single change to the approach
that would most improve it.

Rules: no praise sections, no restating the diff, no bug hunting, no style nits.
A design that is genuinely well-suited to its problem should get SOUND and a
short review — do not manufacture objections to look rigorous. Disagreement is
only useful when you can name the condition under which you are right.`,
};

export const LENSES = { defect: DEFECT_LENS, design: DESIGN_LENS };

export function isLens(name) {
  return Object.prototype.hasOwnProperty.call(LENSES, name);
}

/** The verdict words each lens is allowed to end on, for the panel tally. */
export const VERDICTS = {
  defect: ["SHIP", "REVISE", "RETHINK"],
  design: ["SOUND", "RECONSIDER", "WRONG-SHAPE"],
};

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
    `Output the review only. Do not narrate your process, do not show your working,
do not restate these instructions, and do not preface the review with anything.
Begin your reply directly with the first heading (or with the verdict heading if
you have nothing to report).`,
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
read-only mode: do NOT edit any files and do NOT run commands. Both tools are
denied, and calling one ends your turn and discards your work. Describe the
change you would make instead.`
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
