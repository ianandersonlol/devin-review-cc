// The findings contract: one schema, defensively parsed.
//
// The primary consumer of this tool is an agent that will read the reviews and
// adjudicate them, not a person skimming a terminal. That inverts the usual
// priority: the structured report is the source of truth and the markdown is a
// rendering of it, so that filtering, deduplication and cross-model correlation
// operate on real fields instead of on regexes over prose.
//
// Modelled on the Codex plugin's review schema, including the part it gets
// right and which is easy to miss: only the *envelope* is structured. `body`
// and `recommendation` are free-form prose with no shape imposed on them, so
// the reasoning is never squeezed into a schema — only the metadata you want to
// sort, filter and correlate on.

export const SEVERITIES = ["critical", "high", "medium", "low"];
export const GROUNDINGS = ["verified", "inferred"];

/**
 * Verdicts stay lens-specific and three-valued rather than collapsing to the
 * Codex plugin's approve/needs-attention.
 *
 * "This has bugs in it" and "this is the wrong approach" call for different
 * responses from whoever reads the report, and a binary flag cannot carry that
 * difference. The vocabularies remain disjoint so a transcript holding both
 * passes can never blur which one reached which conclusion. What actually
 * needed fixing was that the verdict was scraped out of prose with a regex;
 * it is now an enum in the schema.
 */
export const VERDICTS = {
  defect: ["SHIP", "REVISE", "RETHINK"],
  design: ["SOUND", "RECONSIDER", "WRONG-SHAPE"],
};

/** The schema shown to the model, and the shape everything downstream expects. */
export function schemaFor(lens) {
  return {
    verdict: VERDICTS[lens],
    summary: "string",
    findings: [{
      severity: SEVERITIES,
      title: "string",
      body: "string",
      file: "string",
      line_start: "integer",
      line_end: "integer",
      confidence: "number 0..1",
      grounding: GROUNDINGS,
      recommendation: "string",
    }],
    next_steps: ["string"],
  };
}

/**
 * Pull a JSON object out of model output.
 *
 * Devin has no schema-enforced output mode, so unlike the Codex plugin we cannot
 * make the model return valid JSON — we can only ask, and then be good at
 * reading whatever comes back. In practice models wrap it in a ```json fence,
 * emit it bare, or prepend a sentence of preamble, so all three are handled.
 */
export function extractJson(text) {
  if (!text) return null;

  // Prefer a fenced block: it is the least ambiguous signal, and picking the
  // longest guards against a model illustrating a snippet before the real one.
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const candidate of fences) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }

  // Otherwise scan for a balanced top-level object, string-aware so a brace
  // inside a prose body cannot end the scan early.
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const slice = balancedObject(text, i);
    if (!slice) continue;
    const parsed = tryParse(slice);
    if (parsed) return parsed;
  }
  return null;
}

function tryParse(candidate) {
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function balancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Coerce a raw parsed object into the report shape.
 *
 * Deliberately lenient about everything except the parts that carry meaning. A
 * finding missing a line number is still a finding worth reading; a "finding"
 * with no title or body is noise. Individual bad findings are dropped and
 * counted rather than failing the whole report, because losing four good
 * findings to one malformed sibling is the worst possible trade.
 */
export function normalizeReport(raw, lens) {
  if (!raw || typeof raw !== "object") return null;

  const allowed = VERDICTS[lens] ?? [];
  const verdictRaw = typeof raw.verdict === "string" ? raw.verdict.trim().toUpperCase() : "";
  const verdict = allowed.includes(verdictRaw) ? verdictRaw : null;

  const rawFindings = Array.isArray(raw.findings) ? raw.findings : [];
  const findings = [];
  let dropped = 0;
  for (const candidate of rawFindings) {
    const finding = normalizeFinding(candidate);
    if (finding) findings.push(finding);
    else dropped += 1;
  }

  // Severity order first, then confidence: what an adjudicator should look at
  // first is the most consequential claim its author is most sure of.
  findings.sort((a, b) => {
    const bySeverity = SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
    return bySeverity !== 0 ? bySeverity : (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  findings.forEach((finding, index) => {
    finding.id = index + 1;
  });

  return {
    verdict,
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    findings,
    next_steps: Array.isArray(raw.next_steps)
      ? raw.next_steps.filter((step) => typeof step === "string" && step.trim()).map((s) => s.trim())
      : [],
    droppedFindings: dropped,
  };
}

function normalizeFinding(raw) {
  if (!raw || typeof raw !== "object") return null;

  const title = str(raw.title);
  const body = str(raw.body);
  // A claim with no statement of what it is, or no argument for it, is not a
  // finding — it is a heading. Everything else can be missing.
  if (!title && !body) return null;

  const severityRaw = str(raw.severity).toLowerCase();
  const severity = SEVERITIES.includes(severityRaw) ? severityRaw : "medium";

  const groundingRaw = str(raw.grounding).toLowerCase();
  const grounding = GROUNDINGS.includes(groundingRaw) ? groundingRaw : "inferred";

  const lineStart = int(raw.line_start);
  const lineEnd = int(raw.line_end);

  return {
    severity,
    title: title || body.slice(0, 80),
    body,
    file: str(raw.file),
    line_start: lineStart,
    // A backwards range is a model slip, not a reason to discard the finding.
    line_end: lineEnd !== null && lineStart !== null && lineEnd < lineStart ? lineStart : lineEnd,
    confidence: confidence(raw.confidence),
    grounding,
    recommendation: str(raw.recommendation),
  };
}

const str = (value) => (typeof value === "string" ? value.trim() : "");

const int = (value) => {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
};

/**
 * Clamp confidence into 0..1, accepting the several ways models express it.
 *
 * Returns null rather than a default when it is absent: an adjudicator reading
 * "0.5" cannot tell a genuine coin-flip from a field the model never filled in,
 * and inventing the number would erase exactly the distinction it needs.
 */
function confidence(value) {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(number)) return null;
  if (number <= 1) return Math.max(0, number);

  // Above 1 there are two different mistakes to tell apart, and reading one as
  // the other inverts the answer. "85" is a percentage. "1.2" is a model
  // overshooting the 0..1 scale it was asked for — reading THAT as a percentage
  // turns near-certainty into 0.012, which would sort a confident finding to
  // the bottom of the report. Nothing reports a finding it is 1.2% sure of, so
  // the small overshoot is the slip and the large value is the percentage.
  if (number >= 2 && number <= 100) return number / 100;
  return 1;
}

/**
 * Group findings from different reviewers that are talking about the same thing.
 *
 * This is the mechanical half of what a panel is for. Two reviewers from
 * different labs independently landing on the same line is the strongest signal
 * the whole exercise produces, and previously you could only spot it by reading
 * three reviews side by side and noticing.
 *
 * Deliberately arithmetic rather than semantic: same file, overlapping or
 * touching line ranges. A model deciding whether two findings "mean the same
 * thing" would be a fourth opinion with no repository access, which is precisely
 * what this design refuses to introduce.
 *
 * The tolerance is deliberately tiny, and the direction of error matters more
 * than the accuracy. Under-merging splits one bug into two entries: mildly
 * annoying, self-correcting the moment a human reads both. Over-merging
 * *manufactures the appearance of independent agreement*, which is the single
 * signal this whole tool exists to produce — so a heuristic that errs that way
 * is worse than no heuristic at all.
 *
 * An earlier version used a twelve-line window and let each cluster's anchor
 * drift to the minimum line it had absorbed. On a small file that chain-merged
 * every finding in the repository into one cluster reading "2 models agree",
 * over two entirely unrelated bugs. Hence: ranges, not start lines; a one-line
 * tolerance so that a function cited at :88 and at :89 still meets; and an
 * anchor fixed at the cluster's first member so absorbing one finding can never
 * widen the net for the next.
 */
const TOUCH_TOLERANCE = 1;

export function correlate(reviews) {
  const clusters = [];

  for (const review of reviews) {
    for (const finding of review.report?.findings ?? []) {
      const entry = { model: review.model, finding };
      const home = clusters.find((cluster) => sameSite(cluster, finding));
      if (home) {
        home.entries.push(entry);
      } else {
        clusters.push({
          file: finding.file,
          lineStart: finding.line_start ?? null,
          lineEnd: finding.line_end ?? finding.line_start ?? null,
          entries: [entry],
        });
      }
    }
  }

  for (const cluster of clusters) {
    cluster.models = [...new Set(cluster.entries.map((entry) => entry.model))];
    cluster.agreement = cluster.models.length;
    cluster.severity = cluster.entries
      .map((entry) => entry.finding.severity)
      .sort((a, b) => SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b))[0];
  }

  // Corroborated first, then by severity: an adjudicator's reading order.
  clusters.sort((a, b) => {
    if (b.agreement !== a.agreement) return b.agreement - a.agreement;
    return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
  });
  return clusters;
}

function sameSite(cluster, finding) {
  if (!cluster.file || !finding.file) return false;
  if (normalizePath(cluster.file) !== normalizePath(finding.file)) return false;

  const hasClusterLines = cluster.lineStart !== null;
  const hasFindingLines = finding.line_start !== null;
  // Two unlocated findings in one file are as close as they can be shown to be.
  if (!hasClusterLines && !hasFindingLines) return true;
  // One located and one not is unknowable. Claiming they are the same site
  // would be inventing the agreement, so they stay apart.
  if (!hasClusterLines || !hasFindingLines) return false;

  const findingEnd = finding.line_end ?? finding.line_start;
  const gap = Math.max(cluster.lineStart - findingEnd, finding.line_start - cluster.lineEnd);
  return gap <= TOUCH_TOLERANCE;
}

function normalizePath(file) {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
