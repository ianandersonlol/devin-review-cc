#!/usr/bin/env node
// devin-review — adversarial code review via the Devin CLI.
//
// Runs Devin against YOUR ACTUAL REPO, non-interactively and read-only, so the
// reviewer can follow call sites instead of only critiquing a pasted diff.
//
// Devin's distinguishing feature among the review CLIs is that one binary
// fronts many vendors' models, so `panel` runs several of them over the same
// diff at once and reports each separately. See lib/panel.mjs for why it
// reports rather than synthesises.
//
// Nothing here goes through a shell: every spawn takes an argv array and a
// natively-formatted path from os.tmpdir().

import { promises as fs } from "node:fs";
import path from "node:path";

import { parseArgs, USAGE, UsageError } from "./lib/args.mjs";
import {
  devinFlags,
  devinModels,
  DEVIN_URL,
  findDevin,
  isCorrelatedModel,
  missingFlags,
  MODEL_DEFAULT,
  modelExists,
  prepareSessionConfig,
  readOnlyPermissions,
  rescuePermissions,
  resolveMode,
  runDevin,
  stripFileLinks,
} from "./lib/devin.mjs";
import {
  collectDiff,
  currentBranch,
  diffTrees,
  findGit,
  GitError,
  refExists,
  repoRoot,
  snapshotTree,
  treeChanges,
} from "./lib/git.mjs";
import { detectHookSources, detectRepoDevinConfig, probeEnvironment, remediation } from "./lib/env.mjs";
import { buildRequest, buildRescueRequest } from "./lib/prompts.mjs";
import {
  diversityWarnings,
  estimateCost,
  interpret,
  runAndInterpret,
  runPanel,
} from "./lib/panel.mjs";
import { renderPanel, renderReport, renderUnstructured } from "./lib/render.mjs";
import { scanForSecrets } from "./lib/secrets.mjs";
import { createTempDir, removeTempDir } from "./lib/tempdir.mjs";

const LARGE_DIFF_BYTES = 400000;

const log = (message) => process.stderr.write(`devin-review: ${message}\n`);
const raw = (message) => process.stderr.write(`${message}\n`);

class ExitError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const die = (message, code = 1) => {
  throw new ExitError(message, code);
};

/**
 * Refuse to run inside a repository that declares lifecycle hooks.
 *
 * Devin executes project hooks as shell commands at session start, before the
 * model acts and regardless of which tools it may use — so the read-only
 * permission model does not constrain them at all. Every subcommand that starts
 * a session goes through here.
 *
 * This blocks rather than warns because the commands would already have run by
 * the time a warning was read.
 */
async function guardHooks(root, options) {
  const hooks = await detectHookSources(root);
  if (hooks.length === 0) return;

  if (options.allowHooks) {
    log(`NOTE: running with repository hooks enabled (${hooks.map((h) => h.file).join(", ")}).`);
    return;
  }

  raw("devin-review: BLOCKED — this repository declares Devin lifecycle hooks.");
  for (const hook of hooks) raw(`  ${hook.file}  [${hook.events.join(", ")}]`);
  raw("");
  raw("Devin runs project hooks as shell commands when the session starts, before the");
  raw("model does anything and no matter which tools it is allowed. They are outside the");
  raw("read-only guarantee, so a review here could execute code from this repository.");
  raw("");
  raw("If these hooks are yours and you trust them, re-run with --allow-hooks.");
  die("refusing to start a session in a repository that declares hooks", 6);
}

/**
 * Refuse to start when the installed CLI does not accept the arguments we are
 * about to pass it.
 *
 * Devin auto-updates underneath the plugin. When `--agent-config` was removed,
 * every model in a panel died at argv parsing with the same `unexpected
 * argument` error, which reads like a broken plugin rather than a CLI that moved
 * — and cost an afternoon to diagnose. One `devin --help` is local, instant, and
 * turns that into a sentence naming the flag.
 *
 * Unknown is not failure: if `--help` cannot be read, missingFlags() returns
 * nothing and the run proceeds. Refusing to review code because a help screen
 * would not parse is worse than the problem it guards against.
 */
async function guardCliCompatibility(devinPath) {
  const missing = missingFlags(await devinFlags(devinPath));
  if (missing.length === 0) return;

  raw(`devin-review: BLOCKED — your devin CLI does not accept: ${missing.join(", ")}`);
  raw("");
  raw("The Devin CLI has changed underneath this plugin, so every model would fail");
  raw("identically at argument parsing. This is a plugin problem, not an account problem.");
  raw("");
  raw("Run `devin-review setup` for details, then update the plugin:");
  raw(`  ${DEVIN_URL}`);
  die("devin CLI is incompatible with this version of the plugin", 7);
}

/** Per-model transcript path; panel workers share a work dir, so it must differ. */
function exportPathFor(workDir, model) {
  return path.join(workDir, `transcript-${model.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) die(error.message, 2);
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (options.subcommand === "setup") return commandSetup(options);
  if (options.subcommand === "status") return commandStatus(options);
  if (options.subcommand === "models") return commandModels(options);
  if (options.subcommand === "rescue") return commandRescue(options);
  return commandReview(options);
}

// ── review / challenge / panel ───────────────────────────────────────────────

/**
 * One code path serves a single reviewer and a panel.
 *
 * Both render from the same validated structure; they differ only in what there
 * is to say about it. A single review gets its findings listed; a panel
 * additionally gets the corroboration map, which is the one thing several
 * reviewers can tell you that one cannot.
 */
async function commandReview(options) {
  const gitPath = await findGit();
  if (!gitPath) die("git not found on PATH", 2);

  const devinPath = options.dryRun ? null : await findDevin();
  if (!options.dryRun && !devinPath) {
    die(`devin not found on PATH. Install the Devin CLI and re-run; see ${DEVIN_URL}`, 2);
  }

  const root = await repoRoot(gitPath);
  if (!root) die("not inside a git repository — cd into your project first", 2);

  // Validate an explicit --base up front so we never silently review the wrong
  // thing after printing an error.
  if (options.base && !(await refExists(gitPath, root, options.base))) {
    die(`base ref '${options.base}' does not resolve in this repo`, 2);
  }

  const workDir = await createTempDir("devin-review-");
  try {
    let diff;
    try {
      diff = await collectDiff({
        gitPath,
        repoRoot: root,
        mode: options.diffMode,
        base: options.base,
        paths: options.paths,
        workDir,
      });
    } catch (error) {
      // A failed git invocation must not be reported as "no changes to review".
      if (error instanceof GitError) die(error.message, 2);
      throw error;
    }

    for (const skipped of diff.untrackedSkipped) {
      log(`skipping untracked file over 256KB: ${skipped}`);
    }
    if (diff.truncated) {
      log("WARNING: the diff exceeded the internal buffer limit and was truncated — scope it with paths or --staged");
    }

    if (!diff.text.trim()) {
      log(`no changes to review (${diff.description}).`);
      return 0;
    }

    const diffBytes = Buffer.byteLength(diff.text, "utf8");
    if (diffBytes > LARGE_DIFF_BYTES) {
      log(`WARNING: diff is ${diffBytes} bytes — consider scoping with paths or --staged.`);
    }

    // The diff leaves this machine. Block on obvious credential shapes unless waived.
    if (!options.allowSecrets) {
      const hits = scanForSecrets(diff.text);
      if (hits.length > 0) {
        raw("devin-review: BLOCKED — the diff contains added lines matching credential shapes.");
        raw("This review would send them to Cognition and the model provider. Matched (diff line numbers):");
        for (const hit of hits) raw(`  ${hit.line}:${hit.text}`);
        raw("Scope it (devin-review -- path/to/safe/dir) or waive with --allow-secrets.");
        return 4;
      }
    }

    const isPanel = options.models.length > 1;

    // Read the roster directly rather than through probeEnvironment: we only
    // want the model list, and the full probe would additionally hit `devin auth
    // status` on the way to every single review.
    //
    // A dry run resolves it too. Listing models spends nothing, and the estimate
    // of what a panel will cost is most of the reason to dry-run a panel at all.
    const rosterPath = devinPath ?? (await findDevin());
    let roster = null;
    if (rosterPath) {
      roster = await devinModels(rosterPath, 15000);
      const unknown = options.models.filter((m) => !modelExists(roster, m));
      if (unknown.length > 0) {
        die(
          `unknown model(s): ${unknown.join(", ")}. Run \`devin-review models\` to see what your ` +
            "account can use.",
          2,
        );
      }
    }

    const warnings = isPanel ? diversityWarnings(options.models, roster) : [];
    if (!isPanel && isCorrelatedModel(options.models[0])) {
      warnings.push(
        `${options.models[0]} is a Claude model and correlates with the assistant orchestrating ` +
          "this review, so it is a weaker second opinion than a model from another lab.",
      );
    }
    for (const warning of warnings) log(`NOTE: ${warning}`);

    // Print mode has to waive the workspace-trust prompt, so a repo-local Devin
    // config is loaded without anyone being asked. Our deny list did hold
    // against one that tried to allow what we deny — deny beats allow — but the
    // file can still carry MCP servers and other settings, so say it is there.
    const repoConfigs = await detectRepoDevinConfig(root);
    if (repoConfigs.length > 0) {
      log(
        `NOTE: this repository ships ${repoConfigs.join(", ")}, which Devin loads alongside the ` +
          "read-only config used here. Our deny list still applies; check the file if the repo is not yours.",
      );
    }

    const cost = estimateCost(options.models, diffBytes, roster);

    // Checked before the dry-run exit as well: a dry run that reports "OK" for a
    // repository a real run would refuse to enter is a misleading rehearsal.
    await guardHooks(root, options);
    // Same reasoning for the CLI itself — "dry run OK" against a binary that
    // would reject our very first argument is the most misleading rehearsal
    // available. rosterPath is set even on a dry run, where devinPath is not.
    if (rosterPath) await guardCliCompatibility(rosterPath);

    // Dry run stops here: the diff is assembled and the secret scan has passed,
    // but no Devin call is made and nothing is spent.
    if (options.dryRun) {
      log(
        `dry run OK — lens=${options.lens} models=${options.models.join(",")} ` +
          `scope=${diff.description} files=${diff.filesChanged} diff=${diffBytes}B ` +
          "(no devin call, nothing spent)",
      );
      if (cost) log(`rough cost estimate: ${describeCost(cost)}`);
      return 0;
    }

    const branch = await currentBranch(gitPath, root);
    const request = buildRequest({
      lens: options.lens,
      repoRoot: root,
      branch,
      description: diff.description,
      filesChanged: diff.filesChanged,
      focus: options.focus,
      diff: diff.text,
    });

    // 0600 on POSIX. On Windows the mode is advisory; the real protection is
    // that os.tmpdir() resolves to a per-user directory whose ACL we inherit.
    const requestFile = path.join(workDir, "review-request.md");
    await fs.writeFile(requestFile, request, { mode: 0o600 });
    const configFile = await prepareSessionConfig(workDir, readOnlyPermissions());

    if (!options.quiet) {
      log(
        `lens=${options.lens} models=${options.models.join(",")} scope=${diff.description} ` +
          `files=${diff.filesChanged} diff=${diffBytes}B timeout=${options.timeout}` +
          (isPanel ? ` concurrency=${options.concurrency}` : ""),
      );
      if (cost && cost.total > 0.05) log(`rough cost estimate: ${describeCost(cost)}`);
    }

    if (!isPanel) {
      const model = options.models[0];
      const interpreted = await runAndInterpret({
        devinPath,
        repoRoot: root,
        requestFile,
        configFile,
        exportFile: exportPathFor(workDir, model),
        model,
        timeoutMs: options.timeoutMs,
        keepLinks: options.keepLinks,
        lens: options.lens,
        onRetry: (first) => log(`${model} produced nothing [${first.className}] — retrying once...`),
      });

      if (!interpreted.ok) {
        log(`no review produced [${interpreted.className}]: ${interpreted.reason}`);
        // Only a reviewer can promise this; rescue reports write state from its
        // snapshots instead, because there it might not be true.
        if (interpreted.className === "blocked_tool") {
          log("nothing was written to your repository — reviews cannot edit files.");
        }
        return interpreted.className === "exit_error" ? (interpreted.exitCode || 1) : 3;
      }

      // --json is available on every review path, not just the panel: the
      // primary consumer is an agent, and a tool whose output shape depends on
      // how many models you asked for is a tool that needs special-casing.
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          lens: options.lens,
          scope: diff.description,
          results: [interpreted],
        }, null, 2)}\n`);
        return 0;
      }

      process.stdout.write(
        `${interpreted.report
          ? renderReport({
              report: interpreted.report,
              model: interpreted.model,
              lens: options.lens,
              scope: diff.description,
              durationSeconds: interpreted.durationSeconds,
            })
          : renderUnstructured({
              text: interpreted.review,
              model: interpreted.model,
              reason: interpreted.reason,
            })}\n`,
      );
      if (!options.quiet) {
        log(`completed in ${interpreted.durationSeconds}s (${interpreted.format})`);
        if (interpreted.format === "unstructured") {
          log("NOTE: this model did not return parseable JSON; findings are not addressable.");
        }
      }
      return 0;
    }

    if (!options.quiet) {
      log(`running ${options.models.length} reviewers in parallel...`);
    }
    const results = await runPanel({
      devinPath,
      repoRoot: root,
      requestFile,
      configFile,
      exportFileFor: (model) => exportPathFor(workDir, model),
      models: options.models,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      keepLinks: options.keepLinks,
      lens: options.lens,
      onRetry: (model, first) => {
        if (!options.quiet) log(`  ${model} produced nothing [${first.className}] — retrying once...`);
      },
      onFinish: (result) => {
        if (options.quiet) return;
        log(
          result.ok
            ? `  ${result.model} finished in ${result.durationSeconds}s ` +
              `(${result.report ? `${result.report.findings.length} findings` : "unstructured"})`
            : `  ${result.model} produced nothing [${result.className}]`,
        );
      },
    });

    const usable = results.filter((r) => r.ok);
    if (usable.length === 0) {
      log("every model in the panel produced nothing:");
      for (const result of results) raw(`  ${result.model} [${result.className}]: ${result.reason}`);
      return 5;
    }

    // A partial panel still exits 0 — two of three reviews are worth having, and
    // failing the command would throw them away. But it must not exit 0 QUIETLY:
    // a silent reviewer is missing data, and the failure mode this guards against
    // is a reader counting "nobody objected" as consensus. Said on stderr here
    // and again in the report itself, because those reach different readers.
    const silent = results.filter((r) => !r.ok);
    if (silent.length > 0 && !options.quiet) {
      log(`WARNING: ${silent.length} of ${results.length} model(s) returned nothing — missing data, not agreement:`);
      for (const result of silent) log(`  ${result.model} [${result.className}]: ${result.reason}`);
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ lens: options.lens, scope: diff.description, results }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(
      `${renderPanel({ results, lens: options.lens, scope: diff.description, warnings })}\n`,
    );
    return 0;
  } finally {
    await removeTempDir(workDir);
  }
}

function describeCost(cost) {
  const free = cost.perModel.filter((m) => m.free).map((m) => m.model);
  const unknown = cost.perModel.filter((m) => m.dollars === null && !m.free).map((m) => m.model);
  const parts = [`~$${cost.total.toFixed(2)} (very rough)`];
  if (free.length > 0) parts.push(`free: ${free.join(", ")}`);
  if (unknown.length > 0) parts.push(`unpriced: ${unknown.join(", ")}`);
  return parts.join(" · ");
}

// ── rescue ───────────────────────────────────────────────────────────────────

/**
 * Diagnose and fix a problem. Unlike every other subcommand, the default mode
 * lets Devin WRITE to the working tree.
 *
 * The safety model is entirely git-based, which is why a repository is
 * mandatory here even though a bare diagnosis would not strictly need one:
 * every change Devin makes is recoverable, and we bracket the run with two tree
 * snapshots so the report shows precisely what it touched — not merely what
 * differs from HEAD, which would wrongly blame Devin for the user's own work.
 */
async function commandRescue(options) {
  const gitPath = await findGit();
  if (!gitPath) die("git not found on PATH", 2);

  const devinPath = options.dryRun ? null : await findDevin();
  if (!options.dryRun && !devinPath) {
    die(`devin not found on PATH. Install the Devin CLI and re-run; see ${DEVIN_URL}`, 2);
  }

  const root = await repoRoot(gitPath);
  if (!root) {
    die(
      "rescue must run inside a git repository — it edits files, and git is what makes that undoable",
      2,
    );
  }

  const workDir = await createTempDir("devin-rescue-");
  try {
    // Context is the user's uncommitted work: often the cause, always a lead.
    let contextDiff = "";
    if (!options.noContext) {
      try {
        const diff = await collectDiff({
          gitPath,
          repoRoot: root,
          mode: "uncommitted",
          base: "",
          paths: options.paths,
          workDir,
        });
        contextDiff = diff.text;
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        log(`could not collect context diff (${error.message}); continuing without it`);
      }
    }

    // The context diff leaves the machine, so it gets the same pre-flight as a
    // review. The problem statement is the user's own words and is not scanned.
    if (contextDiff && !options.allowSecrets) {
      const hits = scanForSecrets(contextDiff);
      if (hits.length > 0) {
        raw("devin-review: BLOCKED — your uncommitted diff contains added lines matching credential shapes.");
        raw("Rescue would send them as context. Matched (diff line numbers):");
        for (const hit of hits) raw(`  ${hit.line}:${hit.text}`);
        raw("Re-run with --no-context to omit the diff, or --allow-secrets to send it anyway.");
        return 4;
      }
    }

    const branch = await currentBranch(gitPath, root);
    const mode = resolveMode(options.subcommand, options.readOnly, options.allowCommands);

    await guardHooks(root, options);
    // Before the dry-run exit, for the same reason as review: a rehearsal that
    // reports OK against a CLI which would reject our first argument is worse
    // than no rehearsal. `devinPath` is null on a dry run, so resolve it here.
    const compatPath = devinPath ?? (await findDevin());
    if (compatPath) await guardCliCompatibility(compatPath);

    if (options.dryRun) {
      log(
        `dry run OK — rescue mode=${mode} model=${options.models[0]} branch=${branch} context=${
          contextDiff ? `${Buffer.byteLength(contextDiff, "utf8")}B` : "none"
        } (no devin call, nothing spent, no files touched)`,
      );
      raw(`Problem: ${options.problem}`);
      return 0;
    }

    const request = buildRescueRequest({
      problem: options.problem,
      repoRoot: root,
      branch,
      readOnly: options.readOnly,
      allowCommands: options.allowCommands,
      contextDiff,
      focus: options.focus,
    });
    const requestFile = path.join(workDir, "rescue-request.md");
    await fs.writeFile(requestFile, request, { mode: 0o600 });

    const configFile = await prepareSessionConfig(
      workDir,
      options.readOnly
        ? readOnlyPermissions()
        : rescuePermissions({ allowCommands: options.allowCommands }),
    );

    // Snapshot BEFORE. The index lives in workDir — a scratch index inside the
    // repo would be picked up by `git add -A` and reported as Devin's own edit.
    const before = options.readOnly
      ? null
      : await snapshotTree(gitPath, root, path.join(workDir, "index-before"));

    if (!options.quiet) {
      log(
        `rescue mode=${mode}${options.readOnly ? " (no edits)" : " — WILL EDIT FILES"}` +
          `${options.allowCommands ? " AND RUN COMMANDS" : ""} ` +
          `model=${options.models[0]} branch=${branch} timeout=${options.timeout}`,
      );
    }

    // Deliberately runDevin and not runAndInterpret: a rescue that fails may
    // already have edited files, so an automatic second attempt would act on a
    // tree it did not expect. Reviews retry; rescue does not.
    const result = await runDevin({
      devinPath,
      repoRoot: root,
      requestFile,
      configFile,
      exportFile: exportPathFor(workDir, options.models[0]),
      model: options.models[0],
      mode,
      timeoutMs: options.timeoutMs,
    });

    // Snapshot AFTER, before interpreting the exit code: Devin may have edited
    // files and then failed, and the user needs to know either way.
    let changes = [];
    let changeDiff = "";
    if (!options.readOnly && before) {
      const after = await snapshotTree(gitPath, root, path.join(workDir, "index-after"));
      changes = await treeChanges(gitPath, root, before, after);
      if (changes.length > 0) changeDiff = await diffTrees(gitPath, root, before, after);
    }

    // The change report goes to STDOUT in one piece, delimiters included.
    //
    // Splitting it — markers on stderr, diff on stdout — looks fine on a
    // terminal and falls apart the moment anything captures the two streams
    // separately, which is exactly what a calling agent does: the diff arrives
    // detached from the block that says what it is, or ordered after its own
    // closing marker. What Devin changed to your files is content, not progress
    // chatter, so it belongs on the same stream as the report.
    const reportChanges = () => {
      if (options.readOnly) return;
      if (changes.length === 0) {
        log("devin made no file changes.");
        return;
      }
      const block = [
        "",
        `--- devin modified ${changes.length} file(s) ---`,
        ...changes.map((change) => `  ${change.status}\t${change.file}`),
        "",
        "--- exact diff of what devin changed ---",
        changeDiff.replace(/\n$/, ""),
        "--- end of devin's changes ---",
        "Nothing was staged or committed. Review the above before keeping it.",
        "",
      ];
      process.stdout.write(block.join("\n"));
    };

    // Rescue is deliberately NOT on the findings schema: its output is a
    // narrative of what was done and why, which does not decompose into
    // addressable claims about code the way a review does.
    // canRetry: false — rescue is never retried automatically, so it must not
    // tell the user that re-running usually works either.
    const interpreted = interpret(result, root, {
      keepLinks: options.keepLinks,
      lens: "none",
      canRetry: false,
    });

    if (!interpreted.ok) {
      log(`no report produced [${interpreted.className}]: ${interpreted.reason}`);
      if (result.stderr.trim() && interpreted.className === "exit_error") raw(result.stderr.trim());
      reportChanges();
      return interpreted.className === "exit_error" ? (result.code || 1) : 3;
    }

    process.stdout.write(`${interpreted.review}\n`);
    reportChanges();
    if (!options.quiet) log(`completed in ${interpreted.durationSeconds}s`);
    return 0;
  } finally {
    await removeTempDir(workDir);
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

async function commandSetup(options) {
  const environment = await probeEnvironment({ includeRepo: false });
  const steps = remediation(environment);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ready: environment.ready, environment, remediation: steps }, null, 2)}\n`,
    );
    return environment.ready ? 0 : 2;
  }

  const devin = environment.devin;
  const out = [];
  out.push(environment.ready ? "devin-review is ready." : "devin-review is NOT ready.");
  out.push("");
  out.push(`  node   ${environment.node.ok ? "ok" : "TOO OLD"}  ${environment.node.version} (need >= ${environment.node.minimum})`);
  out.push(`  git    ${environment.git.ok ? "ok" : "MISSING"}  ${environment.git.version ?? "not found on PATH"}`);
  out.push(
    `  devin  ${devin.ok ? "ok" : "NOT READY"}  ${
      devin.path ? `${devin.version ?? "unknown version"} at ${devin.path}` : "not found on PATH"
    }`,
  );
  if (devin.path) {
    out.push(`         auth   ${devin.loggedIn ? `logged in${devin.account?.email ? ` as ${devin.account.email}` : ""}${devin.account?.plan ? ` (${devin.account.plan} plan)` : ""}` : "NOT logged in"}`);
    out.push(
      `         models ${devin.responds ? `respond (${devin.modelCount} available)` : "did NOT respond"}` +
        (devin.defaultModelAvailable === false ? `; default ${MODEL_DEFAULT} is missing` : ""),
    );
    out.push(
      `         cli    ${
        devin.compatible
          ? "accepts every flag this plugin uses"
          : `INCOMPATIBLE — missing ${devin.missingFlags.join(", ")}`
      }`,
    );
  }
  out.push(`  platform  ${environment.platform}`);

  if (steps.length > 0) {
    out.push("", "To fix:");
    for (const step of steps) {
      out.push(`  - ${step.problem}`);
      out.push(`    ${step.fix}`);
    }
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return environment.ready ? 0 : 2;
}

// ── status ───────────────────────────────────────────────────────────────────

async function commandStatus(options) {
  // The scope preview is purely local; the devin probe can touch the network.
  // Running them concurrently means status costs max(local, remote) instead of
  // the sum, so an offline machine still gets its diff preview promptly.
  const [environment, scope] = await Promise.all([
    probeEnvironment({ modelsTimeout: 8000 }),
    collectScopePreview(options),
  ]);
  const report = { ready: environment.ready, environment, scope };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const devin = environment.devin;
  const out = [];
  out.push(
    `Tools: node ${environment.node.version} · git ${environment.git.ok ? "ok" : "MISSING"} · devin ${
      devin.ok ? `${devin.version ?? "ok"} responding` : "NOT READY"
    } · ${environment.platform}`,
  );
  if (devin.path && !devin.compatible) {
    out.push(`       devin CLI is INCOMPATIBLE — it does not accept ${devin.missingFlags.join(", ")}`);
  }
  if (devin.account?.plan) {
    out.push(`Devin: ${devin.account.email ?? "unknown user"} · ${devin.account.plan} plan · ${devin.modelCount ?? "?"} models`);
  }

  if (!report.scope) {
    out.push("Repo:  not inside a git repository — cd into your project.");
  } else if (report.scope.error) {
    out.push(`Repo:  ${report.scope.error}`);
  } else {
    const scope = report.scope;
    out.push(`Repo:  ${scope.root} (branch ${scope.branch})`);
    out.push(`Scope: ${scope.description}`);
    if (scope.empty) {
      out.push("       nothing to review");
    } else {
      out.push(
        `       ${scope.filesChanged} file(s), ${scope.diffBytes} bytes${scope.large ? "  ← large, consider scoping" : ""}`,
      );
      out.push(
        `       credential pre-flight: ${scope.secretPreflight}${
          scope.secretMatches > 0 ? ` (${scope.secretMatches} matching added line(s))` : ""
        }`,
      );
    }
    for (const skipped of scope.untrackedSkipped) out.push(`       skipped untracked >256KB: ${skipped}`);
    if (scope.devinConfigs?.length > 0) {
      out.push(`       repo ships ${scope.devinConfigs.join(", ")} — outranks our read-only config`);
    }
  }

  if (!environment.ready) {
    out.push("", "Not ready. Run `devin-review setup` for remediation steps.");
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

/**
 * Exactly what a review would send, without calling Devin. Resolves git itself
 * rather than reusing the environment probe's result, so it can run
 * concurrently with that probe instead of waiting behind it.
 */
async function collectScopePreview(options) {
  const gitPath = await findGit();
  if (!gitPath) return null;
  const root = await repoRoot(gitPath);
  if (!root) return null;

  if (options.base && !(await refExists(gitPath, root, options.base))) {
    return { root, error: `base ref '${options.base}' does not resolve in this repo` };
  }

  const workDir = await createTempDir("devin-status-");
  try {
    const diff = await collectDiff({
      gitPath,
      repoRoot: root,
      mode: options.diffMode,
      base: options.base,
      paths: options.paths,
      workDir,
    });
    const diffBytes = Buffer.byteLength(diff.text, "utf8");
    const hits = scanForSecrets(diff.text);
    return {
      root,
      branch: await currentBranch(gitPath, root),
      description: diff.description,
      filesChanged: diff.filesChanged,
      diffBytes,
      empty: !diff.text.trim(),
      large: diffBytes > LARGE_DIFF_BYTES,
      untrackedSkipped: diff.untrackedSkipped,
      secretPreflight: hits.length > 0 ? "would BLOCK" : "clear",
      secretMatches: hits.length,
      devinConfigs: await detectRepoDevinConfig(root),
    };
  } catch (error) {
    // status is diagnostic: report the git failure rather than crashing, so the
    // tool-readiness half of the output still reaches the user.
    if (error instanceof GitError) return { root, error: error.message };
    throw error;
  } finally {
    await removeTempDir(workDir);
  }
}

// ── models ───────────────────────────────────────────────────────────────────

/**
 * List what this account can actually use.
 *
 * Exists because Devin's roster is per-account and moves: hardcoding a model
 * table into documentation guarantees it is wrong within a release or two, and
 * "unknown model" is an expensive error to discover halfway through a panel.
 */
async function commandModels(options) {
  const devinPath = await findDevin();
  if (!devinPath) die(`devin not found on PATH; see ${DEVIN_URL}`, 2);

  const environment = await probeEnvironment({ includeRepo: false });
  const roster = environment.devin.roster;
  if (!roster) {
    die("could not read the model list — check `devin auth status` and your connection", 3);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(roster, null, 2)}\n`);
    return 0;
  }

  const out = [];
  out.push(`${roster.models.length} models across ${roster.families.length} families.`);
  out.push("");
  for (const family of roster.families) {
    const members = roster.models.filter((m) => m.family === family.id);
    if (members.length === 0) continue;
    const sample = members[0];
    const price = sample.free
      ? "free"
      : sample.inputPrice !== null
        ? `$${sample.inputPrice}/$${sample.outputPrice} per MTok`
        : "unpriced";
    const flags = [
      sample.beta ? "beta" : null,
      isCorrelatedModel(family.id) ? "correlates with Claude" : null,
    ].filter(Boolean);
    out.push(`${family.name} (${family.id}) — ${price}${flags.length ? `  [${flags.join("; ")}]` : ""}`);
    out.push(`  ${members.map((m) => m.id).join(", ")}`);
  }
  out.push("");
  out.push(`Default reviewer: ${MODEL_DEFAULT}`);
  out.push("Panels want different vendors, not different checkpoints of one model.");
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

// ── entrypoint ───────────────────────────────────────────────────────────────

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    if (error instanceof ExitError) {
      log(error.message);
      process.exitCode = error.code;
      return;
    }
    log(`unexpected failure: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
