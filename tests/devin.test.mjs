import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEmptyOutput,
  isCorrelatedModel,
  MODE_READ_ONLY,
  MODE_WRITE,
  MODE_WRITE_AND_RUN,
  modelExists,
  PANEL_DEFAULT,
  parseModels,
  readOnlyAgentConfig,
  rescueAgentConfig,
  resolveMode,
  runDevin,
  stripFileLinks,
  tidyError,
} from "../skills/devin-review/scripts/lib/devin.mjs";

// ── the read-only invariant ──────────────────────────────────────────────────
//
// These are the tests that matter most. "review and challenge cannot write" is
// the promise the whole tool rests on, and it is enforced in exactly one place
// so that it can be checked in exactly one place.

test("only rescue can ever select a writing mode", () => {
  for (const subcommand of ["review", "challenge", "panel", "setup", "status", "models"]) {
    assert.equal(resolveMode(subcommand, false), MODE_READ_ONLY, subcommand);
    assert.equal(resolveMode(subcommand, false, true), MODE_READ_ONLY, `${subcommand} + allowCommands`);
  }
});

test("an unrecognised subcommand falls back to read-only", () => {
  assert.equal(resolveMode("something-new", false, true), MODE_READ_ONLY);
});

test("rescue writes by default and honours --read-only", () => {
  assert.equal(resolveMode("rescue", false), MODE_WRITE);
  assert.equal(resolveMode("rescue", true), MODE_READ_ONLY);
});

test("only rescue with --allow-commands reaches the bypass mode", () => {
  assert.equal(resolveMode("rescue", false, true), MODE_WRITE_AND_RUN);
  // --read-only must win: a contradictory pair should never escalate.
  assert.equal(resolveMode("rescue", true, true), MODE_READ_ONLY);
});

test("runDevin refuses an unrecognised permission mode outright", async () => {
  await assert.rejects(
    () => runDevin({ devinPath: "devin", repoRoot: "/tmp", requestFile: "/tmp/x", model: "m", mode: "autonomous" }),
    /unrecognised permission mode/,
  );
});

test("the read-only agent config denies every tool that can mutate anything", () => {
  const config = readOnlyAgentConfig();
  const deny = config.permissions.deny;
  // Named individually rather than looped, so that a tool dropped from the
  // source list fails here instead of silently reducing the guarantee.
  for (const tool of ["edit", "write", "notebook_edit", "exec", "write_to_process",
    "run_subagent", "request_scope", "mcp_call_tool"]) {
    assert.ok(deny.includes(tool), `expected ${tool} to be denied`);
  }
  assert.ok(deny.includes("Write(**)"), "expected a blanket write-scope denial");
});

test("the read-only agent config allows nothing that can mutate anything", () => {
  const config = readOnlyAgentConfig();
  for (const allowed of config.permissions.allow) {
    assert.ok(
      !/^(edit|write|exec|notebook_edit|run_subagent|request_scope)$/.test(allowed),
      `${allowed} must not be allowed to a reviewer`,
    );
    assert.ok(!allowed.startsWith("Write("), `${allowed} must not grant a write scope`);
  }
});

test("the rescue config bars git wholesale, not a list of subcommands", () => {
  // An enumerated list missed `git clean`, which destroys untracked files —
  // the one class of change git cannot restore, and therefore the one that
  // breaks the "just revert it" recovery model outright.
  const deny = rescueAgentConfig({ allowCommands: true }).permissions.deny;
  assert.ok(deny.includes("Exec(git)"), "git must be denied as a whole command");
  assert.ok(deny.includes("Exec(rm)") && deny.includes("Exec(sudo)"));
  assert.ok(deny.includes("Write(.git/**)"));
});

test("no rescue mode ever grants a subagent or a permission escalation", () => {
  for (const allowCommands of [true, false]) {
    const deny = rescueAgentConfig({ allowCommands }).permissions.deny;
    assert.ok(deny.includes("run_subagent"), "a subagent could carry different permissions");
    assert.ok(deny.includes("request_scope"), "the agent must not be able to ask for more");
  }
});

test("rescue without --allow-commands denies the shell outright", () => {
  const deny = rescueAgentConfig({ allowCommands: false }).permissions.deny;
  assert.ok(deny.includes("exec"));
  assert.ok(!rescueAgentConfig({ allowCommands: true }).permissions.deny.includes("exec"));
});

test("the no-shell rescue tells the model it cannot verify, rather than letting it try", () => {
  // A denied tool call discards the whole turn, so the instruction has to
  // pre-empt the attempt rather than rely on the denial catching it.
  const instructions = rescueAgentConfig({ allowCommands: false })["system-instructions"].join(" ");
  assert.match(instructions, /NO shell/i);
  assert.match(instructions, /ends your turn|discards/i);
});

// ── model roster parsing ─────────────────────────────────────────────────────

const SAMPLE = `Available models (3 families)

Claude Opus 5 (claude-opus-5)
  aliases: opus
  claude-opus-5-medium                   Claude Opus 5 Medium  [1M context, $5 / MTok In · $25 / MTok Out]
  claude-opus-5-high                     Claude Opus 5 High  [1M context, $5 / MTok In · $25 / MTok Out]

Kimi K3 (kimi-k3)
  kimi-k3-high                           Kimi K3 High  [1048576 context, $3 / MTok In · $15 / MTok Out]

SWE-1.7 (swe-1.7)
  swe-1-7                                SWE-1.7 Max  [262K context, Free, beta]
`;

test("parseModels reads families, members, aliases and prices", () => {
  const { models, families } = parseModels(SAMPLE);
  assert.equal(families.length, 3);
  assert.equal(models.length, 4);

  const opus = models.find((m) => m.id === "claude-opus-5-medium");
  assert.equal(opus.family, "claude-opus-5");
  assert.equal(opus.inputPrice, 5);
  assert.equal(opus.outputPrice, 25);
  assert.equal(opus.context, 1e6);
  assert.equal(opus.free, false);

  assert.deepEqual(families.find((f) => f.id === "claude-opus-5").aliases, ["opus"]);
});

test("parseModels marks free and beta models", () => {
  const swe = parseModels(SAMPLE).models.find((m) => m.id === "swe-1-7");
  assert.equal(swe.free, true);
  assert.equal(swe.beta, true);
  assert.equal(swe.inputPrice, null);
  assert.equal(swe.context, 262000);
});

test("parseModels handles a raw token count without a K/M suffix", () => {
  const kimi = parseModels(SAMPLE).models.find((m) => m.id === "kimi-k3-high");
  assert.equal(kimi.context, 1048576);
});

test("parseModels returns nothing rather than guessing at unrecognised output", () => {
  assert.equal(parseModels("some unrelated banner text\n").models.length, 0);
});

test("modelExists accepts ids and family aliases, rejects typos", () => {
  const roster = parseModels(SAMPLE);
  assert.ok(modelExists(roster, "kimi-k3-high"));
  assert.ok(modelExists(roster, "opus"), "family alias should resolve");
  assert.ok(modelExists(roster, "claude-opus-5"), "family id should resolve");
  assert.ok(!modelExists(roster, "kimi-k3-hihg"));
});

test("modelExists does not block when the roster is unknown", () => {
  // An unreachable roster must not stop a review that would otherwise work.
  assert.ok(modelExists(null, "anything-at-all"));
});

test("the default panel is three distinct vendors and excludes Claude", () => {
  assert.equal(new Set(PANEL_DEFAULT).size, PANEL_DEFAULT.length);
  assert.ok(PANEL_DEFAULT.length >= 3);
  for (const model of PANEL_DEFAULT) {
    assert.ok(!isCorrelatedModel(model), `${model} correlates with the orchestrating assistant`);
  }
});

test("isCorrelatedModel catches Claude checkpoints and nothing else", () => {
  assert.ok(isCorrelatedModel("claude-opus-5-high"));
  assert.ok(isCorrelatedModel("CLAUDE-SONNET-5-MAX"));
  assert.ok(!isCorrelatedModel("gpt-5-6-sol-high"));
  assert.ok(!isCorrelatedModel("kimi-k3-high"));
});

// ── failure classification ───────────────────────────────────────────────────

test("a rejected tool call is named as such, not reported as an empty answer", () => {
  const { className, retryable } = classifyEmptyOutput(
    "warning: rejected a tool call that requires confirmation. Running in non-interactive mode.",
    12,
  );
  assert.equal(className, "blocked_tool");
  assert.equal(retryable, true);
});

test("the blocked_tool explanation makes no claim about what was written", () => {
  // Shared with rescue, where Devin may have edited files and THEN hit a denied
  // command. Promising "nothing was written" there would be false exactly when
  // it matters most; write state comes from the tree snapshots instead.
  const { reason } = classifyEmptyOutput("rejected a tool call that requires confirmation", 1);
  assert.ok(!/nothing was written/i.test(reason), `must not assert write state: ${reason}`);
  assert.match(reason, /not allowed|shell command/i);
});

test("quota exhaustion is classified as quota and marked unretryable", () => {
  const { className, retryable } = classifyEmptyOutput(
    'Error: Agent error: Your weekly usage quota has been exhausted. (trace ID: abc123): {"cognition.ai/errorKind": "resource_exhausted"}',
    2,
  );
  assert.equal(className, "quota");
  assert.equal(retryable, false);
});

test("organisation policy blocks are distinguished from auth failures", () => {
  assert.equal(
    classifyEmptyOutput("Mode 'autonomous' is restricted by your organization's policy", 1).className,
    "org_policy",
  );
});

test("an empty answer with no explanation still reports the elapsed time", () => {
  const { className, reason } = classifyEmptyOutput("", 47);
  assert.equal(className, "empty_output");
  assert.match(reason, /47s/);
});

test("tidyError keeps the sentence and drops the trace id and JSON tail", () => {
  const tidied = tidyError(
    'Error: Agent error: Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage. (trace ID: 2a25a21e): {\n  "cognition.ai/errorKind": "resource_exhausted"\n}',
  );
  assert.match(tidied, /weekly usage quota has been exhausted/);
  assert.ok(!tidied.includes("trace ID"));
  assert.ok(!tidied.includes("errorKind"));
});

test("tidyError leaves an ordinary message alone", () => {
  assert.equal(tidyError("something went wrong"), "something went wrong");
  assert.equal(tidyError(""), "");
});

// ── output cleanup ───────────────────────────────────────────────────────────

test("stripFileLinks relativises repo paths and keeps the label", () => {
  const stripped = stripFileLinks(
    "- **Where:** [/repo/src/a.py:12](file:///repo/src/a.py)",
    "/repo",
  );
  assert.equal(stripped, "- **Where:** `src/a.py:12`");
});

test("stripFileLinks leaves ordinary markdown links untouched", () => {
  const text = "see [the docs](https://example.com/x)";
  assert.equal(stripFileLinks(text, "/repo"), text);
});

test("stripFileLinks never drops the label text it cannot relativise", () => {
  const stripped = stripFileLinks("[calc.py:1-2](file:///elsewhere/calc.py)", "/repo");
  assert.equal(stripped, "`calc.py:1-2`");
});

test("parseModels reads a member line separated by a single tab", () => {
  const { models } = parseModels("Kimi K3 (kimi-k3)\n  kimi-k3-high\tKimi K3 High  [1M context, Free]\n");
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "kimi-k3-high");
  assert.equal(models[0].free, true);
});
