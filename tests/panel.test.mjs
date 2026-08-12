import assert from "node:assert/strict";
import test from "node:test";

import { parseModels } from "../skills/devin-review/scripts/lib/devin.mjs";
import {
  diversityWarnings,
  estimateCost,
  interpret,
  runAndInterpret,
  runPanel,
} from "../skills/devin-review/scripts/lib/panel.mjs";

const DEFECT_REVIEW = JSON.stringify({
  verdict: "REVISE",
  summary: "The retry path needs fixing first.",
  findings: [
    { severity: "high", title: "Retry loop double-charges", body: "Two charges on timeout.",
      file: "billing.py", line_start: 88, line_end: 90, confidence: 0.8,
      grounding: "verified", recommendation: "Add an idempotency key." },
  ],
  next_steps: ["Fix the retry path."],
});

// ── interpretation ───────────────────────────────────────────────────────────

const raw = (over = {}) => ({
  model: "m", code: 0, stdout: DEFECT_REVIEW, stderr: "", durationSeconds: 5, ...over,
});

test("a clean run is usable and keeps the review text", () => {
  const result = interpret(raw(), "/repo");
  assert.equal(result.ok, true);
  assert.match(result.review, /Retry loop double-charges/);
});

test("a timeout is reported as a timeout, not as an empty answer", () => {
  const result = interpret(raw({ timedOut: true, code: 124, stdout: "" }), "/repo");
  assert.equal(result.ok, false);
  assert.equal(result.className, "timeout");
});

test("quota exhaustion on a NON-ZERO exit is still classified as quota", () => {
  // Devin reports quota with a non-zero exit; calling that "exit_error" hides
  // the one fact that tells the user what to do next.
  const result = interpret(
    raw({ code: 1, stdout: "", stderr: "Error: Agent error: Your weekly usage quota has been exhausted." }),
    "/repo",
  );
  assert.equal(result.className, "quota");
});

test("an unexplained non-zero exit stays a generic exit_error", () => {
  const result = interpret(raw({ code: 2, stdout: "", stderr: "segfault" }), "/repo");
  assert.equal(result.className, "exit_error");
});

test("exit 0 with empty stdout is never treated as a successful review", () => {
  const result = interpret(raw({ stdout: "   \n" }), "/repo");
  assert.equal(result.ok, false);
});

test("interpret strips file links by default and keeps them on request", () => {
  const withLink = raw({ stdout: "[/repo/a.py:1](file:///repo/a.py)\n\n### Verdict: SHIP\n" });
  assert.match(interpret(withLink, "/repo").review, /`a\.py:1`/);
  assert.match(interpret(withLink, "/repo", { keepLinks: true }).review, /file:\/\/\/repo/);
});

// ── the retry ────────────────────────────────────────────────────────────────
//
// A reviewer that reaches for a denied tool loses its whole turn and prints
// nothing. That is stochastic rather than deterministic, so one retry converts a
// large share of silent failures into reviews — but it doubles the spend on a
// model that is reliably failing, which is why the class list is narrow and the
// retry is capped at exactly one.

const silent = (model = "m") => ({ model, code: 0, stdout: "", stderr: "", durationSeconds: 3, denials: [] });
const good = (model = "m") => ({ model, code: 0, stdout: DEFECT_REVIEW, stderr: "", durationSeconds: 4 });

test("a blocked reviewer is retried once, and the retry's success is reported", async () => {
  let calls = 0;
  const result = await runAndInterpret({
    repoRoot: "/repo",
    model: "m",
    runner: async () => {
      calls += 1;
      return calls === 1
        ? { ...silent(), denials: [{ tool: "exec", detail: "git commit" }] }
        : good();
    },
  });
  assert.equal(calls, 2, "exactly one retry");
  assert.ok(result.ok);
  assert.equal(result.retried, true, "a silent retry would misreport what the review cost");
});

test("the retry is capped at one, and a second failure says so", async () => {
  let calls = 0;
  const result = await runAndInterpret({
    repoRoot: "/repo",
    model: "m",
    runner: async () => {
      calls += 1;
      return { ...silent(), denials: [{ tool: "exec", detail: "git commit" }] };
    },
  });
  assert.equal(calls, 2, "must not retry forever on a model that always fails");
  assert.equal(result.ok, false);
  assert.equal(result.retried, true);
  assert.match(result.reason, /retried once/i);
});

test("a timeout is never retried automatically", async () => {
  // interpret() marks a timeout retryable for a HUMAN. Retrying it here would
  // silently double the wall clock of a review someone is waiting on, and the
  // cause (usually a diff too large) would still be true the second time.
  let calls = 0;
  const result = await runAndInterpret({
    repoRoot: "/repo",
    model: "m",
    runner: async () => {
      calls += 1;
      return { model: "m", code: 124, stdout: "", stderr: "", durationSeconds: 600, timedOut: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.className, "timeout");
});

test("failures that a second run cannot fix are not retried", async () => {
  for (const [label, raw] of [
    ["quota", { ...silent(), code: 1, stderr: "Error: resource_exhausted quota exhausted" }],
    ["auth", { ...silent(), code: 1, stderr: "Error: unauthenticated, not logged in" }],
    ["cli_mismatch", { ...silent(), code: 2, stderr: "unexpected argument '--config' found" }],
  ]) {
    let calls = 0;
    const result = await runAndInterpret({
      repoRoot: "/repo",
      model: "m",
      runner: async () => {
        calls += 1;
        return raw;
      },
    });
    assert.equal(calls, 1, `${label} must not be retried`);
    assert.equal(result.retried, undefined, label);
  }
});

test("retry can be switched off entirely", async () => {
  let calls = 0;
  await runAndInterpret({
    repoRoot: "/repo",
    model: "m",
    retry: false,
    runner: async () => {
      calls += 1;
      return { ...silent(), denials: [{ tool: "exec", detail: "x" }] };
    },
  });
  assert.equal(calls, 1);
});

test("panel workers each get their own transcript path", async () => {
  // They share one work dir, so a shared export path would have each reviewer
  // overwriting the evidence of why the others failed.
  const seen = [];
  await runPanel({
    models: ["a", "b", "c"],
    concurrency: 3,
    repoRoot: "/repo",
    devinPath: "devin",
    requestFile: "/tmp/r",
    exportFileFor: (model) => `/tmp/transcript-${model}.json`,
    runner: async ({ model, exportFile }) => {
      seen.push(exportFile);
      return good(model);
    },
  });
  assert.equal(new Set(seen).size, 3, `transcript paths collided: ${seen.join(", ")}`);
});

// ── the pool ─────────────────────────────────────────────────────────────────

test("runPanel returns one result per model, in the order requested", async () => {
  const models = ["a", "b", "c", "d"];
  const results = await runPanel({
    models,
    concurrency: 2,
    repoRoot: "/repo",
    runner: null,
    devinPath: "devin",
    requestFile: "/tmp/r",
    // Injected through the module's own seam: runPanel calls runDevin, so the
    // pool is exercised here via a stubbed global in the sibling test below.
    ...stubRunner(async (model) => ({
      model, code: 0, stdout: `### Verdict: SHIP\n`, stderr: "", durationSeconds: 1,
    })),
  });
  assert.deepEqual(results.map((r) => r.model), models);
});

test("runPanel never exceeds its concurrency limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await runPanel({
    models: ["a", "b", "c", "d", "e"],
    concurrency: 2,
    repoRoot: "/repo",
    devinPath: "devin",
    requestFile: "/tmp/r",
    ...stubRunner(async (model) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { model, code: 0, stdout: "### Verdict: SHIP\n", stderr: "", durationSeconds: 1 };
    }),
  });
  assert.equal(results.length, 5);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("one model failing does not take down the rest of the panel", async () => {
  const results = await runPanel({
    models: ["good", "throws", "alsogood"],
    concurrency: 3,
    repoRoot: "/repo",
    devinPath: "devin",
    requestFile: "/tmp/r",
    ...stubRunner(async (model) => {
      if (model === "throws") throw new Error("spawn exploded");
      return { model, code: 0, stdout: "### Verdict: SHIP\n", stderr: "", durationSeconds: 1 };
    }),
  });
  assert.equal(results.filter((r) => r.ok).length, 2);
  const failed = results.find((r) => !r.ok);
  assert.equal(failed.className, "internal_error");
  assert.match(failed.reason, /spawn exploded/);
});

/**
 * runPanel takes its runner from the options bag when one is supplied, so the
 * pool's scheduling can be tested without spawning 5 agent sessions.
 */
function stubRunner(fn) {
  return { runner: ({ model }) => fn(model) };
}

// ── diversity and cost ───────────────────────────────────────────────────────

const ROSTER = parseModels(`Claude Opus 5 (claude-opus-5)
  claude-opus-5-high                     Opus High  [1M context, $5 / MTok In · $25 / MTok Out]
  claude-opus-5-max                      Opus Max  [1M context, $5 / MTok In · $25 / MTok Out]

Kimi K3 (kimi-k3)
  kimi-k3-high                           Kimi High  [1M context, $3 / MTok In · $15 / MTok Out]

SWE-1.7 (swe-1.7)
  swe-1-7                                SWE Max  [262K context, Free, beta]
`);

test("an all-Claude panel is called out as an echo, not a second opinion", () => {
  const warnings = diversityWarnings(["claude-opus-5-high", "claude-opus-5-max"], ROSTER);
  assert.ok(warnings.some((w) => /echo/i.test(w)));
});

test("a single-family panel is flagged even when it is not Claude", () => {
  const warnings = diversityWarnings(["claude-opus-5-high", "claude-opus-5-max"], ROSTER);
  assert.ok(warnings.some((w) => /one family/i.test(w)));
});

test("a genuinely mixed panel draws no warnings", () => {
  assert.deepEqual(diversityWarnings(["kimi-k3-high", "swe-1-7"], ROSTER), []);
});

test("a lone model is not a panel and is not warned about", () => {
  assert.deepEqual(diversityWarnings(["claude-opus-5-high"], ROSTER), []);
});

test("estimateCost charges nothing for free models and totals the rest", () => {
  const cost = estimateCost(["swe-1-7", "kimi-k3-high"], 40000, ROSTER);
  const free = cost.perModel.find((m) => m.model === "swe-1-7");
  assert.equal(free.free, true);
  assert.equal(free.dollars, 0);
  assert.ok(cost.total > 0);
});

test("estimateCost reports incompleteness rather than guessing a missing price", () => {
  const cost = estimateCost(["kimi-k3-high", "not-in-roster"], 1000, ROSTER);
  assert.equal(cost.complete, false);
  assert.equal(cost.perModel.find((m) => m.model === "not-in-roster").dollars, null);
});

test("estimateCost declines to invent a number without a roster", () => {
  assert.equal(estimateCost(["kimi-k3-high"], 1000, null), null);
});

// ── narration is not a review ────────────────────────────────────────────────

import { isEmptyNarration } from "../skills/devin-review/scripts/lib/panel.mjs";

test("short mid-investigation narration is a retryable empty_report, not a review", () => {
  // The observed failure: kimi-k3-high completed in 242s and its entire final
  // message was two sentences of narration. Rendering that under a "Reviewer:"
  // heading presents zero review content as a review.
  const result = interpret(
    raw({ stdout: "Now let me check how uvicorn logs access lines to see whether the middleware runs." }),
    "/repo",
  );
  assert.equal(result.ok, false);
  assert.equal(result.className, "empty_report");
  assert.equal(result.retryable, true);
  assert.match(result.reason, /narration/i);
  assert.match(result.reason, /uvicorn/, "the reason should quote what the model actually said");
});

test("a short prose verdict is kept as an unstructured review", () => {
  const result = interpret(raw({ stdout: "SHIP. Nothing material after reading the call sites." }), "/repo");
  assert.equal(result.ok, true);
  assert.equal(result.format, "unstructured");
});

test("a short prose finding with a file:line citation is kept", () => {
  const result = interpret(raw({ stdout: "The retry in billing.py:88 double-charges on timeout." }), "/repo");
  assert.equal(result.ok, true);
});

test("a short clean review without the formal vocabulary is kept, not discarded", () => {
  // Both panel reviewers (Gemini, GPT) caught the whitelist version throwing
  // these away and billing a retry. A stated conclusion is a review even when
  // it names no verdict, severity or line.
  for (const clean of [
    "No issues found after checking the changed call sites.",
    "I found no material defects; the change looks correct.",
    "Nothing of concern here. LGTM.",
    "Reviewed the diff and the surrounding code — this looks fine to me.",
  ]) {
    const result = interpret(raw({ stdout: clean }), "/repo");
    assert.equal(result.ok, true, `discarded a clean review: ${clean}`);
    assert.equal(result.format, "unstructured");
  }
});

test("long prose without JSON is always kept, whatever it says", () => {
  // Even long UNFINISHED-sounding prose is kept: length alone is enough signal
  // that the model did substantial work worth showing.
  const prose = "Now let me check the logging path and then I will look at the retry. ".repeat(12);
  const result = interpret(raw({ stdout: prose }), "/repo");
  assert.equal(result.ok, true);
  assert.equal(result.format, "unstructured");
});

test("a rescue narrative is never reclassified as an empty report", () => {
  // Rescue output is a short markdown narrative by design; its lens has no
  // verdict vocabulary and the heuristic must not touch it.
  const result = interpret(raw({ stdout: "### Root cause\nA one-line fix." }), "/repo", { lens: "none" });
  assert.equal(result.ok, true);
});

test("isEmptyNarration fires only on positively-unfinished output", () => {
  // Unfinished: an announced next action (lead + investigation verb), no conclusion.
  assert.equal(isEmptyNarration("Now let me look at the logging path.", "defect"), true);
  assert.equal(isEmptyNarration("I'll check the call sites next.", "defect"), true);
  // Not a review lens: never fires.
  assert.equal(isEmptyNarration("Now let me look at this.", "none"), false);
  // A stated conclusion, informal or formal, is kept.
  assert.equal(isEmptyNarration("RECONSIDER: the shape is wrong", "design"), false);
  assert.equal(isEmptyNarration("No issues found; looks correct to me.", "defect"), false);
  // Terse output that is neither a conclusion nor an announced action is kept
  // (inverted from the old whitelist, which would have discarded it).
  assert.equal(isEmptyNarration("Hmm, this is interesting code.", "defect"), false);
});

test("a short finding phrased with 'going to' or a singular noun is NOT discarded", () => {
  // A panel reviewer's false positives: "going to" as description (not "I'm
  // going to"), and singular finding nouns the old lists missed.
  for (const finding of [
    "This change is going to break on Node 18 because fs.rm options changed.",
    "There is a real bug here: the retry double-charges. No other issue.",
    "The findings are minor but the null check on line 12 is missing.",
    "I found no bug after tracing the call sites.",
  ]) {
    assert.equal(isEmptyNarration(finding, "defect"), false, `discarded a finding: ${finding}`);
    assert.equal(interpret(raw({ stdout: finding }), "/repo").ok, true);
  }
});

test("an empty_report is retried once and can succeed", async () => {
  let calls = 0;
  const result = await runAndInterpret({
    repoRoot: "/repo",
    model: "m",
    runner: async () => {
      calls += 1;
      return calls === 1
        ? { model: "m", code: 0, stdout: "Now let me check the logging path.", stderr: "", durationSeconds: 3 }
        : good();
    },
  });
  assert.equal(calls, 2);
  assert.ok(result.ok);
  assert.equal(result.retried, true);
});

// ── the corrective retry ─────────────────────────────────────────────────────

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

test("the retry request names the denied call and keeps the original request", async () => {
  // The naive retry was measured failing: glm-5-2's first move is
  // deterministically the denied one, so an identical second request died
  // identically. The retry only buys anything if it says what went wrong.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "devin-retry-test-"));
  try {
    const requestFile = path.join(dir, "review-request.md");
    await fsp.writeFile(requestFile, "ORIGINAL REQUEST BODY");
    const attempts = [];
    let calls = 0;
    const result = await runAndInterpret({
      repoRoot: "/repo",
      model: "m",
      requestFile,
      exportFile: path.join(dir, "transcript-m.json"),
      runner: async ({ requestFile: rf, exportFile: ef }) => {
        calls += 1;
        attempts.push({ rf, ef });
        return calls === 1
          ? { ...silent(), denials: [{ tool: "exec", detail: 'python -c "import inspect"' }] }
          : good();
      },
    });
    assert.ok(result.ok);
    assert.notEqual(attempts[1].rf, attempts[0].rf, "the retry must not resend the identical request");
    const amended = await fsp.readFile(attempts[1].rf, "utf8");
    assert.match(amended, /Second attempt/i);
    assert.match(amended, /python -c/, "the note should name the exact call that killed attempt one");
    assert.match(amended, /site-packages|node_modules/, "and say how to read dependencies instead");
    assert.ok(amended.includes("ORIGINAL REQUEST BODY"), "the full original request must survive");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("the retry writes its transcript beside the first attempt's, not over it", async () => {
  // The first attempt's transcript is the evidence of WHY there is a retry at
  // all; runDevin deletes a stale export before running, so a shared path would
  // destroy it.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "devin-retry-test-"));
  try {
    const requestFile = path.join(dir, "review-request.md");
    await fsp.writeFile(requestFile, "R");
    const exports = [];
    let calls = 0;
    await runAndInterpret({
      repoRoot: "/repo",
      model: "m",
      requestFile,
      exportFile: path.join(dir, "transcript-m.json"),
      runner: async ({ exportFile }) => {
        calls += 1;
        exports.push(exportFile);
        return { ...silent(), denials: [{ tool: "exec", detail: "x" }] };
      },
    });
    assert.notEqual(exports[1], exports[0]);
    assert.match(exports[1], /-retry\.json$/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a retry without a request file still runs, unamended", async () => {
  // retryOverrides is best-effort; the old behaviour is its fallback.
  let calls = 0;
  const result = await runAndInterpret({
    repoRoot: "/repo",
    model: "m",
    runner: async () => {
      calls += 1;
      return calls === 1 ? { ...silent(), denials: [{ tool: "exec", detail: "x" }] } : good();
    },
  });
  assert.equal(calls, 2);
  assert.ok(result.ok);
});

test("runPanel threads the sandbox decision through to every runner", async () => {
  const seen = [];
  await runPanel({
    models: ["a", "b"],
    concurrency: 2,
    repoRoot: "/repo",
    devinPath: "devin",
    requestFile: "/tmp/r",
    sandbox: true,
    runner: async ({ model, sandbox }) => {
      seen.push(sandbox);
      return good(model);
    },
  });
  assert.deepEqual(seen, [true, true]);
});

test("a lowercase prose verdict is still a review (found by review)", () => {
  // Gemini's HIGH: the verdict regex was case-sensitive, so "Verdict: ship —
  // no defects found" was discarded as empty_report while "SHIP" survived.
  const result = interpret(raw({ stdout: "Verdict: ship — no defects found after checking call sites." }), "/repo");
  assert.equal(result.ok, true);
});

test("a citation with a long extension is still a review (found by review)", () => {
  const result = interpret(raw({ stdout: "The oneof in api.proto:42 breaks old readers." }), "/repo");
  assert.equal(result.ok, true);
});

test("the sandboxed retry note does not forbid interpreters", async () => {
  // Found independently by self-review and by Gemini: the screened-path note
  // says "do not launch an interpreter", which contradicts the sandboxed
  // prompt that explicitly offers python one-liners.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "devin-retry-test-"));
  try {
    const requestFile = path.join(dir, "review-request.md");
    await fsp.writeFile(requestFile, "R");
    const files = [];
    let calls = 0;
    await runAndInterpret({
      repoRoot: "/repo",
      model: "m",
      requestFile,
      sandbox: true,
      runner: async ({ requestFile: rf }) => {
        calls += 1;
        files.push(rf);
        return calls === 1 ? { ...silent(), denials: [{ tool: "edit", detail: "x.py" }] } : good();
      },
    });
    const amended = await fsp.readFile(files[1], "utf8");
    assert.ok(!/instead of launching an interpreter/i.test(amended));
    assert.match(amended, /PRINTED as your final message/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
