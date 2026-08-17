// Argument parsing.
//
// Deliberately mirrors agy-review's flag vocabulary, which in turn mirrors the
// Codex plugin's, so that muscle memory carries between the three reviewers.
// Devin-specific additions are --models/--panel (multi-model) and
// --allow-commands (rescue).

import { MODEL_DEFAULT, PANEL_DEFAULT, TIMEOUT_DEFAULT } from "./devin.mjs";
import { isLens } from "./prompts.mjs";

export class UsageError extends Error {}

const SUBCOMMANDS = new Set(["review", "challenge", "panel", "rescue", "setup", "status", "models"]);

const DURATION = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/;

// A ceiling on parallel agent sessions. Not a resource limit so much as a typo
// guard: `--concurrency 300` is never what somebody meant.
const CONCURRENCY_MAX = 16;

/**
 * Parse a duration into milliseconds.
 *
 * The Devin CLI has no print timeout of its own, so unlike agy we are not
 * passing this through to the binary — we enforce it ourselves by killing the
 * child. Accepting the same "10m" spelling anyway keeps the two plugins'
 * interfaces interchangeable.
 */
export function parseDuration(value) {
  if (/^[0-9]+$/.test(value)) return Number.parseInt(value, 10) * 1000;
  const match = value.match(DURATION);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2];
  const scale = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return Math.round(amount * scale);
}

export function parseArgs(argv) {
  const args = [...argv];
  let subcommand = "review";
  if (args.length > 0 && SUBCOMMANDS.has(args[0])) {
    subcommand = args.shift();
  }

  const options = {
    subcommand,
    // `challenge` is the design lens; `review` and `panel` default to defect,
    // but --lens wins for all of them.
    lens: subcommand === "challenge" ? "design" : "defect",
    model: MODEL_DEFAULT,
    models: [],
    modelExplicit: false,
    modelsExplicit: false,
    // Sized to the default panel, so a bare `panel` runs in one wave rather than
    // holding its fourth reviewer back behind the slowest of the first three —
    // which would roughly double the wall clock of the most common invocation.
    concurrency: PANEL_DEFAULT.length,
    // A generous default backstop, not a tight deadline: high enough to clear
    // any real review, low enough to bound a hung run. `--timeout none` opts
    // out (timeoutMs null → the spawn helper sets no timer). See TIMEOUT_DEFAULT.
    timeout: TIMEOUT_DEFAULT,
    timeoutMs: parseDuration(TIMEOUT_DEFAULT),
    base: "",
    diffMode: "branch",
    allowSecrets: false,
    allowHooks: false,
    allowRepoMcp: false,
    focus: "",
    quiet: false,
    dryRun: false,
    json: false,
    help: false,
    keepLinks: false,
    keepArtifacts: false,
    noSandbox: false,
    // rescue only
    problem: "",
    readOnly: false,
    allowCommands: false,
    noContext: false,
    paths: [],
  };

  const bareWords = [];

  const requireValue = (flag, rest) => {
    if (rest.length === 0) throw new UsageError(`${flag} requires a value`);
    return rest.shift();
  };

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--base":
        options.base = requireValue("--base", args);
        break;
      case "--model":
        options.model = requireValue("--model", args);
        options.modelExplicit = true;
        break;
      case "--models": {
        const value = requireValue("--models", args);
        const list = value.split(",").map((m) => m.trim()).filter(Boolean);
        if (list.length === 0) throw new UsageError("--models needs at least one model id");
        // Deduplicate: running the same model twice is almost always a typo,
        // and it costs real money to discover that the slow way.
        const seen = new Set();
        options.models = list.filter((m) => (seen.has(m) ? false : seen.add(m)));
        options.modelsExplicit = true;
        break;
      }
      case "--panel":
        options.models = [...PANEL_DEFAULT];
        options.modelsExplicit = true;
        break;
      case "--concurrency": {
        const value = requireValue("--concurrency", args);
        // Full-string match, not Number.parseInt: parseInt happily reads "2junk"
        // as 2 and "1.5" as 1, so a typo silently becomes a different fan-out
        // than the one that was typed.
        if (!/^[0-9]+$/.test(value) || Number.parseInt(value, 10) < 1) {
          throw new UsageError(`--concurrency must be a positive integer, got '${value}'`);
        }
        const parsed = Number.parseInt(value, 10);
        if (parsed > CONCURRENCY_MAX) {
          throw new UsageError(
            `--concurrency above ${CONCURRENCY_MAX} would fan out more agent sessions than any ` +
            "account tolerates; lower it or split the panel",
          );
        }
        options.concurrency = parsed;
        break;
      }
      case "--focus":
        options.focus = requireValue("--focus", args);
        break;
      case "--lens": {
        const value = requireValue("--lens", args);
        if (!isLens(value)) throw new UsageError(`--lens must be 'defect' or 'design', got '${value}'`);
        options.lens = value;
        break;
      }
      case "--timeout": {
        const value = requireValue("--timeout", args);
        // `none`/`off`/`0` all mean "no hard kill" — the default, but accepted
        // explicitly so a user overriding a shell alias or a CI wrapper can say
        // so. The spawn helper reads a falsy timeout as "no timer".
        if (/^(none|off|0)$/i.test(value)) {
          options.timeout = "none";
          options.timeoutMs = null;
          break;
        }
        const ms = parseDuration(value);
        if (ms === null) {
          throw new UsageError(
            "--timeout must be a duration like 30s, 10m, 1h, or 'none' to disable " +
              "(bare numbers are read as seconds)",
          );
        }
        // A negative duration is nonsense; zero is handled as "none" above.
        if (ms <= 0) {
          throw new UsageError("--timeout must be greater than zero, or 'none' to disable");
        }
        options.timeout = value;
        options.timeoutMs = ms;
        break;
      }
      case "--staged":
        options.diffMode = "staged";
        break;
      case "--uncommitted":
        options.diffMode = "uncommitted";
        break;
      case "--allow-secrets":
        options.allowSecrets = true;
        break;
      case "--allow-hooks":
        options.allowHooks = true;
        break;
      case "--allow-repo-mcp":
        options.allowRepoMcp = true;
        break;
      case "--keep-links":
        options.keepLinks = true;
        break;
      case "--keep-artifacts":
        options.keepArtifacts = true;
        break;
      case "--no-sandbox":
        options.noSandbox = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--read-only":
        options.readOnly = true;
        break;
      case "--allow-commands":
        options.allowCommands = true;
        break;
      case "--no-context":
        options.noContext = true;
        break;
      case "--problem":
        options.problem = requireValue("--problem", args);
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--":
        options.paths.push(...args);
        args.length = 0;
        break;
      default:
        if (arg.startsWith("--")) throw new UsageError(`unknown flag: ${arg}`);
        if (subcommand === "rescue") bareWords.push(arg);
        else options.paths.push(arg);
        break;
    }
  }

  // Naming two different rosters is a contradiction, and silently honouring one
  // of them would bill the user for an opinion they did not ask for.
  if (options.modelExplicit && options.modelsExplicit) {
    throw new UsageError("--model and --models are mutually exclusive; --models already takes a list");
  }

  // Resolution order, most specific first. --model must beat the `panel`
  // default, or `panel --model kimi-k3-high` would quietly review with the whole
  // council the user did not name.
  if (options.models.length === 0) {
    if (options.modelExplicit) options.models = [options.model];
    else if (subcommand === "panel") options.models = [...PANEL_DEFAULT];
    else options.models = [options.model];
  }

  // --read-only and --allow-commands ask for opposite things. Guessing which
  // one the user meant is exactly the kind of helpfulness that edits a file
  // somebody wanted left alone.
  if (options.readOnly && options.allowCommands) {
    throw new UsageError("--read-only and --allow-commands are contradictory; pick one");
  }
  if (options.allowCommands && subcommand !== "rescue") {
    throw new UsageError("--allow-commands only applies to rescue; review and challenge never run commands");
  }

  if (subcommand === "rescue") {
    if (options.modelsExplicit && options.models.length > 1) {
      throw new UsageError(
        "rescue takes a single --model: two models editing one working tree would interleave their changes",
      );
    }
    const spoken = bareWords.join(" ").trim();
    options.problem = [options.problem, spoken].filter(Boolean).join(" ").trim();
    if (!options.problem && !options.help) {
      throw new UsageError(
        'rescue needs a problem statement, e.g. devin-review rescue "the login test fails after my change"',
      );
    }
  }

  return options;
}

export const USAGE = `devin-review — adversarial review of your working diff via the Devin CLI, with real repo access.

Usage:
  devin-review [subcommand] [options] [-- <paths>...]

Subcommands:
  review              hunt for defects in the diff (default)
  challenge           challenge the design and approach instead of the implementation
  panel               run several models on the same diff, in parallel, and report each
  rescue "<problem>"  diagnose and FIX a problem — this one EDITS YOUR FILES
  setup               check that devin, git, and node are ready; explain how to fix what is not
  status              show tool readiness plus what a review would cover right now
  models              list the models your Devin account can use, with prices

Options:
  --base REF          compare against REF (default: auto — origin/HEAD, main, or master)
  --staged            review only staged changes
  --uncommitted       review only uncommitted changes (vs HEAD)
  --lens defect|design  override the lens for the chosen subcommand
  --model ID          single reviewer (default: ${MODEL_DEFAULT}; see \`devin-review models\`)
  --models a,b,c      run these models in parallel and report each separately
  --panel             shorthand for --models ${PANEL_DEFAULT.join(",")}
  --concurrency N     how many panel models run at once (default: ${PANEL_DEFAULT.length})
  --focus TEXT        extra instruction, e.g. --focus "auth and data loss"
  --timeout DUR       per-model wall clock, e.g. 30s, 10m, 1h; 'none' to disable
                      (default: ${TIMEOUT_DEFAULT}). A generous backstop for a HUNG run, not
                      a deadline: a kill discards the whole review (Devin prints
                      only at the end), so it sits well clear of a thorough one.
                      Raise it for a large diff, or 'none' to remove it.
  --allow-secrets     skip the secret-shape pre-flight scan
  --allow-hooks       run even though the repo declares Devin lifecycle hooks
                      (they execute shell commands outside the read-only model)
  --allow-repo-mcp    run even though the repo configures Devin MCP servers
                      (stdio server commands start before permission checks)
  --keep-links        keep Devin's file:// annotations instead of flattening them
  --keep-artifacts    keep the temp work dir (request, session transcripts) and
                      print its path instead of deleting it; it is kept
                      automatically whenever a model fails
  --no-sandbox        do not run reviewers inside the OS sandbox; falls back to
                      Devin's per-command approval, which rejects far more and
                      ends the turn on each rejection (this is also the only
                      mode Windows has, and the escape hatch if the Linux
                      sandbox prerequisites — bubblewrap, socat — are missing)
  --quiet             suppress the metadata header on stderr
  --dry-run           build the diff and run the secret scan, then stop without
                      calling devin — shows exactly what would be reviewed and
                      spends nothing
  --json              the validated structured report (any review path), or
                      machine-readable output for setup, status and models
  -h, --help          this message

rescue only:
  --read-only         diagnose and propose a fix WITHOUT editing anything
  --allow-commands    let it run shell commands to verify its fix (see below)
  --no-context        do not include your uncommitted diff as context
  --problem TEXT      the problem statement (equivalent to bare words)

review, challenge and panel are read-only by construction. On macOS and Linux
they run inside Devin's OS sandbox (Seatbelt / bwrap+seccomp): shell commands
run freely, but any write to the repository fails at the OS level. The edit and
write tools are denied outright everywhere. On Windows, or with --no-sandbox,
writes are instead stopped by denied tools plus Devin's per-command approval.
The sandbox does not block network egress; reviews instruct the model not to
use the network, but that is policy rather than enforcement.

rescue runs with --permission-mode accept-edits, so it MODIFIES YOUR WORKING
TREE. It cannot run commands unless you pass --allow-commands, which switches
Devin to its bypass mode — still barred from git history, rm and sudo, but a
much larger blast radius. It never stages or commits, and it reports a precise
diff of every change it made.

Exit codes: 0 ok · 2 setup problem · 3 devin produced no output · 4 blocked by
the credential pre-flight · 5 every model in a panel failed · 6 blocked because
the repository declares lifecycle hooks · 7 incompatible Devin CLI · 8 blocked
because the repository declares MCP servers.`;
