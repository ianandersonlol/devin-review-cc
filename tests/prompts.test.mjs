import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRequest,
  buildRescueRequest,
  isLens,
  LENSES,
  VERDICTS,
} from "../skills/devin-review/scripts/lib/prompts.mjs";

const base = {
  lens: "defect",
  repoRoot: "/repo",
  branch: "feature",
  description: "branch vs main",
  filesChanged: 3,
  focus: "",
  diff: "--- a/x\n+++ b/x\n+bad line\n",
};

test("isLens accepts the two lenses and nothing else", () => {
  assert.ok(isLens("defect"));
  assert.ok(isLens("design"));
  assert.ok(!isLens("toString"), "must not inherit from Object.prototype");
  assert.ok(!isLens("vibes"));
});

test("the two lenses use disjoint verdict vocabularies", () => {
  // A panel transcript can hold both lenses; overlapping verdict words would
  // make it impossible to tell which pass produced which conclusion.
  const overlap = VERDICTS.defect.filter((word) => VERDICTS.design.includes(word));
  assert.deepEqual(overlap, []);
});

test("every verdict word a lens promises appears in its own format spec", () => {
  for (const [lens, words] of Object.entries(VERDICTS)) {
    for (const word of words) {
      assert.match(LENSES[lens].format, new RegExp(word), `${lens} should document ${word}`);
    }
  }
});

test("the diff reaches the request intact", () => {
  assert.match(buildRequest(base), /\+bad line/);
});

test("the request carries the repo root so the reviewer knows where to read", () => {
  const request = buildRequest(base);
  assert.match(request, /Repository: \/repo/);
  assert.match(request, /repo at \/repo/);
});

test("the request draws the shell boundary where Devin actually draws it", () => {
  // Load-bearing twice over. A denied tool call ends the turn and discards the
  // whole review, so the model must be told before it reaches for one — and
  // since Devin dropped `system-instructions` along with `--agent-config`, this
  // prompt is now the ONLY place the boundary is stated.
  //
  // "Read-only shell", not "no shell": --permission-mode auto classifies each
  // command rather than refusing all of them, so a reviewer told it had no
  // shell would decline to run `git log` for no reason.
  const request = buildRequest(base);
  assert.match(request, /cannot change anything/i);
  assert.match(request, /git log/, "the reviewer should know reading history is available");
  assert.match(request, /`edit` and `write` tools are denied/i);
  assert.match(request, /thrown\s+away|discard/i);
});

test("the reviewer is told not to write its report to a file", () => {
  // Observed in a real panel: a model asked for a report reaches for somewhere
  // to save it, and that single write attempt discards the finished review.
  assert.match(buildRequest(base), /do NOT write your report to a file/i);
});

test("the reviewer is told a timeout scores zero, so it should triage", () => {
  // A reviewer that reads exhaustively and never reaches its final message
  // produces nothing at all, which is strictly worse than a shorter report.
  const request = buildRequest(base);
  assert.match(request, /stop reading and\s+write the report/i);
  assert.match(request, /worth exactly nothing|scores zero/i);
});

test("the request never tells the reviewer it has no shell at all", () => {
  // The old wording, kept as a negative assertion because it was true for a
  // year and is the obvious thing to reintroduce by accident.
  assert.ok(!/you have no shell/i.test(buildRequest(base)));
});

test("both lenses carry the shell boundary", () => {
  for (const lens of ["defect", "design"]) {
    assert.match(buildRequest({ ...base, lens }), /READ-ONLY/i);
  }
});

test("the defect lens asks for bugs and the design lens refuses to", () => {
  assert.match(buildRequest({ ...base, lens: "defect" }), /find what is WRONG/i);
  const design = buildRequest({ ...base, lens: "design" });
  assert.match(design, /challenging the APPROACH/i);
  assert.match(design, /Do not report implementation defects/i);
});

test("focus text is included only when supplied", () => {
  assert.ok(!buildRequest(base).includes("Focus from the author"));
  assert.match(buildRequest({ ...base, focus: "auth paths" }), /Focus from the author[\s\S]*auth paths/);
});

test("the reviewer is told to verify against real code, not just the hunks", () => {
  const request = buildRequest(base);
  assert.match(request, /read each changed file IN FULL/i);
  assert.match(request, /CALLER/);
});

test("both lenses forbid inventing findings to look thorough", () => {
  for (const lens of ["defect", "design"]) {
    const request = buildRequest({ ...base, lens });
    assert.match(request, /inventing findings to look\s+thorough is not/i);
    assert.match(request, /Never invent a file, a line, a call path/i);
  }
});

test("both lenses ask for JSON and show the findings schema", () => {
  for (const lens of ["defect", "design"]) {
    const request = buildRequest({ ...base, lens });
    assert.match(request, /Return ONE JSON object and nothing else/);
    for (const field of ["severity", "title", "body", "file", "line_start",
      "confidence", "grounding", "recommendation"]) {
      assert.match(request, new RegExp(`"${field}"`), `${lens} schema should show ${field}`);
    }
  }
});

test("the grounding field is explained in terms of what the reader does with it", () => {
  // A false `verified` sends the reader straight past the thing that was wrong,
  // so the prompt has to say why it matters, not just what the values are.
  assert.match(buildRequest(base), /false `verified` sends them past/i);
});

test("each lens shows only its own verdict vocabulary", () => {
  assert.match(buildRequest({ ...base, lens: "defect" }), /"SHIP" \| "REVISE" \| "RETHINK"/);
  assert.ok(!buildRequest({ ...base, lens: "defect" }).includes('"SOUND"'));
  assert.match(buildRequest({ ...base, lens: "design" }), /"SOUND" \| "RECONSIDER" \| "WRONG-SHAPE"/);
});

// ── rescue ───────────────────────────────────────────────────────────────────

const rescueBase = {
  problem: "the login test fails",
  repoRoot: "/repo",
  branch: "main",
  readOnly: false,
  allowCommands: false,
  contextDiff: "",
  focus: "",
};

test("the rescue prompt forbids touching git history", () => {
  const request = buildRescueRequest(rescueBase);
  assert.match(request, /Never touch git history/i);
  assert.match(request, /no commit/i);
});

test("the rescue prompt forbids weakening tests into passing", () => {
  assert.match(buildRescueRequest(rescueBase), /Do not weaken a test/i);
});

test("the rescue prompt demands the smallest change", () => {
  assert.match(buildRescueRequest(rescueBase), /[Ss]mallest change/);
});

test("write mode and read-only mode give opposite editing instructions", () => {
  assert.match(buildRescueRequest(rescueBase), /You have write access/i);
  const readOnly = buildRescueRequest({ ...rescueBase, readOnly: true });
  assert.match(readOnly, /edit and write tools are denied/i);
  assert.ok(!/You have write access/i.test(readOnly));
});

test("the problem statement reaches the prompt", () => {
  assert.match(buildRescueRequest(rescueBase), /the login test fails/);
});

test("context diff is included when present and omitted when not", () => {
  assert.ok(!buildRescueRequest(rescueBase).includes("uncommitted work"));
  assert.match(
    buildRescueRequest({ ...rescueBase, contextDiff: "+suspicious" }),
    /uncommitted work[\s\S]*\+suspicious/,
  );
});

test("the rescue prompt requires an explicit verification section", () => {
  assert.match(buildRescueRequest(rescueBase), /### Verification/);
});

test("without --allow-commands the rescue is told it cannot verify by running", () => {
  const request = buildRescueRequest(rescueBase);
  assert.match(request, /NO shell/i);
  assert.match(request, /could not verify the fix by\s+running it/i);
});

test("with --allow-commands the rescue is invited to run the relevant test", () => {
  const request = buildRescueRequest({ ...rescueBase, allowCommands: true });
  assert.match(request, /may run shell commands/i);
  assert.match(request, /single relevant test/i);
});

test("a read-only rescue is never invited to change anything", () => {
  const request = buildRescueRequest({ ...rescueBase, readOnly: true, allowCommands: false });
  assert.ok(!/may run shell commands/i.test(request));
  // It MAY read: a read-only rescue runs on the reviewer permissions, which
  // leave read-only commands available. What it must not think it can do is
  // change something.
  assert.match(request, /any command that\s+changes anything/i);
  assert.match(request, /describe the change you would make/i);
});
