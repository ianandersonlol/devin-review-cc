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

test("the request tells the reviewer it has no shell", () => {
  // Load-bearing: a denied tool call ends the turn and discards the whole
  // review, so the model has to be told before it reaches for exec.
  const request = buildRequest(base);
  assert.match(request, /You have no shell/i);
  assert.match(request, /thrown\s+away|discard/i);
});

test("both lenses carry the no-shell warning", () => {
  for (const lens of ["defect", "design"]) {
    assert.match(buildRequest({ ...base, lens }), /no shell/i);
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
    assert.match(buildRequest({ ...base, lens }), /do not (invent|manufacture)/i);
  }
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
  assert.match(buildRescueRequest({ ...rescueBase, readOnly: true }), /do NOT edit any files/i);
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

test("a read-only rescue is never told it may run commands", () => {
  const request = buildRescueRequest({ ...rescueBase, readOnly: true, allowCommands: false });
  assert.ok(!/may run shell commands/i.test(request));
  assert.match(request, /do NOT run commands/i);
});
