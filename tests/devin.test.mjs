import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSessionConfig,
  classifyEmptyOutput,
  describeDenials,
  isCorrelatedModel,
  missingFlags,
  MODE_READ_ONLY,
  MODE_WRITE,
  MODE_WRITE_AND_RUN,
  modelExists,
  PANEL_DEFAULT,
  parseModels,
  readOnlyPermissions,
  readTranscriptDenials,
  readUserConfig,
  REQUIRED_FLAGS,
  rescuePermissions,
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

test("the reviewer permissions deny every tool that can change the repository", () => {
  const deny = readOnlyPermissions().deny;
  // Named individually rather than looped, so that a tool dropped from the
  // source list fails here instead of silently reducing the guarantee.
  for (const tool of ["edit", "write", "notebook_edit", "write_to_process",
    "run_subagent", "request_scope", "mcp_call_tool"]) {
    assert.ok(deny.includes(tool), `expected ${tool} to be denied`);
  }
  assert.ok(deny.includes("Write(**)"), "expected a blanket write-scope denial");
});

test("a reviewer never gets exec in EITHER permission list", () => {
  // This is the subtle one, and it is why the assertion is about both lists.
  //
  // `permissions.allow` AUTO-APPROVES a tool: with `exec` allowed, Devin ran
  // `echo pwned > file` and wrote the file even under --permission-mode auto.
  // Denying it outright is also wrong — it costs the reviewer `git log` for a
  // write guarantee that `auto` already provides. Unlisted is the only correct
  // state, so both memberships are asserted rather than just the dangerous one.
  const { allow, deny } = readOnlyPermissions();
  assert.ok(!allow.includes("exec"), "allowing exec auto-approves writing commands");
  assert.ok(!deny.includes("exec"), "denying exec costs read-only commands for nothing");
});

test("write_to_process stays denied precisely because exec is not", () => {
  // The command classifier judges a command STRING, so `exec("python3")` reads
  // as read-only. Typing into that process afterwards would be an unclassified
  // shell, so this denial is what keeps the classifier meaningful.
  assert.ok(readOnlyPermissions().deny.includes("write_to_process"));
});

test("the reviewer permissions allow nothing that can mutate anything", () => {
  for (const allowed of readOnlyPermissions().allow) {
    assert.ok(
      !/^(edit|write|exec|notebook_edit|run_subagent|request_scope)$/.test(allowed),
      `${allowed} must not be allowed to a reviewer`,
    );
    assert.ok(!allowed.startsWith("Write("), `${allowed} must not grant a write scope`);
  }
});

test("the rescue permissions bar git wholesale, not a list of subcommands", () => {
  // An enumerated list missed `git clean`, which destroys untracked files —
  // the one class of change git cannot restore, and therefore the one that
  // breaks the "just revert it" recovery model outright.
  const deny = rescuePermissions({ allowCommands: true }).deny;
  assert.ok(deny.includes("Exec(git)"), "git must be denied as a whole command");
  assert.ok(deny.includes("Exec(rm)") && deny.includes("Exec(sudo)"));
  assert.ok(deny.includes("Write(.git/**)"));
});

test("no rescue mode ever grants a subagent or a permission escalation", () => {
  for (const allowCommands of [true, false]) {
    const deny = rescuePermissions({ allowCommands }).deny;
    // Subagents were tested and DO inherit the session's denials — a subagent
    // told to edit a file failed and the file was untouched. So this denial is
    // not the load-bearing safety boundary it was once assumed to be; it stays
    // because a rescue has no use for subagents and they burn wall clock, and
    // because denying an unscoped tool is recoverable rather than turn-ending.
    assert.ok(deny.includes("run_subagent"), "a rescue has no legitimate use for a subagent");
    assert.ok(deny.includes("request_scope"), "the agent must not be able to ask for more");
  }
});

test("rescue without --allow-commands denies the shell outright", () => {
  const deny = rescuePermissions({ allowCommands: false }).deny;
  assert.ok(deny.includes("exec"));
  assert.ok(!rescuePermissions({ allowCommands: true }).deny.includes("exec"));
});

// ── the session config ───────────────────────────────────────────────────────

test("the session config forces our permissions over whatever the user set", () => {
  const merged = buildSessionConfig(
    { permissions: { allow: ["edit", "write", "Write(**)"], deny: [] } },
    readOnlyPermissions(),
  );
  assert.ok(!merged.permissions.allow.includes("edit"), "a user config must not widen a reviewer");
  assert.ok(merged.permissions.deny.includes("edit"));
});

test("the session config preserves settings a review still needs", () => {
  // --config REPLACES the user file rather than layering over it, so anything
  // not copied forward is simply absent: org_id and proxy among them.
  const merged = buildSessionConfig(
    { version: 1, devin: { org_id: "org-abc" }, proxy: { url: "http://p" }, theme_mode: "dark" },
    readOnlyPermissions(),
  );
  assert.equal(merged.devin.org_id, "org-abc");
  assert.equal(merged.proxy.url, "http://p");
  assert.equal(merged.theme_mode, "dark");
});

test("the session config always marks setup complete", () => {
  // Without this the CLI prints its first-run welcome banner into stdout, ahead
  // of the JSON report we are about to parse.
  assert.equal(buildSessionConfig({}, readOnlyPermissions()).shell.setup_complete, true);
  assert.equal(
    buildSessionConfig({ shell: { startup_messages_remaining: 3 } }, readOnlyPermissions()).shell
      .startup_messages_remaining,
    3,
  );
});

test("a corrupt config at one location does not discard a valid one below it", async () => {
  // Found by the panel. The loop `continue`s past an unreadable file but used to
  // `return {}` on an unparseable one, so a stale DEVIN_REVIEW_USER_CONFIG or a
  // half-written XDG copy silently dropped org_id and proxy from the real
  // config — surfacing later as an auth error nobody traces back to this code.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-cfg-"));
  const corrupt = path.join(dir, "corrupt.json");
  const valid = path.join(dir, "devin", "config.json");
  const saved = { override: process.env.DEVIN_REVIEW_USER_CONFIG, xdg: process.env.XDG_CONFIG_HOME };
  try {
    await fs.writeFile(corrupt, "{ this is not json");
    await fs.mkdir(path.dirname(valid), { recursive: true });
    await fs.writeFile(valid, JSON.stringify({ devin: { org_id: "org-real" } }));

    process.env.DEVIN_REVIEW_USER_CONFIG = corrupt;
    process.env.XDG_CONFIG_HOME = dir;
    assert.equal((await readUserConfig()).devin?.org_id, "org-real");
  } finally {
    if (saved.override === undefined) delete process.env.DEVIN_REVIEW_USER_CONFIG;
    else process.env.DEVIN_REVIEW_USER_CONFIG = saved.override;
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.xdg;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rescue is never told that re-running usually works", () => {
  // classifyEmptyOutput is shared with rescue, which by design is NEVER retried
  // automatically because it may already have edited files. Advising the user to
  // re-run by hand is the same hazard the code refuses to take on itself.
  const denials = [{ tool: "exec", detail: "npm test" }];
  const review = classifyEmptyOutput("", 5, denials, { canRetry: true });
  const rescue = classifyEmptyOutput("", 5, denials, { canRetry: false });

  assert.match(review.reason, /Re-running often succeeds/i);
  assert.ok(!/Re-running often succeeds/i.test(rescue.reason), rescue.reason);
  assert.match(rescue.reason, /diff of what it changed/i);
  // Neither may claim nothing was written: in a rescue that would be false
  // exactly when it matters most.
  for (const { reason } of [review, rescue]) assert.ok(!/nothing was written/i.test(reason));
});

test("the session config survives a missing or junk user config", () => {
  for (const input of [undefined, null, {}, "nonsense", 42]) {
    const merged = buildSessionConfig(input, readOnlyPermissions());
    assert.equal(merged.shell.setup_complete, true);
    assert.ok(merged.permissions.deny.includes("edit"));
  }
});

// ── CLI compatibility ────────────────────────────────────────────────────────

test("every flag the plugin passes is checked against the installed CLI", () => {
  // The regression this guards: --agent-config was removed, it was the FIRST
  // argument on the line, and so every model in a panel died at argv parsing
  // with an identical error that named the plugin rather than the CLI.
  for (const flag of ["--config", "--prompt-file", "--model", "--permission-mode", "--export"]) {
    assert.ok(REQUIRED_FLAGS.includes(flag), `${flag} must be part of the compatibility contract`);
  }
});

test("missing flags are reported, and an unreadable help screen is not a failure", () => {
  assert.deepEqual(missingFlags(new Set(REQUIRED_FLAGS)), []);
  assert.deepEqual(missingFlags(new Set(REQUIRED_FLAGS.filter((f) => f !== "--config"))), ["--config"]);
  // null means "could not read --help", which must not block a review.
  assert.deepEqual(missingFlags(null), []);
});

test("a CLI that rejects our arguments is classified as a mismatch, not a dead model", () => {
  const { className, reason, retryable } = classifyEmptyOutput(
    "error: unexpected argument '--agent-config' found",
    1,
  );
  assert.equal(className, "cli_mismatch");
  assert.equal(retryable, false);
  assert.match(reason, /--agent-config/);
  assert.match(reason, /changed underneath/i);
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

test("a silent denial is still classified as blocked_tool, from the transcript", () => {
  // The regression this pins down. A `permissions.deny` hit prints NOTHING —
  // exit 0, empty stdout, empty stderr — so classifying on stderr alone reported
  // our own deny list as a generic "returned no output". The exported transcript
  // is the only witness that a tool was refused at all.
  const { className, reason, retryable } = classifyEmptyOutput("", 30, [
    { tool: "exec", detail: "echo pwned > f", message: "Permission to run the command was denied." },
  ]);
  assert.equal(className, "blocked_tool");
  assert.equal(retryable, true);
  assert.match(reason, /exec/);
  assert.match(reason, /echo pwned > f/);
});

test("the blocked_tool explanation names the tool when the transcript knows it", () => {
  assert.equal(describeDenials([{ tool: "edit", detail: "src/a.ts" }]), "edit (src/a.ts)");
  assert.equal(describeDenials([{ tool: "exec", detail: "" }]), "exec");
  assert.equal(describeDenials([]), "");
  assert.equal(describeDenials(undefined), "");
});

test("repeated denials of the same call are not listed twice", () => {
  // A model that retries the same denied command would otherwise produce a
  // reason line consisting of the same string three times.
  const denials = Array.from({ length: 4 }, () => ({ tool: "exec", detail: "git commit" }));
  assert.equal(describeDenials(denials), "exec (git commit)");
});

test("reading a file that TALKS about denials is not itself a denial", async () => {
  // The exact regression, found by running a real panel over this repository.
  //
  // The parser scanned every tool result for denial-shaped prose, a reviewer
  // read lib/devin.mjs, and that file's own comments matched — so a run where
  // nothing was refused reported `blocked_tool: read (lib/devin.mjs)`. Any repo
  // discussing permissions would trip it; a review tool is the worst possible
  // place for a false positive, because it fabricates a failure.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-denial-"));
  const file = path.join(dir, "transcript.json");
  try {
    await fs.writeFile(file, JSON.stringify({
      steps: [{
        tool_calls: [
          { tool_call_id: "a", function_name: "read", arguments: { file_path: "lib/devin.mjs" } },
          { tool_call_id: "b", function_name: "exec", arguments: { command: "git diff" } },
        ],
        observation: {
          results: [
            { source_call_id: "a", content: "<file-view>\n1| // the model called a tool it is not allowed\n2| // Permission to run was denied.\n</file-view>" },
            { source_call_id: "b", content: "diff --git a/x b/x\n+// Write access to '/f' was denied." },
          ],
        },
      }],
    }));
    assert.deepEqual(await readTranscriptDenials(file), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a real denial is still recognised, anchored to the first line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-denial-"));
  const file = path.join(dir, "transcript.json");
  try {
    await fs.writeFile(file, JSON.stringify({
      steps: [{
        tool_calls: [{ tool_call_id: "a", function_name: "exec", arguments: { command: "echo x > f" } }],
        observation: {
          results: [{
            source_call_id: "a",
            content: "Permission to run the command `echo x > f` was denied. The user needs to approve command execution.",
          }],
        },
      }],
    }));
    const denials = await readTranscriptDenials(file);
    assert.equal(denials.length, 1);
    assert.equal(denials[0].tool, "exec");
    assert.equal(denials[0].detail, "echo x > f");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an absent or corrupt transcript yields no denials rather than throwing", async () => {
  assert.deepEqual(await readTranscriptDenials("/nonexistent/transcript.json"), []);
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
