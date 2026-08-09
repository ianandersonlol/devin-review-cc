// Invoking the Devin CLI, and making sense of what comes back.
//
// Everything Devin-specific that the rest of the tool depends on lives here:
// how we spawn it, how we keep a reviewer read-only, and how we classify the
// several distinct ways a run can produce nothing useful.

import { promises as fs } from "node:fs";
import path from "node:path";

import { run, which } from "./exec.mjs";

/**
 * Default single reviewer.
 *
 * SWE-1.7 is Cognition's own model: free on current plans, 262K of context, and
 * fast. A review you can afford to run on every branch beats a better review you
 * ration, which is why the cheap model is the default and escalation is a flag.
 */
export const MODEL_DEFAULT = "swe-1-7";

/**
 * Default panel.
 *
 * Three *vendors*, not three checkpoints: Cognition, Zhipu, Moonshot. The whole
 * value of a panel is decorrelated error — two models from one lab tend to miss
 * the same things, so a panel of siblings costs three times as much to buy back
 * very little. Deliberately excludes claude-* (see CORRELATED_PREFIXES).
 *
 * Two of the three are free, which is not a cost dodge but a robustness one:
 * paid capacity is the thing that runs out mid-week, and a default panel that
 * returns nothing the moment a quota trips is a default panel nobody trusts.
 * `--models swe-1-7,glm-5-2` is the entirely free pair; --models takes anything.
 */
export const PANEL_DEFAULT = ["swe-1-7", "glm-5-2", "kimi-k3-high"];

/**
 * Models that share a lineage with the Claude Code session orchestrating this
 * review. They are excluded from the default panel and warned about when chosen
 * explicitly: a reviewer that shares your training is likely to share your blind
 * spots, and agreement between correlated voices reads as confirmation when it
 * is really an echo.
 */
export const CORRELATED_PREFIXES = ["claude-", "claude_"];

export const TIMEOUT_DEFAULT = "10m";
export const DEVIN_URL = "https://docs.devin.ai/cli";

export async function findDevin() {
  return which("devin");
}

export async function devinVersion(devinPath) {
  const result = await run(devinPath, ["--version"], { timeout: 15000 });
  if (result.code !== 0) return null;
  return result.stdout.trim().split("\n")[0] || null;
}

export async function devinAuthStatus(devinPath, timeout = 20000) {
  const result = await run(devinPath, ["auth", "status"], { timeout });
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) return { loggedIn: false, raw: text.trim() };
  const loggedIn = /logged in/i.test(result.stdout);
  const field = (label) => {
    const match = result.stdout.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "im"));
    return match ? match[1].trim() : null;
  };
  return {
    loggedIn,
    email: field("Email"),
    tier: field("Tier"),
    plan: field("Plan"),
    enterprise: field("Enterprise"),
    raw: result.stdout.trim(),
  };
}

/**
 * Parse `devin models list`.
 *
 * Devin prints families as headers with their member checkpoints indented
 * beneath, each carrying a bracketed spec:
 *
 *   Kimi K3 (kimi-k3)
 *     kimi-k3-high   Kimi K3 High  [1048576 context, $3 / MTok In · $15 / MTok Out]
 *
 * We parse rather than hardcode because model availability is per-account and
 * the roster moves. Pricing is parsed for the same reason a fuel gauge exists:
 * a panel silently multiplies spend, and the user should be able to see that
 * before they buy it.
 */
export function parseModels(stdout) {
  const models = [];
  const families = [];
  let currentFamily = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const familyMatch = line.match(/^(\S.*?)\s+\(([a-z0-9._-]+)\)\s*$/i);
    if (familyMatch && !line.startsWith(" ")) {
      currentFamily = { name: familyMatch[1].trim(), id: familyMatch[2], aliases: [] };
      families.push(currentFamily);
      continue;
    }

    const aliasMatch = line.match(/^\s+aliases:\s*(.+)$/i);
    if (aliasMatch && currentFamily) {
      currentFamily.aliases = aliasMatch[1].split(",").map((a) => a.trim()).filter(Boolean);
      continue;
    }

    // `\s+` rather than `\s{2,}`: Devin pads with spaces today, but a single tab
    // is one whitespace character, and a column that silently drops models from
    // the roster would surface as "unknown model" on a name the account has.
    const memberMatch = line.match(/^\s+(\S+)\s+(.*?)\s*(?:\[(.*)\])?\s*$/);
    if (memberMatch && currentFamily) {
      const [, id, label, spec = ""] = memberMatch;
      models.push({
        id,
        label: label.trim(),
        family: currentFamily.id,
        familyName: currentFamily.name,
        ...parseSpec(spec),
      });
    }
  }

  return { models, families };
}

function parseSpec(spec) {
  const out = { context: null, inputPrice: null, outputPrice: null, free: false, beta: false };
  if (!spec) return out;
  out.free = /\bfree\b/i.test(spec);
  out.beta = /\bbeta\b/i.test(spec);

  const context = spec.match(/([0-9]+(?:\.[0-9]+)?)\s*([KM])?\s*context/i);
  if (context) {
    const value = Number.parseFloat(context[1]);
    const unit = (context[2] ?? "").toUpperCase();
    out.context = unit === "M" ? value * 1e6 : unit === "K" ? value * 1e3 : value;
  }

  // "$3 / MTok In · $15 / MTok Out" — the separator is a non-ASCII middot, so
  // match each half independently rather than splitting on it.
  const input = spec.match(/\$([0-9.]+)\s*\/\s*MTok\s*In/i);
  const output = spec.match(/\$([0-9.]+)\s*\/\s*MTok\s*Out/i);
  if (input) out.inputPrice = Number.parseFloat(input[1]);
  if (output) out.outputPrice = Number.parseFloat(output[1]);
  return out;
}

/**
 * List available models. Doubles as the readiness probe: it is the cheapest call
 * that exercises the binary end to end and spends no review tokens.
 */
export async function devinModels(devinPath, timeout = 30000) {
  const result = await run(devinPath, ["models", "list"], { timeout });
  if (result.code !== 0) return null;
  const parsed = parseModels(result.stdout);
  return parsed.models.length > 0 ? parsed : null;
}

/** True when `id` names a real model or a family alias in the parsed roster. */
export function modelExists(roster, id) {
  if (!roster) return true; // Unknown roster: do not block on an unverifiable claim.
  if (roster.models.some((m) => m.id === id)) return true;
  return roster.families.some((f) => f.id === id || f.aliases.includes(id));
}

export function isCorrelatedModel(id) {
  const lower = id.toLowerCase();
  return CORRELATED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// ── permission modes ─────────────────────────────────────────────────────────

// Devin's own vocabulary. "auto" (Normal) auto-approves read-only tools and
// rejects everything else in non-interactive mode; "accept-edits" additionally
// auto-approves workspace file edits; "dangerous" auto-approves everything.
export const MODE_READ_ONLY = "auto";
export const MODE_WRITE = "accept-edits";
export const MODE_WRITE_AND_RUN = "dangerous";

/**
 * The single place that decides whether Devin may write.
 *
 * Centralised deliberately: "the reviewers cannot edit anything" is the property
 * this plugin most needs to keep, and an invariant enforced in one tested
 * function is worth more than the same rule spread across call sites. Only
 * `rescue`, and only without --read-only, ever yields a writing mode.
 *
 * Note what is NOT here: Devin's "smart" and "autonomous" modes. Smart is
 * unavailable on many accounts and silently falls back to normal; autonomous is
 * commonly blocked by organisation policy and hard-fails. Neither is a mode you
 * can build a guarantee on, so neither is offered.
 */
export function resolveMode(subcommand, readOnly, allowCommands = false) {
  if (subcommand !== "rescue") return MODE_READ_ONLY;
  if (readOnly) return MODE_READ_ONLY;
  return allowCommands ? MODE_WRITE_AND_RUN : MODE_WRITE;
}

// ── agent config ─────────────────────────────────────────────────────────────

/**
 * Tools that can change something outside Devin's own head.
 *
 * The docs list a tidy five (read, edit, grep, glob, exec). The binary actually
 * exposes considerably more — `write`, `notebook_edit`, `run_subagent`,
 * `request_scope`, `write_to_process` and the MCP bridge among them — so a deny
 * list written from the documentation would leave real holes. This list came
 * from asking a live session to enumerate its own toolset.
 */
const MUTATING_TOOLS = [
  "edit",
  "write",
  "notebook_edit",
  "exec",
  "write_to_process",
  "kill_shell",
  "run_subagent",
  "request_scope",
  "mcp_call_tool",
];

const READ_TOOLS = ["read", "grep", "find_file_by_name", "notebook_read"];

/**
 * The agent config handed to a read-only reviewer.
 *
 * Four layers, in decreasing order of how much I trust them:
 *
 *  1. Non-interactive print mode. Devin rejects any tool call needing
 *     confirmation when there is no human to ask, and in Normal mode every
 *     write and every shell command needs confirmation. This is what actually
 *     makes a reviewer read-only, and it is verified in tests/readonly.test.mjs.
 *  2. `permissions.deny`. Deny is evaluated before ask and allow, so this holds
 *     even if something upstream grants the tool.
 *  3. `system-instructions`. Tells the model it has no shell, which mostly stops
 *     it from *trying* — see the reliability note on classifyEmptyOutput.
 *  4. `allowed-tools`. Present for completeness and forward compatibility. It
 *     did NOT restrict the toolset in testing, so nothing here relies on it.
 */
export function readOnlyAgentConfig() {
  return {
    "allowed-tools": READ_TOOLS,
    "system-instructions": [
      "You are a READ-ONLY code reviewer running in a non-interactive session.",
      "You have NO shell and NO write access. The exec, edit and write tools are denied.",
      "Do not attempt to run commands, edit files, install anything, or touch git.",
      "A denied tool call ends your turn and discards your entire review, so do not try.",
      "Read, grep and file search are available and are all you need: reason from the code you read.",
    ],
    permissions: {
      deny: ["Write(**)", ...MUTATING_TOOLS],
      allow: [...READ_TOOLS, "Read(**)"],
    },
  };
}

/**
 * The agent config for a rescue, which is allowed to edit the working tree.
 *
 * Even here git stays off-limits: the safety model is "everything Devin did is
 * recoverable with git", and a rescue that can commit, stash or checkout can
 * destroy the very thing that makes it safe. Those denials are cheap because a
 * rescue has no legitimate reason to touch history.
 */
export function rescueAgentConfig({ allowCommands }) {
  // `Exec(git)` denies the whole command, not a list of subcommands.
  //
  // An earlier version enumerated `git commit`, `git push`, `git reset` and so
  // on, which is the wrong shape of defence twice over. It missed `git clean`
  // outright — and `git clean -fd` destroys untracked files, the one class of
  // change git cannot get back, which is precisely the assumption the whole
  // "just revert it" safety story rests on. And a prefix list is trivially
  // sidestepped by `sh -c`, `env git`, or an absolute path.
  //
  // Denying git wholesale removes the direct route. It does not make bypass
  // mode into a sandbox, and the documentation says so rather than implying a
  // containment that a command blacklist cannot provide.
  const deny = ["Exec(git)", "Exec(rm)", "Exec(sudo)", "Write(.git/**)",
    "run_subagent", "request_scope"];
  if (!allowCommands) deny.push("exec", "write_to_process", "kill_shell");

  const instructions = [
    "You are fixing a specific problem in a git repository. Make the smallest change that works.",
    "NEVER touch git history or staging: no commit, add, push, reset, checkout, rebase, stash or branch.",
    "Do not refactor, reformat, rename, or 'improve' code you were not asked about.",
    "Do not weaken or delete a test to make it pass.",
  ];
  instructions.push(
    allowCommands
      ? "You may run commands to reproduce the problem and verify your fix. Prefer running the single relevant test over broad suites."
      : "You have NO shell in this run: the exec tool is denied. Do not attempt to run commands — a denied tool call ends your turn and discards your work. Report honestly that you could not verify the fix by running it.",
  );

  return {
    "system-instructions": instructions,
    permissions: { deny, allow: [...READ_TOOLS, "edit", "write", "Read(**)", "Write(**)"] },
  };
}

/** Write an agent config to the work dir and return its path. */
export async function writeAgentConfig(workDir, config, name = "agent-config.json") {
  const file = path.join(workDir, name);
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

// ── running ──────────────────────────────────────────────────────────────────

/**
 * Run Devin non-interactively against the repository.
 *
 * The request lives in a 0600 temp file passed via --prompt-file rather than on
 * argv: diffs routinely exceed what a command line will carry, and argv is world
 * readable in `ps` output on most systems.
 *
 * Two flags deserve explanation:
 *
 *   --respect-workspace-trust false
 *     Print mode cannot display the interactive trust prompt, so it hard-fails
 *     in any directory the user has not already opened Devin in. Since the user
 *     explicitly invoked a review on this repository, the prompt would be pure
 *     friction. The safety it provides is preserved by the deny list, and the
 *     residual risk (a repo-local .devin/config.json outranking ours) is
 *     surfaced as a pre-flight warning instead of silently accepted.
 *
 *   no --permission-mode for reviews
 *     Normal mode IS the read-only mode. We pass it explicitly anyway so the
 *     invocation states its own intent and a changed CLI default cannot quietly
 *     promote a reviewer into a writer.
 */
export async function runDevin({
  devinPath,
  repoRoot,
  requestFile,
  agentConfigFile,
  model,
  mode = MODE_READ_ONLY,
  timeoutMs,
}) {
  if (mode !== MODE_READ_ONLY && mode !== MODE_WRITE && mode !== MODE_WRITE_AND_RUN) {
    throw new Error(`refusing to run devin with unrecognised permission mode '${mode}'`);
  }

  const args = [
    "--permission-mode", mode,
    "--model", model,
    "--respect-workspace-trust", "false",
    "--prompt-file", requestFile,
  ];
  if (agentConfigFile) args.unshift("--agent-config", agentConfigFile);
  args.push("-p");

  const started = Date.now();
  const result = await run(devinPath, args, { cwd: repoRoot, timeout: timeoutMs });
  const durationSeconds = Math.round((Date.now() - started) / 1000);
  return { ...result, durationSeconds, model };
}

/**
 * Work out why a run produced nothing.
 *
 * Devin exits 0 with empty stdout in several unrelated situations, so a zero
 * exit is not evidence that a review happened. The one worth knowing about:
 *
 *   blocked_tool — the model called a tool that needed confirmation, there was
 *   no human to confirm it, and Devin ended the turn. Everything the model had
 *   already worked out is discarded. This is the dominant failure mode for a
 *   read-only reviewer that decides it would like a shell, which is exactly why
 *   the system instructions tell it so bluntly that it has none.
 */
export function classifyEmptyOutput(stderr, durationSeconds) {
  const text = (stderr ?? "").trim();
  const reason = tidyError(text) ||
    `devin returned no output (exit 0, empty stdout) after ${durationSeconds}s`;

  if (/rejected a tool call that requires confirmation/i.test(text)) {
    // Deliberately says nothing about whether files changed. This classifier is
    // shared with rescue, where Devin may have edited several files and *then*
    // reached for a denied verification command — so an assurance that nothing
    // was written would be flatly untrue exactly when it matters most. Write
    // state is reported from the tree snapshots, which actually know.
    return {
      className: "blocked_tool",
      reason:
        "the model tried to use a tool it is not allowed (usually a shell command), " +
        "and Devin ended the turn without printing anything. Re-running often succeeds; " +
        "a narrower --focus makes it less likely.",
      retryable: true,
    };
  }
  if (/resource_exhausted|quota|rate.?limit|\b429\b|insufficient (credit|balance)|billing/i.test(text)) {
    return { className: "quota", reason, retryable: false };
  }
  if (/unauthenticated|not logged in|\b401\b|auth/i.test(text)) {
    return { className: "auth", reason, retryable: false };
  }
  if (/restricted by your organization|organization'?s policy/i.test(text)) {
    return { className: "org_policy", reason, retryable: false };
  }
  if (/context (length|window)|too (long|large)|token limit/i.test(text)) {
    return { className: "context_overflow", reason, retryable: false };
  }
  return { className: "empty_output", reason, retryable: true };
}

/**
 * Devin's agent errors arrive as a sentence followed by a trace ID and a JSON
 * blob. The sentence is the part a human needs; the rest turns a three-model
 * panel summary into a wall of machine detail. Keep the first line, drop the
 * structured tail, and leave anything that does not match that shape alone.
 */
export function tidyError(text) {
  if (!text) return "";
  const withoutJson = text.split(/:\s*\{/)[0];
  const withoutTrace = withoutJson.replace(/\s*\(trace ID:\s*[0-9a-f]+\)\s*$/i, "");
  return withoutTrace.replace(/^Error:\s*(Agent error:\s*)?/i, "").trim() || text.trim();
}

/**
 * Devin annotates file references with `file:///abs/path` links for its TUI.
 * Harmless, but noisy in a terminal transcript and it leaks absolute paths into
 * anything the user pastes elsewhere, so offer callers a way to flatten them.
 */
export function stripFileLinks(text, repoRoot) {
  return text.replace(/\[([^\]]+)\]\(file:\/\/[^)]*\)/g, (_match, label) => {
    const trimmed = label.trim();
    return repoRoot && trimmed.startsWith(repoRoot)
      ? `\`${path.relative(repoRoot, trimmed) || trimmed}\``
      : `\`${trimmed}\``;
  });
}
