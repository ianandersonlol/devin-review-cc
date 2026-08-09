import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, parseDuration, UsageError } from "../skills/devin-review/scripts/lib/args.mjs";
import { MODEL_DEFAULT, PANEL_DEFAULT } from "../skills/devin-review/scripts/lib/devin.mjs";

test("review is the default subcommand", () => {
  assert.equal(parseArgs([]).subcommand, "review");
  assert.equal(parseArgs(["--staged"]).subcommand, "review");
});

test("challenge selects the design lens and review the defect lens", () => {
  assert.equal(parseArgs(["challenge"]).lens, "design");
  assert.equal(parseArgs(["review"]).lens, "defect");
  assert.equal(parseArgs(["panel"]).lens, "defect");
});

test("--lens overrides the subcommand's default", () => {
  assert.equal(parseArgs(["review", "--lens", "design"]).lens, "design");
  assert.equal(parseArgs(["challenge", "--lens", "defect"]).lens, "defect");
});

test("an unknown lens is rejected", () => {
  assert.throws(() => parseArgs(["--lens", "vibes"]), UsageError);
});

test("bare words scope paths everywhere except rescue", () => {
  assert.deepEqual(parseArgs(["src/", "lib/"]).paths, ["src/", "lib/"]);
  assert.deepEqual(parseArgs(["rescue", "the", "test", "fails"]).problem, "the test fails");
});

test("paths after -- are paths even for rescue", () => {
  const options = parseArgs(["rescue", "tests fail", "--", "src/auth"]);
  assert.equal(options.problem, "tests fail");
  assert.deepEqual(options.paths, ["src/auth"]);
});

test("an unknown flag is rejected rather than silently ignored", () => {
  assert.throws(() => parseArgs(["--reviewww"]), UsageError);
});

test("a flag missing its value is rejected", () => {
  assert.throws(() => parseArgs(["--model"]), UsageError);
  assert.throws(() => parseArgs(["--base"]), UsageError);
});

// ── models and panels ────────────────────────────────────────────────────────

test("a plain review runs the single default model", () => {
  assert.deepEqual(parseArgs([]).models, [MODEL_DEFAULT]);
});

test("panel without an explicit roster uses the default panel", () => {
  assert.deepEqual(parseArgs(["panel"]).models, PANEL_DEFAULT);
});

test("--panel is shorthand for the default panel on any subcommand", () => {
  assert.deepEqual(parseArgs(["review", "--panel"]).models, PANEL_DEFAULT);
  assert.deepEqual(parseArgs(["challenge", "--panel"]).models, PANEL_DEFAULT);
});

test("--models on review turns it into a panel", () => {
  // Reviewing with only the first of several named models would be a quiet way
  // to charge for one opinion while looking like it gave three.
  assert.deepEqual(parseArgs(["review", "--models", "a,b"]).models, ["a", "b"]);
});

test("--models tolerates spaces and drops empty entries", () => {
  assert.deepEqual(parseArgs(["--models", " a , b ,, c "]).models, ["a", "b", "c"]);
});

test("--models deduplicates, because paying twice for one opinion is a typo", () => {
  assert.deepEqual(parseArgs(["--models", "a,b,a"]).models, ["a", "b"]);
});

test("an empty --models list is rejected", () => {
  assert.throws(() => parseArgs(["--models", ","]), UsageError);
});

test("--concurrency must be a positive integer", () => {
  assert.equal(parseArgs(["--concurrency", "5"]).concurrency, 5);
  assert.throws(() => parseArgs(["--concurrency", "0"]), UsageError);
  assert.throws(() => parseArgs(["--concurrency", "-2"]), UsageError);
  assert.throws(() => parseArgs(["--concurrency", "many"]), UsageError);
});

test("rescue refuses a multi-model panel", () => {
  // Two agents editing one working tree would interleave their changes into a
  // patch neither of them intended.
  assert.throws(() => parseArgs(["rescue", "broken", "--models", "a,b"]), UsageError);
});

test("rescue accepts a single explicit model", () => {
  assert.deepEqual(parseArgs(["rescue", "broken", "--models", "a"]).models, ["a"]);
  assert.deepEqual(parseArgs(["rescue", "broken", "--model", "a"]).models, ["a"]);
});

// ── durations ────────────────────────────────────────────────────────────────

test("parseDuration understands the Go-style spellings", () => {
  assert.equal(parseDuration("30s"), 30000);
  assert.equal(parseDuration("10m"), 600000);
  assert.equal(parseDuration("1h"), 3600000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("1.5m"), 90000);
});

test("a bare number is read as seconds rather than rejected", () => {
  assert.equal(parseDuration("45"), 45000);
  assert.equal(parseArgs(["--timeout", "45"]).timeoutMs, 45000);
});

test("an unparseable duration is rejected with a usage error", () => {
  assert.equal(parseDuration("soon"), null);
  assert.throws(() => parseArgs(["--timeout", "soon"]), UsageError);
});

// ── rescue safety flags ──────────────────────────────────────────────────────

test("rescue demands a problem statement", () => {
  assert.throws(() => parseArgs(["rescue"]), UsageError);
});

test("rescue --help does not demand a problem statement", () => {
  assert.equal(parseArgs(["rescue", "--help"]).help, true);
});

test("--problem and bare words compose", () => {
  assert.equal(parseArgs(["rescue", "--problem", "login", "is broken"]).problem, "login is broken");
});

test("rescue defaults to write-capable with an explicit read-only opt-out", () => {
  assert.equal(parseArgs(["rescue", "x"]).readOnly, false);
  assert.equal(parseArgs(["rescue", "x", "--read-only"]).readOnly, true);
});

test("--read-only and --allow-commands cannot be combined", () => {
  // Guessing which one was meant is exactly the kind of helpfulness that edits
  // a file somebody wanted left alone.
  assert.throws(() => parseArgs(["rescue", "x", "--read-only", "--allow-commands"]), UsageError);
});

test("--allow-commands is rejected outside rescue", () => {
  assert.throws(() => parseArgs(["review", "--allow-commands"]), UsageError);
  assert.throws(() => parseArgs(["challenge", "--allow-commands"]), UsageError);
  assert.doesNotThrow(() => parseArgs(["rescue", "x", "--allow-commands"]));
});

test("secrets are only waived when explicitly asked for", () => {
  assert.equal(parseArgs([]).allowSecrets, false);
  assert.equal(parseArgs(["--allow-secrets"]).allowSecrets, true);
});

test("--model beats the panel default rather than being silently ignored", () => {
  // `panel --model kimi-k3-high` must not quietly review with three models the
  // user did not name.
  assert.deepEqual(parseArgs(["panel", "--model", "kimi-k3-high"]).models, ["kimi-k3-high"]);
});

test("--model and --models are mutually exclusive", () => {
  assert.throws(() => parseArgs(["--model", "a", "--models", "b,c"]), UsageError);
});

test("--panel still wins for a bare panel invocation", () => {
  assert.deepEqual(parseArgs(["panel"]).models, PANEL_DEFAULT);
  assert.deepEqual(parseArgs(["review", "--panel"]).models, PANEL_DEFAULT);
});

test("--timeout 0 is rejected rather than silently disabling the timeout", () => {
  // exec treats a falsy timeout as "no timeout", so 0 would hang forever.
  assert.throws(() => parseArgs(["--timeout", "0"]), UsageError);
  assert.throws(() => parseArgs(["--timeout", "0s"]), UsageError);
  assert.throws(() => parseArgs(["--timeout", "0ms"]), UsageError);
});

test("--concurrency rejects partial numbers instead of silently truncating", () => {
  // parseInt reads "2junk" as 2 and "1.5" as 1, so a typo becomes a different
  // fan-out than the one that was typed.
  assert.throws(() => parseArgs(["--concurrency", "2junk"]), UsageError);
  assert.throws(() => parseArgs(["--concurrency", "1.5"]), UsageError);
  assert.throws(() => parseArgs(["--concurrency", " 3"]), UsageError);
});

test("--concurrency is capped to catch a runaway fan-out typo", () => {
  assert.throws(() => parseArgs(["--concurrency", "300"]), UsageError);
  assert.equal(parseArgs(["--concurrency", "16"]).concurrency, 16);
});

test("repository hooks are only run with an explicit opt-in", () => {
  assert.equal(parseArgs([]).allowHooks, false);
  assert.equal(parseArgs(["--allow-hooks"]).allowHooks, true);
});
