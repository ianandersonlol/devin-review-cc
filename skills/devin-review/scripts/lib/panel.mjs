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

import { promises as fs } from "node:fs";
import path from "node:path";

import { classifyEmptyOutput, describeDenials, isCorrelatedModel, runDevin, stripFileLinks, tidyError } from "./devin.mjs";
import { extractJson, normalizeReport, VERDICTS } from "./findings.mjs";

/**
 * Failure classes worth spending a second run on.
 *
 * `blocked_tool` is here because it is the dominant reviewer failure and a
 * second attempt — now carrying a note naming the call that killed the first —
 * usually does not repeat it. `empty_report` is its cousin: the model finished
 * but ended its turn on narration instead of a report, which a pointed reminder
 * reliably fixes. `empty_output` joins them as the unexplained case — nothing
 * to act on, so trying again is the only move left.
 *
 * `timeout` is pointedly NOT here even though interpret() marks it retryable for
 * a human. Retrying a run that already burned its whole budget silently doubles the
 * wall clock of a review the user is waiting on, and the reason it timed out
 * (usually a diff too large) will still be true the second time.
 */
const RETRY_CLASSES = new Set(["blocked_tool", "empty_output", "empty_report"]);

/**
 * What to tell the model the second time, given how the first attempt died.
 *
 * This exists because the naive retry was measured not working: a model whose
 * FIRST move is deterministically the denied one — glm-5-2 opens by inspecting
 * installed packages through an interpreter — fails identically on an identical
 * request. The retry only buys anything if it says what went wrong, so the note
 * names the exact call when the transcript recorded it.
 */
function retryNote(first, sandbox) {
  if (first.className === "blocked_tool") {
    const tried = describeDenials(first.denials);
    // The redirection differs by boundary. Sandboxed runs only lose turns to
    // the denied edit/write tools, where the fix is "print, don't save";
    // screened runs mostly lose them to shell commands, where the fix is
    // "read the source on disk instead of executing anything".
    const redirect = sandbox
      ? "Your report is PRINTED as your final message — the edit and write tools do not exist " +
        "for you, and there is no file to save anything to. Read code with your file tools and " +
        "read-only shell commands; that is the whole job."
      : "Everything this review needs can be reached with your read, grep and file-search tools " +
        "— including installed dependencies, whose source you should read on disk " +
        "(site-packages, node_modules, vendor or the equivalent) instead of launching an " +
        "interpreter to import them.";
    return (
      "Your previous attempt was terminated the moment it called " +
      (tried ? `a tool this session does not permit: ${tried}. ` : "a tool this session does not permit. ") +
      "That call discarded everything you had worked out, and repeating it will discard this " +
      `attempt too. Do not call it or anything like it again. ${redirect}`
    );
  }
  if (first.className === "empty_report") {
    return (
      "Your previous attempt ended its turn on a short narrative message instead of a report, " +
      "so it delivered nothing. Narration is not a deliverable. This time, finish the " +
      "investigation and make your final message the report itself, in the JSON format " +
      "specified below."
    );
  }
  return "";
}

/**
 * Assemble what changes on the second attempt: a request file that leads with
 * the retry note, and a transcript path of its own so the first attempt's
 * evidence is not overwritten by the very run investigating it.
 *
 * Best-effort by design — if the amended request cannot be written, the retry
 * proceeds with the original one, which is exactly what it did before this
 * mechanism existed.
 */
async function retryOverrides({ requestFile, exportFile, model, sandbox }, first) {
  const overrides = {};
  if (exportFile) {
    overrides.exportFile = `${exportFile.replace(/\.json$/i, "")}-retry.json`;
  }
  const note = retryNote(first, sandbox);
  if (!note || !requestFile) return overrides;
  try {
    const original = await fs.readFile(requestFile, "utf8");
    const amended = `# Second attempt — read this first\n\n${note}\n\n---\n\n${original}`;
    const retryFile = path.join(
      path.dirname(requestFile),
      `retry-${String(model ?? "model").replace(/[^A-Za-z0-9._-]/g, "_")}.md`,
    );
    await fs.writeFile(retryFile, amended, { mode: 0o600 });
    overrides.requestFile = retryFile;
  } catch {
    // The unamended retry is still worth a shot.
  }
  return overrides;
}

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
  const attempt = async (overrides = {}) =>
    interpret(await runner({ repoRoot, ...runOptions, ...overrides }), repoRoot, { keepLinks, lens });

  const first = await attempt();
  if (!retry || first.ok || !RETRY_CLASSES.has(first.className)) return first;

  onRetry?.(first);
  const second = await attempt(await retryOverrides(runOptions, first));

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
  sandbox = false,
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
          sandbox,
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
export function interpret(result, repoRoot, { keepLinks = false, lens = "defect", canRetry = true } = {}) {
  const base = {
    model: result.model,
    durationSeconds: result.durationSeconds,
    exitCode: result.code,
    // Carried on every result so the retry can name the call that killed the
    // first attempt, and so a --json consumer can see what was refused.
    denials: result.denials ?? [],
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
    const classified = classifyEmptyOutput(result.stderr, result.durationSeconds, result.denials, { canRetry });
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
    // Unparseable output is kept — but only when it is plausibly a REVIEW. A
    // model that ends its turn on two sentences of mid-investigation narration
    // ("Now let me check how uvicorn logs access lines...") has delivered
    // nothing, and rendering that verbatim under a "Reviewer:" heading presents
    // zero review content as a review. That is a failure, and a retryable one.
    if (isEmptyNarration(review, lens)) {
      const snippet = review.replace(/\s+/g, " ").slice(0, 160);
      return {
        ...base,
        ok: false,
        review: "",
        className: "empty_report",
        retryable: true,
        reason:
          `the model ended its turn with ${review.length} characters of narration instead of a ` +
          `report: "${snippet}${review.length > 160 ? "…" : ""}"`,
      };
    }
    return { ...base, ok: true, review, report: null, format: "unstructured",
      reason: "no JSON object found in the output", className: "ok" };
  }
  return { ...base, ok: true, review, report, format: "json", className: "ok", reason: "" };
}

/**
 * Is this non-JSON output UNFINISHED narration rather than a review?
 *
 * The bar for discarding is deliberately high, because renderUnstructured's
 * promise — a review the parser could not read is still a review — is worth
 * keeping. Two panel reviewers (Gemini and GPT) independently caught the first
 * version discarding valid short reviews: it kept output only if it matched a
 * whitelist, so a clean conclusion like "No issues found after reading the call
 * sites" — no verdict word, no severity, no line — was thrown away and retried.
 *
 * So the logic is inverted. Everything is KEPT unless it positively reads as an
 * interrupted turn: short, carrying no conclusion of any kind, AND ending on an
 * announced-but-unperformed next action ("Now let me check…", "I'll look at…").
 * That announced-action signal is what actually distinguishes the observed
 * failure — a model narrating what it is ABOUT to do — from a model stating,
 * however tersely, what it FOUND. Rescue never reaches this at all: its lens has
 * no verdict vocabulary, and its narrative output is the deliverable.
 */
const NARRATION_MAX_CHARS = 500;

// An announced next action: the model saying it is ABOUT to investigate. The
// fingerprint is a first-person future/imperative lead ("let me", "I'll", "now
// I will") FOLLOWED WITHIN A FEW WORDS BY an investigation verb. Requiring the
// verb is what a panel reviewer's example forced: "This change is going to break
// on Node 18" is a finding, not narration — a bare "going to" must not match, so
// the lead alone is never enough.
const UNFINISHED_SIGNAL =
  /\b(?:let me|let'?s|i'?ll|i will|i'?m going to|i'?m about to|now i'?ll|now i will|next,? i'?ll)\s+(?:\w+\s+){0,3}?(?:check|look|examine|verify|trace|inspect|read|review|search|investigate|confirm|explore|scan|grep|see|start|begin|open|dig|analyz|analys|figure out|find out)\b/i;

// Any stated conclusion, however informal. If the model said what it found, it
// is a review — keep it, even without the formal vocabulary. Plurals and
// singulars both (another reviewer catch: `finding` missed "findings", and the
// "no X" list missed "no bug").
const CONCLUSION_SIGNAL =
  /\bfindings?\b|\bno (?:issues?|defects?|bugs?|problems?|concerns?)\b|\bnothing (?:wrong|of concern|material|to report|to flag|stood out)\b|\blooks (?:correct|fine|good|right|solid)\b|\bfound no\b|\bno material\b|\bLGTM\b/i;

export function isEmptyNarration(text, lens) {
  const verdicts = VERDICTS[lens];
  if (!verdicts) return false;
  if (text.length >= NARRATION_MAX_CHARS) return false;
  // A stated verdict, severity, located finding, or informal conclusion all mean
  // this is a review. Case-insensitive: "Verdict: ship" is still a verdict.
  if (verdicts.some((verdict) => new RegExp(`\\b${verdict}\\b`, "i").test(text))) return false;
  if (/\b(critical|high|medium|low)\b/i.test(text)) return false;
  if (/\b[\w.-]+\.[A-Za-z0-9]{1,10}:\d+/.test(text)) return false;
  if (CONCLUSION_SIGNAL.test(text)) return false;
  // Discard ONLY when it positively looks like an interrupted investigation.
  return UNFINISHED_SIGNAL.test(text);
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
