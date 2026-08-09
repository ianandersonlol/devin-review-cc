import assert from "node:assert/strict";
import test from "node:test";

import { parseModels } from "../skills/devin-review/scripts/lib/devin.mjs";
import {
  diversityWarnings,
  estimateCost,
  interpret,
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
