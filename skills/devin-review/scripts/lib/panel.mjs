// Running several models over the same diff, in parallel.
//
// The point of a panel is decorrelated error: two reviewers are worth more than
// one only to the extent that they are wrong about different things. That single
// idea drives every decision in this file.
//
// Most importantly, it is why nothing here synthesises. A tempting next step is
// to hand the three reviews to a fourth model and ask for "the merged findings",
// but that model has no repository access, cannot check any claim, and
// systematically prefers whatever is stated most confidently. It would launder
// three independent signals into one derivative opinion and hide the
// disagreements — which are the most informative part of a panel. So this file
// runs the models and classifies what came back; findings.mjs correlates them
// arithmetically, and reconciliation is left to the orchestrator, who can read
// the actual code.

import { classifyEmptyOutput, isCorrelatedModel, runDevin, stripFileLinks, tidyError } from "./devin.mjs";
import { extractJson, normalizeReport } from "./findings.mjs";

/**
 * Failure classes worth spending a second run on.
 *
 * `blocked_tool` is here because it is the dominant reviewer failure and it is
 * genuinely stochastic: the model reached for a tool it did not have, and on a
 * fresh attempt it usually does not. `empty_output` joins it as the unexplained
 * case — nothing to act on, so trying again is the only move left.
 *
 * `timeout` is pointedly NOT here even though interpret() marks it retryable for
 * a human. Retrying a run that already burned ten minutes silently doubles the
 * wall clock of a review the user is waiting on, and the reason it timed out
 * (usually a diff too large) will still be true the second time.
 */
const RETRY_CLASSES = new Set(["blocked_tool", "empty_output"]);

/**
 * Run one model and interpret the result, retrying once if it produced nothing
 * for a reason that a second attempt might not reproduce.
 *
 * The retry is deliberately confined to reviews. A rescue may have already
 * edited files by the time it fails, and running it again would either duplicate
 * those edits or act on a tree it did not expect — so rescue calls runDevin
 * directly and this function is never in its path.
 */
export async function runAndInterpret({
  repoRoot,
  keepLinks = false,
  lens = "defect",
  retry = true,
  onRetry,
  runner = runDevin,
  ...runOptions
}) {
  const attempt = async () => interpret(await runner({ repoRoot, ...runOptions }), repoRoot, { keepLinks, lens });

  const first = await attempt();
  if (!retry || first.ok || !RETRY_CLASSES.has(first.className)) return first;

  onRetry?.(first);
  const second = await attempt();

  // Either way the user is told this took two runs. A silent retry that also
  // failed would misreport the cost of the review, and a silent retry that
  // succeeded would hide a reviewer that is reliably reaching for a denied tool.
  if (second.ok) return { ...second, retried: true };
  return {
    ...second,
    retried: true,
    reason: `${second.reason} (retried once; the first attempt failed with ${first.className})`,
  };
}

/**
 * Run `models` against the same request with bounded concurrency.
 *
 * Concurrency is bounded because each worker is a full agent session holding a
 * large context; twelve at once is a good way to hit a rate limit and lose every
 * one of them. Failures are per-model and never abort the pool — a panel whose
 * third reviewer 500s is still worth two reviews, and the whole point is that we
 * report exactly what came back.
 */
export async function runPanel({
  devinPath,
  repoRoot,
  requestFile,
  configFile,
  exportFileFor,
  models,
  concurrency,
  timeoutMs,
  keepLinks = false,
  lens = "defect",
  retry = true,
  onStart,
  onRetry,
  onFinish,
  // Seam for tests: scheduling, ordering and failure isolation are the
  // interesting behaviour here, and none of it should require spawning five
  // real agent sessions to check.
  runner = runDevin,
}) {
  const results = new Array(models.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= models.length) return;
      const model = models[index];
      // Everything for one model sits inside one try, including interpret() and
      // the progress callbacks. Isolating only the runner call would leave a
      // throw anywhere else to reject the worker, which rejects Promise.all,
      // which discards every other reviewer's finished work — the precise
      // outcome this pool exists to prevent.
      try {
        onStart?.(model);
        results[index] = await runAndInterpret({
          devinPath,
          repoRoot,
          requestFile,
          configFile,
          // Panel workers share one work dir, so the transcript path must be
          // per-model or the reviewers overwrite each other's evidence.
          exportFile: exportFileFor?.(model),
          model,
          timeoutMs,
          keepLinks,
          lens,
          retry,
          onRetry: (first) => onRetry?.(model, first),
          runner,
        });
      } catch (error) {
        // A throw here is ours, not Devin's — a bad mode, a spawn we could not
        // even attempt, a malformed result. Record it as this model's failure
        // rather than taking down the other reviewers with it.
        results[index] = {
          model,
          ok: false,
          review: "",
          durationSeconds: 0,
          className: "internal_error",
          reason: error?.message ?? String(error),
        };
      }
      // Reporting a result must not be able to lose it either.
      try {
        onFinish?.(results[index]);
      } catch {
        // A broken progress callback is not worth failing a review over.
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, models.length)) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Turn a raw run into a panel result, deciding whether it counts as a review.
 *
 * A run that produced text but not parseable JSON is still `ok`. The text is
 * kept and rendered with a caveat rather than thrown away: an unparseable
 * review is a review, and discarding one because a model got its punctuation
 * wrong would lose exactly the finding you paid for.
 */
export function interpret(result, repoRoot, { keepLinks = false, lens = "defect" } = {}) {
  const base = {
    model: result.model,
    durationSeconds: result.durationSeconds,
    exitCode: result.code,
  };

  if (result.timedOut) {
    return { ...base, ok: false, review: "", className: "timeout", retryable: true,
      reason: `no answer within the timeout (killed after ${result.durationSeconds}s)` };
  }

  // A non-zero exit and an empty success both need the same question asked of
  // stderr. Quota exhaustion in particular arrives as a non-zero exit, and
  // reporting that as a generic "exit_error" buries the one detail — that the
  // account is out of budget, not that the tool is broken — which tells the
  // user what to do next.
  if (result.code !== 0 || !result.stdout.trim()) {
    const classified = classifyEmptyOutput(result.stderr, result.durationSeconds, result.denials);
    const generic = classified.className === "empty_output";

    // An unexplained non-zero exit must not borrow the empty-output fallback
    // reason, which says "exit 0" in so many words. Reporting a crash as a
    // clean-but-silent run sends the reader looking in entirely the wrong place.
    if (generic && result.code !== 0) {
      const stderr = (result.stderr ?? "").trim();
      return {
        ...base,
        ok: false,
        review: "",
        className: "exit_error",
        reason: stderr
          ? tidyError(stderr)
          : `devin exited ${result.code} after ${result.durationSeconds}s with no output`,
        retryable: false,
      };
    }

    return {
      ...base,
      ok: false,
      review: "",
      className: classified.className,
      reason: classified.reason,
      retryable: classified.retryable ?? false,
    };
  }

  const review = keepLinks ? result.stdout.trim() : stripFileLinks(result.stdout, repoRoot).trim();
  const report = normalizeReport(extractJson(review), lens);

  if (!report) {
    return { ...base, ok: true, review, report: null, format: "unstructured",
      reason: "no JSON object found in the output", className: "ok" };
  }
  return { ...base, ok: true, review, report, format: "json", className: "ok", reason: "" };
}

/**
 * Warn about a panel whose members will probably agree for the wrong reasons.
 *
 * Returns human-readable warnings, never blocks: the user may have a good reason
 * to compare two checkpoints of one family, and a review tool that argues with
 * its operator is a review tool that gets uninstalled.
 */
export function diversityWarnings(models, roster) {
  const warnings = [];
  if (models.length < 2) return warnings;

  const correlated = models.filter(isCorrelatedModel);
  if (correlated.length === models.length) {
    warnings.push(
      `every model in this panel is a Claude model (${correlated.join(", ")}). ` +
        "They correlate with the assistant orchestrating this review, so their agreement " +
        "is closer to an echo than to independent confirmation.",
    );
  } else if (correlated.length > 0) {
    warnings.push(
      `${correlated.join(", ")} correlates with the assistant running this review; ` +
        "weight its agreement accordingly.",
    );
  }

  const families = new Map();
  for (const model of models) {
    const entry = roster?.models.find((m) => m.id === model);
    const family = entry?.family ?? model;
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  if (families.size === 1) {
    warnings.push(
      `all ${models.length} models come from one family (${[...families.keys()][0]}). ` +
        "A panel of siblings costs N times as much and buys very little decorrelation.",
    );
  }

  return warnings;
}

/**
 * Estimate what a panel will cost, in dollars.
 *
 * Deliberately crude and deliberately labelled as such: we know the prompt size
 * exactly but the reviewer's own file reads and its output are unknowable in
 * advance, so this is an order-of-magnitude sanity check to catch "I just ran
 * five frontier models over a 400KB diff", not an invoice.
 */
export function estimateCost(models, promptBytes, roster) {
  if (!roster) return null;
  const promptTokens = promptBytes / 4;
  // Reviewers read far more of the repo than we hand them, and reason at length.
  const assumedInput = promptTokens * 3;
  const assumedOutput = 4000;

  let total = 0;
  let priced = 0;
  const perModel = [];
  for (const model of models) {
    const entry = roster.models.find((m) => m.id === model);
    if (!entry || entry.free) {
      perModel.push({ model, dollars: entry?.free ? 0 : null, free: Boolean(entry?.free) });
      if (entry?.free) priced += 1;
      continue;
    }
    if (entry.inputPrice === null || entry.outputPrice === null) {
      perModel.push({ model, dollars: null, free: false });
      continue;
    }
    const dollars = (assumedInput / 1e6) * entry.inputPrice + (assumedOutput / 1e6) * entry.outputPrice;
    total += dollars;
    priced += 1;
    perModel.push({ model, dollars, free: false });
  }
  return { total, perModel, complete: priced === models.length };
}
