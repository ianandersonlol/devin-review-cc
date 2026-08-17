// Shared readiness probe behind `setup` and `status`.

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  devinAuthStatus,
  devinFlags,
  devinModels,
  devinVersion,
  DEVIN_URL,
  findDevin,
  missingFlags,
  MODEL_DEFAULT,
  modelExists,
} from "./devin.mjs";
import { findGit, repoRoot } from "./git.mjs";
import { run } from "./exec.mjs";

const NODE_MINIMUM = 18;

/**
 * Inspect the local toolchain. Never throws, never spends tokens — every field
 * is either a fact or null, and the caller decides how loud to be.
 */
export async function probeEnvironment({
  cwd = process.cwd(),
  includeRepo = true,
  // `devin models list` and `devin auth status` can both reach the network.
  // `setup` is explicitly a readiness check and can afford to wait; `status` is
  // mostly a local scope preview and passes a short bound so an offline or
  // proxied machine does not stall it.
  modelsTimeout = 30000,
} = {}) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);

  const gitPath = await findGit();
  let gitVersion = null;
  if (gitPath) {
    const result = await run(gitPath, ["--version"], { timeout: 15000 });
    if (result.code === 0) gitVersion = result.stdout.trim();
  }

  const devinPath = await findDevin();
  // Version, models and auth are independent probes against the same binary;
  // running them concurrently makes `status` cost max() rather than sum().
  const [version, roster, auth, flags] = devinPath
    ? await Promise.all([
        devinVersion(devinPath),
        devinModels(devinPath, modelsTimeout),
        devinAuthStatus(devinPath, modelsTimeout),
        devinFlags(devinPath),
      ])
    : [null, null, null, null];
  // The CLI auto-updates underneath the plugin. Reporting a flag it no longer
  // accepts is the difference between "update the plugin" and an afternoon
  // spent reading identical argv errors from three different models.
  const absent = missingFlags(flags);

  const environment = {
    node: {
      version: process.versions.node,
      ok: Number.isFinite(nodeMajor) && nodeMajor >= NODE_MINIMUM,
      minimum: `${NODE_MINIMUM}.0.0`,
    },
    platform: process.platform,
    git: { path: gitPath, version: gitVersion, ok: Boolean(gitPath) },
    devin: {
      path: devinPath,
      version,
      // `responds` is deliberately not called `authenticated`: the CLI can
      // answer from a cached roster, so a model list proves the binary works,
      // not that the account is live. `auth.loggedIn` is the claim about auth.
      responds: Boolean(roster),
      modelCount: roster ? roster.models.length : null,
      roster,
      loggedIn: auth ? auth.loggedIn : null,
      account: auth ? { email: auth.email, tier: auth.tier, plan: auth.plan } : null,
      defaultModelAvailable: roster ? modelExists(roster, MODEL_DEFAULT) : null,
      missingFlags: absent,
      compatible: absent.length === 0,
      ok: Boolean(devinPath) && Boolean(roster) && Boolean(auth?.loggedIn) && absent.length === 0,
    },
    repo: null,
  };

  if (includeRepo && gitPath) {
    const root = await repoRoot(gitPath, cwd);
    environment.repo = {
      root,
      ok: Boolean(root),
      devinConfigs: root ? await detectRepoDevinConfig(root) : [],
    };
  }

  environment.ready = environment.node.ok && environment.git.ok && environment.devin.ok;
  return environment;
}

/**
 * Find Devin config files committed into the repository.
 *
 * Worth surfacing because of an interaction that is easy to miss: reviews run
 * with --respect-workspace-trust false (print mode cannot show the trust
 * prompt), and project-level config outranks user-level config in Devin's
 * precedence order. A repository you did not write could therefore carry
 * permission rules that widen what a reviewer may do inside it.
 *
 * This is a warning, not a block. In the overwhelmingly common case the repo is
 * the user's own and the file is their own deliberate configuration — but
 * "reviewing a branch from a stranger's fork" is exactly when you want to have
 * been told.
 */
export async function detectRepoDevinConfig(root) {
  const candidates = [
    ".devin/config.json",
    ".devin/config.local.json",
    ".devin/mcp_config.json",
    ".devin/mcp_config.local.json",
  ];
  const found = [];
  for (const relative of candidates) {
    try {
      const stat = await fs.stat(path.join(root, relative));
      if (stat.isFile()) found.push(relative);
    } catch {
      // Absent is the normal case.
    }
  }
  return found;
}

/** Repo-scope MCP files Devin starts during session creation. */
export function repoMcpConfigs(configs) {
  return (configs ?? []).filter((file) =>
    file === ".devin/mcp_config.json" || file === ".devin/mcp_config.local.json"
  );
}

/**
 * Files in which a repository can declare lifecycle hooks.
 *
 * `.devin/hooks.v1.json` is the whole-file form; the rest nest hooks under a
 * "hooks" key. The `.claude/*` entries are not a mistake — the Devin CLI reads
 * Claude Code's settings files for hooks too.
 */
const HOOK_SOURCES = [
  { file: ".devin/hooks.v1.json", whole: true },
  { file: ".devin/config.json", whole: false },
  { file: ".devin/config.local.json", whole: false },
  { file: ".claude/settings.json", whole: false },
  { file: ".claude/settings.local.json", whole: false },
];

/**
 * Find hooks the repository declares.
 *
 * This exists because of a hole that the reviewer's permission model cannot
 * close. Devin runs project hooks — `SessionStart` among them — as **shell
 * commands, at session start, before the model does anything**, and entirely
 * independently of which tools the agent is allowed. Denying `exec` does not
 * touch them. Verified by reproduction: a `SessionStart` hook in a scratch repo
 * wrote a file during a review that had `exec` and `Write(**)` denied.
 *
 * Reviews are therefore refused outright when a repository declares hooks,
 * rather than warned about. A warning would be the wrong shape of response: the
 * commands run before anyone reads the warning.
 *
 * Detection is on a *declaration*, not on a file. Nearly every repository worth
 * reviewing has a `.claude/settings.json`, and blocking on its mere existence
 * would make the tool useless. Unparseable files are treated as declaring hooks:
 * the failure mode of being wrong in that direction is an unnecessary prompt,
 * and in the other direction it is arbitrary code execution.
 */
export async function detectHookSources(root) {
  const found = [];
  for (const { file, whole } of HOOK_SOURCES) {
    let text;
    try {
      text = await fs.readFile(path.join(root, file), "utf8");
    } catch {
      continue; // Absent is the normal case.
    }
    if (!text.trim()) continue;

    if (whole) {
      found.push({ file, events: describeEvents(safeParse(text)) });
      continue;
    }

    const parsed = safeParse(text);
    if (parsed === undefined) {
      // Could not parse — comments, trailing commas, or corruption. Fall back to
      // asking whether the word appears at all, and fail closed if it does.
      if (/"hooks"\s*:/.test(text)) found.push({ file, events: ["unparsed"] });
      continue;
    }
    if (parsed && typeof parsed === "object" && parsed.hooks && Object.keys(parsed.hooks).length > 0) {
      found.push({ file, events: describeEvents(parsed.hooks) });
    }
  }
  return found;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeEvents(hooks) {
  if (!hooks || typeof hooks !== "object") return ["unparsed"];
  const events = Object.keys(hooks).filter((key) => key !== "$schema");
  return events.length > 0 ? events : ["unparsed"];
}

/** Ordered, actionable remediation for whatever is not ready. */
export function remediation(environment) {
  const steps = [];
  if (!environment.node.ok) {
    steps.push({
      problem: `Node ${environment.node.version} is older than the required ${environment.node.minimum}.`,
      fix: "Install a current Node runtime (https://nodejs.org) and re-run.",
    });
  }
  if (!environment.git.ok) {
    steps.push({
      problem: "git was not found on PATH.",
      fix: "Install git and make sure it is on PATH.",
    });
  }
  if (!environment.devin.path) {
    steps.push({
      problem: "devin was not found on PATH.",
      fix: `Install the Devin CLI and make sure it is on PATH. See ${DEVIN_URL}`,
    });
  } else if (environment.devin.loggedIn === false) {
    steps.push({
      problem: "The Devin CLI is installed but not logged in.",
      fix:
        "Run `devin auth login` — it opens an interactive browser flow, so it cannot " +
        "be done for you. Then re-run this check.",
    });
  } else if (!environment.devin.responds) {
    steps.push({
      problem: "devin is installed but `devin models list` returned nothing.",
      fix:
        "Check connectivity and `devin auth status`. If you are behind a proxy, " +
        "configure it in ~/.config/devin/config.json.",
    });
  } else if (!environment.devin.compatible) {
    steps.push({
      problem:
        `Your devin CLI (${environment.devin.version ?? "unknown version"}) does not accept ` +
        `${environment.devin.missingFlags.join(", ")}, which this plugin passes on every run.`,
      fix:
        "The CLI has changed underneath the plugin. Update devin-review to a version that " +
        `matches your CLI; if it is already current, report the missing flag(s). See ${DEVIN_URL}`,
    });
  } else if (environment.devin.defaultModelAvailable === false) {
    steps.push({
      problem: `The default model ${MODEL_DEFAULT} is not available to this account.`,
      fix: "Run `devin-review models` to see what you can use, then pass --model.",
    });
  }
  if (environment.repo && !environment.repo.ok) {
    steps.push({
      problem: "The current directory is not inside a git repository.",
      fix: "cd into your project before running a review.",
    });
  }
  return steps;
}
