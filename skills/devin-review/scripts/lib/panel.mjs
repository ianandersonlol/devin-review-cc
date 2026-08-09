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
// tallies verdicts mechanically, marks which models found nothing, and leaves
// reconciliation to the orchestrator, who can read the actual code.

import { classifyEmptyOutput, isCorrelatedModel, runDevin, stripFileLinks, tidyError } from "./devin.mjs";
import { VERDICTS } from "./prompts.mjs";

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
  agentConfigFile,
  models,
  concurrency,
  timeoutMs,
  keepLinks = false,
  onStart,
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
        const result = await runner({
          devinPath,
          repoRoot,
          requestFile,
          agentConfigFile,
          model,
          timeoutMs,
        });
        results[index] = interpret(result, repoRoot, { keepLinks });
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

/** Turn a raw run into a panel result, deciding whether it counts as a review. */
export function interpret(result, repoRoot, { keepLinks = false } = {}) {
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
    const classified = classifyEmptyOutput(result.stderr, result.durationSeconds);
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
  return { ...base, ok: true, review, className: "ok", reason: "" };
}

/**
 * Pull the verdict word out of a review.
 *
 * Anchored to the documented closing heading and to the vocabulary of the lens
 * that was actually requested. Searching the whole document for any verdict word
 * would happily match a reviewer writing "I would normally SHIP this, but" in
 * the middle of a finding, and a tally is worse than useless if it is wrong.
 */
export function extractVerdict(review, lens) {
  const allowed = VERDICTS[lens] ?? [];
  // Models reliably emphasise the verdict — "### **Verdict:** SHIP",
  // "### Verdict: **SHIP**" — and a tally that reads those as "unstated" makes
  // the panel look like it disagreed when it did not. Asterisks are tolerated
  // anywhere the heading allows them; the anchoring to a heading is what still
  // keeps prose out.
  const pattern = new RegExp(
    `^#{1,6}\\s*\\**\\s*Verdict:?\\**\\s*:?\\s*\\**(${allowed.map(escapeRegExp).join("|")})\\**\\b`,
    "im",
  );
  const match = review.match(pattern);
  return match ? match[1].toUpperCase() : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count findings by severity, for the at-a-glance header. */
export function countFindings(review, lens) {
  const heads = lens === "design"
    ? [["CHALLENGE", /^#{1,6}\s*CHALLENGE\b/gim]]
    : [
        ["CRITICAL", /^#{1,6}\s*CRITICAL\b/gim],
        ["HIGH", /^#{1,6}\s*HIGH\b/gim],
        ["MEDIUM", /^#{1,6}\s*MEDIUM\b/gim],
        ["LOW", /^#{1,6}\s*LOW\b/gim],
      ];
  const counts = {};
  for (const [name, pattern] of heads) {
    counts[name] = (review.match(pattern) ?? []).length;
  }
  return counts;
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

/** Render the panel report. */
export function formatPanel({ results, lens, scope, warnings }) {
  const out = [];
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  out.push(`# Panel review — ${results.length} model(s), ${lens} lens`);
  out.push("");
  out.push(`Scope: ${scope}`);
  out.push("");

  // Summary table first: with three long reviews below, the reader needs to know
  // where the disagreement is before deciding what to read.
  out.push("| Model | Verdict | Findings | Time |");
  out.push("| --- | --- | --- | --- |");
  for (const result of results) {
    if (!result.ok) {
      out.push(`| \`${result.model}\` | — (${result.className}) | — | ${result.durationSeconds}s |`);
      continue;
    }
    const verdict = extractVerdict(result.review, lens) ?? "unstated";
    const counts = countFindings(result.review, lens);
    const summary = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([name, n]) => `${n} ${name}`)
      .join(", ") || "none";
    out.push(`| \`${result.model}\` | ${verdict} | ${summary} | ${result.durationSeconds}s |`);
  }
  out.push("");

  const verdicts = ok.map((r) => extractVerdict(r.review, lens)).filter(Boolean);
  const distinct = [...new Set(verdicts)];
  if (distinct.length > 1) {
    out.push(
      `**The panel disagrees** (${distinct.join(" vs ")}). Disagreement is the most ` +
        "informative thing a panel produces: read the dissent closely and settle it against " +
        "the code rather than counting votes.",
    );
    out.push("");
  }

  for (const warning of warnings ?? []) {
    out.push(`> **Note:** ${warning}`);
    out.push("");
  }

  if (failed.length > 0) {
    out.push(`## Models that produced nothing (${failed.length})`);
    out.push("");
    for (const result of failed) {
      out.push(`- \`${result.model}\` — **${result.className}**: ${result.reason}`);
    }
    out.push("");
    out.push(
      "These reviewers did not run. Treat their silence as missing data, not as agreement " +
        "that the change is fine.",
    );
    out.push("");
  }

  for (const result of ok) {
    out.push("---");
    out.push("");
    out.push(`## Reviewer: \`${result.model}\`  _(${result.durationSeconds}s)_`);
    out.push("");
    out.push(result.review);
    out.push("");
  }

  return out.join("\n");
}
