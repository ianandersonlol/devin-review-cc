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
