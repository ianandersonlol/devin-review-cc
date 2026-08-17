// Invoking the Devin CLI, and making sense of what comes back.
//
// Everything Devin-specific that the rest of the tool depends on lives here:
// how we spawn it, how we keep a reviewer read-only, and how we classify the
// several distinct ways a run can produce nothing useful.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, which } from "./exec.mjs";

/**
 * Default single reviewer.
 *
 * DeepSeek V4 Flash: 1M of context at $0.14/$0.28 per MTok, which is cents per
 * review — cheap enough to run on every branch, and a review you can afford to
 * run habitually beats a better review you ration. The 1M window matters more
 * here than the price: a reviewer with repo access reads far more than the diff
 * it was handed, and a small context turns "verify this against its call sites"
 * into "guess". Also the member of the council with the least in common with the
 * assistant orchestrating it (see CORRELATED_PREFIXES).
 */
export const MODEL_DEFAULT = "deepseek-v4-flash-high";

/**
 * Default panel.
 *
 * Four *vendors*, not four checkpoints: Moonshot, xAI, DeepSeek, Zhipu. The
 * whole value of a panel is decorrelated error — two models from one lab tend to
 * miss the same things, so a panel of siblings costs N times as much to buy back
 * very little. Deliberately excludes claude-* (see CORRELATED_PREFIXES).
 *
 * Vendor spread is also the robustness argument. A default panel that returns
 * nothing the moment one provider trips a quota or has a bad hour is a default
 * panel nobody trusts; four independent accounts behind one binary means a
 * failure takes a quarter of the panel, not the panel. `glm-5-2` is free, so
 * `--models glm-5-2` is the zero-cost fallback; --models takes anything.
 *
 * Cost is deliberately not minimised. This roster runs a few tens of cents on a
 * normal diff, which is the right trade for a second opinion on a change you are
 * about to merge — `devin-review panel --dry-run` prices it before you commit.
 */
export const PANEL_DEFAULT = ["kimi-k3-high", "grok-4-6-high", "deepseek-v4-flash-high", "glm-5-2"];

/**
 * Models that share a lineage with the Claude Code session orchestrating this
 * review. They are excluded from the default panel and warned about when chosen
 * explicitly: a reviewer that shares your training is likely to share your blind
 * spots, and agreement between correlated voices reads as confirmation when it
 * is really an echo.
 */
export const CORRELATED_PREFIXES = ["claude-", "claude_"];

/**
 * Per-model wall clock — a generous 45m backstop, not a tight deadline.
 *
 * The point of the ceiling is only to catch a genuinely HUNG run (a stalled
 * network, a stuck process, in a panel one dead worker blocking the others),
 * not to hurry a thorough one. It is set high on purpose. A kill here is
 * expensive — Devin prints its final message only at the very end, so a deadline
 * discards the ENTIRE review, not a truncated version — and the sandbox only
 * widened the honest spread by letting reviewers read more and run read-only
 * tests (a real review was measured at 828s, and the old 15m default was
 * actively guillotining good work). 45m sits well clear of any real review while
 * still bounding a hang to something a person will wait out.
 *
 * A smarter idle timeout is not available: Devin exports its transcript only at
 * turn boundaries, so a long single-turn investigation emits no progress signal
 * to key a "killed only if stuck" rule on. So the choice is a fixed ceiling or
 * none; a high fixed ceiling keeps the hang protection the Codex plugin forgoes
 * without punishing thoroughness. `--timeout none` opts out entirely, and
 * `--timeout 90m` (etc.) raises it for a genuinely large diff.
 */
export const TIMEOUT_DEFAULT = "45m";
export const DEVIN_URL = "https://docs.devin.ai/cli";

export async function findDevin() {
  return which("devin");
}

export async function devinVersion(devinPath) {
  const result = await run(devinPath, ["--version"], { timeout: 15000 });
  if (result.code !== 0) return null;
  return result.stdout.trim().split("\n")[0] || null;
}

/**
 * The long flags this plugin puts on Devin's command line.
 *
 * Every one of these is load-bearing, so the set doubles as a compatibility
 * contract with whatever `devin` happens to be installed. See devinFlags.
 */
export const REQUIRED_FLAGS = [
  "--config",
  "--prompt-file",
  "--model",
  "--permission-mode",
  "--respect-workspace-trust",
  "--export",
];

/**
 * The sandbox flag is an ENHANCEMENT, not part of the compatibility contract.
 *
 * Kept out of REQUIRED_FLAGS deliberately: a devin old enough to predate
 * `--sandbox` should still run — screened, the way it always did — not be
 * blocked with exit 7. So sandbox support is probed separately and the flag is
 * simply dropped when the installed CLI does not know it.
 */
export const SANDBOX_FLAG = "--sandbox";

/**
 * Does the installed CLI accept `--sandbox`?
 *
 * `null` flags means `--help` could not be read, and here that resolves to NO —
 * unlike guardCliCompatibility, which treats null as "proceed". The asymmetry is
 * deliberate and was a panel-review catch: guardCliCompatibility's permissive
 * default can only fail to BLOCK, but passing `--sandbox` to a CLI that does not
 * accept it makes the whole review hard-fail at argv parsing (cli_mismatch). So
 * when support is unknown we fall back to the screened path — a working review
 * beats a broken one, and the header prints `sandbox=off` so it is not silent.
 */
export function sandboxSupported(flags) {
  if (!flags) return false;
  return flags.has(SANDBOX_FLAG);
}

/**
 * Read the long flags the installed CLI accepts, straight from `devin --help`.
 *
 * This exists because of how `--agent-config` disappeared. The CLI auto-updates
 * underneath the plugin, the flag was removed in 3000.4.16, and because it was
 * the first argument on the line every model in a panel died at argv parsing
 * with the same opaque `unexpected argument` error. Three identical parser
 * errors read like a broken plugin, not like a CLI that moved.
 *
 * Probing beats pinning a version number: it asks the binary in front of us what
 * it actually supports, so a rename is reported as the one missing flag it is
 * rather than as three failed reviews. `--help` is local, instant and free.
 *
 * Returns null when help could not be read at all, which callers treat as
 * "unknown, proceed" rather than as a failure — refusing to run because we could
 * not parse a help screen would be worse than the problem.
 */
export async function devinFlags(devinPath, timeout = 15000) {
  const result = await run(devinPath, ["--help"], { timeout });
  if (result.code !== 0) return null;
  const found = `${result.stdout}\n${result.stderr}`.match(/--[a-z][a-z0-9-]*/g);
  return found ? new Set(found) : null;
}

/** Which of REQUIRED_FLAGS this CLI does not know about. Empty when unknown. */
export function missingFlags(flags) {
  if (!flags) return [];
  return REQUIRED_FLAGS.filter((flag) => !flags.has(flag));
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

// ── session config ───────────────────────────────────────────────────────────
//
// Devin 3000.4.16 removed `--agent-config`. Its successor is `--config`, which
// overrides the *user* config file wholesale and carries a top-level
// `permissions: { deny, allow }` block. Verified against the live CLI: a deny
// there blocks `exec` even under `--permission-mode dangerous`, while `read` and
// `grep` keep working.
//
// The other half of the old agent config did NOT survive. `system-instructions`
// is not read from the config file at any key — neither top-level nor under
// `agent` — so everything the reviewer needs to be told now travels in the
// prompt itself. See prompts.mjs.

/**
 * Tools denied to a reviewer.
 *
 * Note what is NOT here: `exec`. That is a deliberate reversal, and the reason
 * is that the old assumption turned out to be false. `--permission-mode auto`
 * does not block the shell wholesale — it classifies each command, so `ls` and
 * `git log` run while `echo x > f` is rejected. Denying `exec` outright bought
 * us a reviewer that could not read its own repository's history, in exchange
 * for a guarantee that `auto` already provides for anything that writes.
 *
 * `write_to_process` stays denied precisely BECAUSE `exec` is allowed. The
 * command classifier judges a command string, so `exec("python3")` looks
 * read-only; being able to then type into that process would hand the model an
 * unclassified shell and defeat the gate entirely.
 *
 * `kill_shell` is absent from both lists: it cannot change the repository, and
 * every denied tool is a chance for the model to end its turn on one.
 */
const REVIEWER_DENY = [
  "Write(**)",
  "edit",
  "write",
  "notebook_edit",
  "write_to_process",
  "run_subagent",
  "request_scope",
  "mcp_call_tool",
];

/**
 * Other AI agent CLIs, denied as whole commands for reviewers AND rescues.
 *
 * Devin imports the user's `~/.claude/CLAUDE.md` into every session as an
 * always-on rule (see the README's known-quirks section), and a CLAUDE.md
 * that documents delegation — "get adversarial reviews via /agy:review" —
 * reads to the model as instructions for THIS session. Observed live:
 * swe-1-7, asked for a review, tried to invoke `/agy:review --dry-run
 * --base HEAD~1`, flags lifted verbatim from the user's global config.
 * Under per-command screening that merely killed the turn; inside the
 * sandbox the real `agy` binary is on PATH and shell commands are
 * auto-approved, so the call can SUCCEED — and the "independent" review
 * comes back laundered through a vendor the user did not pick, spending
 * that tool's quota on the way.
 *
 * The prompt tells the model not to (FOREIGN_RULES in prompts.mjs); this
 * list makes disobedience loud instead of silent. A denied call ends the
 * turn and the automatic retry leads with a note naming it — strictly
 * better than a review that quietly came from the wrong model. Same
 * command-shaped denial as `Exec(git)` below: the whole command, because a
 * subcommand list is trivially routed around.
 */
const AGENT_CLI_DENY = ["agy", "codex", "claude", "gemini", "devin"].map(
  (cli) => `Exec(${cli})`,
);

const READ_TOOLS = ["read", "grep", "find_file_by_name", "notebook_read"];

/**
 * Permissions for a read-only reviewer.
 *
 * Four layers now, in decreasing order of how much I trust them:
 *
 *  1. The OS sandbox (`--sandbox`, macOS Seatbelt / Linux bwrap+seccomp), where
 *     the platform has one. `Deny(Write(**))` below subtracts the workspace
 *     from the sandbox's writable set, so a shell command that writes fails at
 *     the syscall with `Operation not permitted` — verified live: redirects,
 *     python and node one-liners and sed -i all failed while the canary file
 *     survived. Crucially the failed command does NOT end the turn; the model
 *     reads the error and keeps reviewing.
 *  2. `permissions.deny`. Deny wins over allow and over the permission mode, and
 *     it held in testing against a repo-local `.devin/config.json` that tried to
 *     allow what we denied. On Windows and under --no-sandbox this is the real
 *     guarantee that a reviewer cannot edit files.
 *  3. Devin's own command classifier in `auto` mode, which is what stops a
 *     *shell* command from writing when the sandbox is off. Confirmed by
 *     reproduction: `echo pwned > f` is rejected, plain `echo` is not. With
 *     --sandbox on, the CLI auto-approves shell commands and lets the sandbox
 *     contain them instead — also verified live.
 *  4. The prompt, which tells the model what it may and may not do so that it
 *     does not waste a turn discovering the boundary. See classifyEmptyOutput.
 *
 * `exec` appears in NEITHER list, and that is load-bearing rather than an
 * oversight. Putting a tool in `allow` AUTO-APPROVES it: with `exec` allowed,
 * `echo pwned > file` wrote the file even under `--permission-mode auto`. On
 * the sandboxed path that would not matter, but the SAME permission object
 * serves Windows and --no-sandbox, where layer 3 must stay in charge of it.
 */
export function readOnlyPermissions() {
  return {
    deny: [...REVIEWER_DENY, ...AGENT_CLI_DENY],
    allow: [...READ_TOOLS, "Read(**)"],
  };
}

/**
 * Permissions for a rescue, which is allowed to edit the working tree.
 *
 * Even here git stays off-limits: the safety model is "everything Devin did is
 * recoverable with git", and a rescue that can commit, stash or checkout can
 * destroy the very thing that makes it safe. Those denials are cheap because a
 * rescue has no legitimate reason to touch history.
 */
export function rescuePermissions({ allowCommands }) {
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
    "run_subagent", "request_scope", ...AGENT_CLI_DENY];
  if (!allowCommands) deny.push("exec", "write_to_process", "kill_shell");

  return { deny, allow: [...READ_TOOLS, "edit", "write", "Read(**)", "Write(**)"] };
}

/**
 * Where the Devin CLI keeps the user's own config.
 *
 * We read it because `--config` REPLACES this file rather than layering over it,
 * so anything we do not copy forward is simply absent for the run: `org_id`,
 * proxy settings, and network rules among them. The one that bites immediately
 * is `shell.setup_complete` — without it the CLI prints its "Welcome to Devin
 * CLI!" banner straight into stdout, in front of the JSON we are about to parse.
 */
function userConfigCandidates() {
  const home = os.homedir();
  const paths = [];
  if (process.env.DEVIN_REVIEW_USER_CONFIG) paths.push(process.env.DEVIN_REVIEW_USER_CONFIG);
  if (process.env.XDG_CONFIG_HOME) paths.push(path.join(process.env.XDG_CONFIG_HOME, "devin", "config.json"));
  if (process.platform === "win32" && process.env.APPDATA) {
    paths.push(path.join(process.env.APPDATA, "devin", "config.json"));
  }
  if (home) paths.push(path.join(home, ".config", "devin", "config.json"));
  return paths;
}

/**
 * Read the user's Devin config, best effort.
 *
 * Never throws and never blocks a review. A missing or corrupt user config is
 * not a reason to refuse to review code — it just means the session config is
 * built from defaults, which works.
 */
export async function readUserConfig() {
  for (const candidate of userConfigCandidates()) {
    let text;
    try {
      text = await fs.readFile(candidate, "utf8");
    } catch {
      continue; // Not there; try the next location.
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Unparseable. Keep looking rather than guessing at a repair.
    }
    // Deliberately `continue`, not `return {}`. An earlier version stopped here,
    // so a corrupt file at a high-precedence location (a stale
    // DEVIN_REVIEW_USER_CONFIG, a half-written $XDG_CONFIG_HOME copy) discarded
    // a perfectly good ~/.config/devin/config.json below it. That silently drops
    // org_id and proxy — the exact settings this merge exists to preserve — and
    // surfaces later as an auth or network error nobody traces back here.
  }
  return {};
}

/**
 * Build the config file for one session: the user's own settings, with our
 * permissions forced on top.
 *
 * Merging rather than writing a minimal file keeps enterprise and proxied
 * accounts working — `devin.org_id`, `proxy` and `sandbox.network` all live here
 * and a review that quietly dropped them would fail in ways nobody would connect
 * back to this plugin.
 *
 * `permissions` is overwritten, never merged. A user config that allowed `edit`
 * must not be able to widen a reviewer, and since deny beats allow anyway the
 * only safe reading of "the user also has opinions about permissions" is to
 * ignore them for the duration of a review.
 *
 * `sandbox.excluded` is dropped for the same reason. It lists commands that run
 * OUTSIDE the OS sandbox — an exemption the user granted to their own
 * interactive sessions, where they are present to notice what an excluded
 * command does. Carrying it into a sandboxed review would hand those commands
 * to an unattended agent uncontained. The rest of the user's sandbox section
 * (network filtering, notably) is preserved: narrowing what a reviewer can
 * reach is their call to make.
 */
export function buildSessionConfig(userConfig, permissions) {
  const base = userConfig && typeof userConfig === "object" ? userConfig : {};
  const shell = base.shell && typeof base.shell === "object" ? base.shell : {};
  const config = {
    ...base,
    // Suppresses the first-run welcome banner, which would otherwise land in
    // stdout ahead of the review.
    shell: { ...shell, setup_complete: true },
    permissions,
  };
  if (base.sandbox && typeof base.sandbox === "object") {
    const { excluded: _excluded, ...sandbox } = base.sandbox;
    config.sandbox = sandbox;
  }
  return config;
}

/** Write a session config to the work dir and return its path. */
export async function writeSessionConfig(workDir, config, name = "session-config.json") {
  const file = path.join(workDir, name);
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Read the user config and write the session config for `permissions`. */
export async function prepareSessionConfig(workDir, permissions, name) {
  return writeSessionConfig(workDir, buildSessionConfig(await readUserConfig(), permissions), name);
}

// ── running ──────────────────────────────────────────────────────────────────

/**
 * Run Devin non-interactively against the repository.
 *
 * The request lives in a 0600 temp file passed via --prompt-file rather than on
 * argv: diffs routinely exceed what a command line will carry, and argv is world
 * readable in `ps` output on most systems.
 *
 * Three flags deserve explanation:
 *
 *   --respect-workspace-trust false
 *     Print mode cannot display the interactive trust prompt, so it hard-fails
 *     in any directory the user has not already opened Devin in. Since the user
 *     explicitly invoked a review on this repository, the prompt would be pure
 *     friction. The safety it provides is preserved by the deny list, which was
 *     tested against a repo-local .devin/config.json trying to allow what we
 *     deny and held. Such a file is still surfaced as a pre-flight warning,
 *     because it can carry MCP servers and other settings the deny list has
 *     nothing to say about.
 *
 *   --permission-mode
 *     `auto` IS the read-only mode. We pass it explicitly anyway so the
 *     invocation states its own intent and a changed CLI default cannot quietly
 *     promote a reviewer into a writer.
 *
 *   --export
 *     Writes the full session transcript as JSON. It is not a debugging luxury:
 *     when Devin refuses a tool call it ends the turn with exit 0, empty stdout
 *     AND empty stderr, so the transcript is the only place that records what
 *     the model was actually trying to do. See readTranscriptDenials.
 */
export async function runDevin({
  devinPath,
  repoRoot,
  requestFile,
  configFile,
  exportFile,
  model,
  mode = MODE_READ_ONLY,
  sandbox = false,
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
  if (configFile) args.unshift("--config", configFile);
  if (sandbox) args.push("--sandbox");
  if (exportFile) args.push("--export", exportFile);
  args.push("-p");

  // A stale transcript from a previous attempt would be read as this attempt's
  // evidence, which matters because retries reuse the same path.
  if (exportFile) await fs.rm(exportFile, { force: true }).catch(() => {});

  const started = Date.now();
  const result = await run(devinPath, args, { cwd: repoRoot, timeout: timeoutMs });
  const durationSeconds = Math.round((Date.now() - started) / 1000);
  const denials = exportFile ? await readTranscriptDenials(exportFile) : [];
  return { ...result, durationSeconds, model, denials };
}

/**
 * How a refused tool call reads in the exported transcript.
 *
 * Devin hands the model a plain-language sentence as the tool *result* — e.g.
 * "Permission to run the command `echo x > f` was denied. The user needs to
 * approve command execution." — and then ends the turn. Matching prose is
 * unavoidably approximate, so this errs toward recognising a denial: the cost of
 * a false positive is a slightly wrong explanation of an already-failed run,
 * and the cost of a false negative is the silent "returned no output" that made
 * this failure mode so hard to diagnose in the first place.
 */
const DENIAL_PATTERN =
  /^(?:permission (?:to|denied)|write access to|read access to|.{0,80}?\b(?:was|were)\s+(?:denied|rejected)\b|subagent error: tool was rejected|tool was rejected)/i;

/**
 * Tools whose results are file or search CONTENT, never a permission verdict.
 *
 * Excluded because the first version of this parser scanned every tool result
 * for denial-shaped prose, and then a reviewer read THIS FILE. Its own comments
 * about denied tools matched, and the run was reported as
 * `blocked_tool: read (lib/devin.mjs), exec (git diff)` — neither of which is
 * denied, on a run where nothing had been refused at all. Any repository
 * discussing permissions would have hit it; ours was merely guaranteed to.
 */
const CONTENT_TOOLS = new Set([
  "read",
  "grep",
  "find_file_by_name",
  "notebook_read",
  "read_subagent",
  "codebase_search",
  "view_file",
]);

/**
 * A refusal is the WHOLE result, and a short one. File content is neither.
 *
 * Devin's longest refusal runs about 160 characters; command output that merely
 * mentions a rejection runs to thousands. Two panel reviewers independently
 * flagged that widening the pattern to `was|were denied|rejected` had made
 * false positives reachable through `exec`, because this same change told
 * reviewers that `cat`, `rg`, `head` and `tail` are commands they may run.
 *
 * Their suggested fix — treat those programs as content-bearing, the way the
 * `read` tool is — would have broken the diagnosis that matters most: a
 * rejected `git -C <path> log` IS an `exec` whose command starts with `git`, so
 * a program allowlist would skip the single most common real failure. Bounding
 * the LENGTH separates the two cleanly instead: refusals stay in, file dumps
 * drop out, and no command has to be enumerated.
 */
const MAX_DENIAL_CHARS = 400;

/**
 * Recover, from an exported transcript, which tool calls Devin refused.
 *
 * Returns [] for every kind of "could not tell" — no file, unreadable, a schema
 * we do not recognise. This is diagnostic colour on a run that already failed,
 * so it must never be able to turn a bad review into a crash.
 */
export async function readTranscriptDenials(exportPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(exportPath, "utf8"));
  } catch {
    return [];
  }
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const denials = [];

  for (const step of steps) {
    const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
    const results = Array.isArray(step?.observation?.results) ? step.observation.results : [];
    for (const result of results) {
      const content = typeof result?.content === "string" ? result.content : "";
      if (!content) continue;
      const call =
        calls.find((c) => c?.tool_call_id === result?.source_call_id) ?? (calls.length === 1 ? calls[0] : null);
      const tool = call?.function_name ?? "unknown";

      // Content-bearing tools are skipped outright, and the match is anchored to
      // the FIRST LINE for everything else. A denial is a short sentence Devin
      // puts at the top of the result; a file that merely talks about denials
      // does not start with one. `exec` needs the anchor as much as `read` does
      // — `git diff` output quotes whatever the diff touched.
      if (CONTENT_TOOLS.has(tool)) continue;
      const trimmed = content.trim();
      if (trimmed.length > MAX_DENIAL_CHARS) continue;
      const firstLine = trimmed.split("\n", 1)[0];
      if (!DENIAL_PATTERN.test(firstLine)) continue;

      denials.push({ tool, detail: describeCall(call), message: firstLine.trim() });
    }
  }
  return denials;
}

/** The one argument worth quoting back for the common tools. */
function describeCall(call) {
  const args = call?.arguments;
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "path", "file", "file_path", "target_file"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return "";
}

/** One line naming what the model tried, for a blocked_tool explanation. */
export function describeDenials(denials) {
  if (!denials || denials.length === 0) return "";
  const seen = new Map();
  for (const denial of denials) {
    const key = `${denial.tool}:${denial.detail}`;
    if (!seen.has(key)) seen.set(key, denial);
  }
  return [...seen.values()]
    .slice(0, 3)
    .map((d) => (d.detail ? `${d.tool} (${d.detail})` : d.tool))
    .join(", ");
}

/**
 * Work out why a run produced nothing.
 *
 * Devin exits 0 with empty stdout in several unrelated situations, so a zero
 * exit is not evidence that a review happened. The one worth knowing about:
 *
 *   blocked_tool — the model called a tool that needed confirmation or was
 *   denied, and Devin ended the turn. Everything the model had already worked
 *   out is discarded.
 *
 * The two ways that happens are NOT equally visible, which is why `denials`
 * exists. A confirmation rejection prints a warning; a `permissions.deny` hit
 * prints nothing whatsoever — exit 0, empty stdout, empty stderr. Classifying on
 * stderr alone therefore reported our own deny list as a generic "returned no
 * output", sending the reader looking for a network fault. The exported
 * transcript is the only witness, so it is consulted first.
 */
export function classifyEmptyOutput(stderr, durationSeconds, denials = [], { canRetry = true } = {}) {
  const text = (stderr ?? "").trim();
  const reason = tidyError(text) ||
    `devin returned no output (exit 0, empty stdout) after ${durationSeconds}s`;

  // The sandbox could not be set up. On Linux `--sandbox` needs bubblewrap and
  // socat, and the CLI fails CLOSED without them rather than running
  // unsandboxed — so a machine missing the prerequisites gets a clear fix
  // (install them, or pass --no-sandbox) instead of a generic "no output".
  // Checked early because its remedy is specific and unlike any other class's.
  if (/\bsandbox\b/i.test(text) && /bubblewrap|bwrap|socat|seccomp|seatbelt|prerequisit|not (?:available|supported|set up)|could not (?:be )?(?:set up|initiali|resolv)|failed to (?:set up|start|initiali)/i.test(text)) {
    return {
      className: "sandbox_unavailable",
      reason:
        `the OS sandbox could not be started (${tidyError(text) || "no detail"}). On Linux it needs ` +
        "bubblewrap and socat — run `devin sandbox setup` to see the prerequisites — or re-run with " +
        "--no-sandbox to fall back to per-command screening.",
      retryable: false,
    };
  }

  // A CLI that has moved on. Checked before everything else because it fails at
  // argv parsing, so every model in a panel fails identically and none of the
  // later classes describe it.
  if (/unexpected argument|unrecognized (?:option|argument)|unknown (?:flag|option)/i.test(text)) {
    const flag = text.match(/'(--[a-z0-9-]+)'/i)?.[1];
    return {
      className: "cli_mismatch",
      reason:
        `your devin CLI rejected ${flag ? `\`${flag}\`` : "an argument this plugin passes"}, which means ` +
        "the CLI has changed underneath the plugin. Run `devin-review setup` to see which flags are " +
        "missing, and update the plugin.",
      retryable: false,
    };
  }

  const blocked = denials.length > 0 || /rejected a tool call that requires confirmation/i.test(text);
  if (blocked) {
    // Deliberately says nothing about whether files changed. This classifier is
    // shared with rescue, where Devin may have edited several files and *then*
    // reached for a denied verification command — so an assurance that nothing
    // was written would be flatly untrue exactly when it matters most. Write
    // state is reported from the tree snapshots, which actually know.
    const tried = describeDenials(denials);
    // The advice differs by caller, and getting this wrong is not cosmetic.
    // "Re-running often succeeds" is true for a review and actively dangerous
    // for a rescue, which may have edited files before it reached the denied
    // tool — it would invite the user to do by hand the exact thing the code
    // refuses to do automatically. Only the write-state claim was previously
    // guarded here; the retry sentence was not.
    return {
      className: "blocked_tool",
      reason:
        (tried
          ? `the model called a tool it is not allowed — ${tried} — `
          : "the model tried to use a tool it is not allowed (usually a shell command), ") +
        "and Devin ended the turn without printing anything. " +
        (canRetry
          ? "Re-running often succeeds; a narrower --focus makes it less likely."
          : "Check the diff of what it changed before deciding whether to re-run — it may " +
            "have edited files before it stopped, so a second run would not start from where you think."),
      // Tracks the advice rather than always claiming true. A --json consumer
      // reading `retryable: true` off a writing rescue would be told the
      // opposite of what the prose beside it says.
      retryable: canRetry,
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
