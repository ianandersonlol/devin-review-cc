// Turning a structured report into text.
//
// Written for an agent reader first and a human second, which mostly means
// being explicit where a person would infer. Every finding gets a stable
// address (`swe-1-7#2`) so it can be referred to without quoting it; every
// claim carries its author, its confidence, and whether the author actually
// read the code or inferred from the diff; and corroboration across models is
// stated as a fact rather than left to be noticed.

import { correlate, SEVERITIES } from "./findings.mjs";

const SEVERITY_LABEL = { critical: "CRITICAL", high: "HIGH", medium: "MEDIUM", low: "LOW" };

/** `billing.py:88-94`, or just the file when nobody gave a line. */
function clusterSite(cluster) {
  if (!cluster.lineStart) return cluster.file || "location not given";
  const range = cluster.lineEnd && cluster.lineEnd !== cluster.lineStart
    ? `${cluster.lineStart}-${cluster.lineEnd}`
    : `${cluster.lineStart}`;
  return `${cluster.file}:${range}`;
}

/** `0.8` → `conf 0.80`; absent stays absent rather than becoming a fake 0.5. */
function confidenceLabel(value) {
  return value === null || value === undefined ? "conf n/a" : `conf ${value.toFixed(2)}`;
}

function findingLines(finding, address) {
  const location = finding.file
    ? `${finding.file}${finding.line_start ? `:${finding.line_start}` : ""}${
        finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""
      }`
    : "location not given";

  const out = [
    `### ${address} ${SEVERITY_LABEL[finding.severity]} ${finding.title}`,
    `- **Where:** \`${location}\``,
    `- **Grounding:** ${finding.grounding} · ${confidenceLabel(finding.confidence)}`,
  ];
  if (finding.body) out.push(`- **Why it fails:** ${finding.body}`);
  if (finding.recommendation) out.push(`- **Fix:** ${finding.recommendation}`);
  return out;
}

/**
 * A single reviewer's report.
 *
 * `model` is included even here. A single review today is frequently pasted
 * beside another tool's output tomorrow, and an unattributed finding in a
 * council transcript is a finding nobody can weigh.
 */
export function renderReport({ report, model, lens, scope, durationSeconds }) {
  const out = [];
  out.push(`# ${lens === "design" ? "Design review" : "Code review"} — \`${model}\``);
  out.push("");
  out.push(`Scope: ${scope}${durationSeconds ? ` · ${durationSeconds}s` : ""}`);
  out.push("");

  if (report.verdict) out.push(`**Verdict: ${report.verdict}**`);
  if (report.summary) out.push("", report.summary);
  out.push("");

  if (report.findings.length === 0) {
    out.push("No findings reported.");
  } else {
    out.push(`## Findings (${summariseSeverities(report.findings)})`);
    out.push("");
    for (const finding of report.findings) {
      out.push(...findingLines(finding, `[${finding.id}]`));
      out.push("");
    }
  }

  if (report.next_steps.length > 0) {
    out.push("## Next steps");
    out.push("");
    for (const step of report.next_steps) out.push(`- ${step}`);
    out.push("");
  }

  if (report.droppedFindings > 0) {
    out.push(
      `_${report.droppedFindings} finding(s) were dropped as unreadable. Re-run with --json ` +
        "to inspect the raw output._",
      "",
    );
  }
  return out.join("\n");
}

export function summariseSeverities(findings) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const parts = SEVERITIES.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${SEVERITY_LABEL[s]}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * The panel report.
 *
 * Ordered for adjudication rather than for reading: the corroboration map comes
 * first, because "two labs independently flagged this line" and "only one model
 * saw this" are the two facts that decide what to check and in what order.
 * Everything else is evidence behind those.
 */
export function renderPanel({ results, lens, scope, warnings }) {
  // Three buckets, and every result lands in exactly one of them. An earlier
  // version had only `usable` (ok with a report) and `failed` (not ok), which
  // left ok-but-unstructured results in neither — so a model that answered in
  // prose was shown as "— (ok)" in the table and its review was then printed
  // nowhere at all. That silently discarded a review the user had paid for, and
  // contradicted interpret()'s own guarantee that unparseable output is kept.
  const usable = results.filter((r) => r.ok && r.report);
  const unstructured = results.filter((r) => r.ok && !r.report);
  const failed = results.filter((r) => !r.ok);
  const out = [];

  out.push(`# Panel review — ${results.length} model(s), ${lens} lens`);
  out.push("");
  out.push(`Scope: ${scope}`);
  out.push("");

  out.push("| Model | Verdict | Findings | Time |");
  out.push("| --- | --- | --- | --- |");
  for (const result of results) {
    if (result.ok && !result.report) {
      // Not "— (ok)", which reads as "ran fine, found nothing". There IS a
      // review below; it just could not be parsed into findings.
      out.push(`| \`${result.model}\` | unstructured | see below | ${result.durationSeconds}s |`);
      continue;
    }
    if (!result.ok) {
      out.push(`| \`${result.model}\` | — (${result.className}) | — | ${result.durationSeconds}s |`);
      continue;
    }
    out.push(
      `| \`${result.model}\` | ${result.report.verdict ?? "unstated"} | ` +
        `${summariseSeverities(result.report.findings)} | ${result.durationSeconds}s |`,
    );
  }
  out.push("");

  const verdicts = [...new Set(usable.map((r) => r.report.verdict).filter(Boolean))];
  if (verdicts.length > 1) {
    out.push(
      `**The panel disagrees** (${verdicts.join(" vs ")}). Disagreement is the most informative ` +
        "thing a panel produces: settle it against the code rather than counting votes.",
    );
    out.push("");
  }

  for (const warning of warnings ?? []) {
    out.push(`> **Note:** ${warning}`);
    out.push("");
  }

  // The corroboration map — the part that a pile of separate reviews cannot give
  // you, and the reason the findings are structured at all.
  const clusters = correlate(usable);
  const corroborated = clusters.filter((c) => c.agreement > 1);
  const solo = clusters.filter((c) => c.agreement === 1);

  if (clusters.length > 0) {
    out.push("## Where to look first");
    out.push("");
    if (unstructured.length > 0) {
      out.push(
        `_Note: ${unstructured.length} model(s) returned unparseable output and take no part ` +
          "in this map. Their reviews are printed in full below and may contain findings not " +
          "listed here._",
      );
      out.push("");
    }
    if (corroborated.length > 0) {
      out.push(`**Corroborated — ${corroborated.length} site(s) flagged by more than one model.**`);
      out.push("Independent agreement across labs is the strongest signal here.");
      out.push("");
      for (const cluster of corroborated) {
        out.push(`- \`${clusterSite(cluster)}\` ` +
          `— ${cluster.models.length} models (${cluster.models.join(", ")}), ` +
          `max severity ${SEVERITY_LABEL[cluster.severity]}`);
        for (const entry of cluster.entries) {
          out.push(`  - \`${entry.model}#${entry.finding.id}\` ${entry.finding.title}`);
        }
      }
      out.push("");
    }
    if (solo.length > 0) {
      out.push(`**Single-source — ${solo.length} site(s) flagged by exactly one model.**`);
      out.push(
        "Each is either the sharpest finding in the set or a hallucination. Check these " +
          "against real code before acting on them.",
      );
      out.push("");
      for (const cluster of solo) {
        const entry = cluster.entries[0];
        out.push(
          `- \`${entry.model}#${entry.finding.id}\` ${SEVERITY_LABEL[entry.finding.severity]} ` +
            `${entry.finding.title} (${entry.finding.grounding}, ${confidenceLabel(entry.finding.confidence)})`,
        );
      }
      out.push("");
    }
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

  for (const result of unstructured) {
    out.push("---");
    out.push("");
    out.push(renderUnstructured({
      text: result.review,
      model: result.model,
      reason: result.reason || "output did not parse as a structured report",
      durationSeconds: result.durationSeconds,
    }));
  }

  for (const result of usable) {
    out.push("---");
    out.push("");
    out.push(`## Reviewer: \`${result.model}\`  _(${result.durationSeconds}s)_`);
    out.push("");
    if (result.report.verdict) out.push(`**Verdict: ${result.report.verdict}**`);
    if (result.report.summary) out.push("", result.report.summary);
    out.push("");
    if (result.report.findings.length === 0) {
      out.push("No findings reported.");
      out.push("");
      continue;
    }
    for (const finding of result.report.findings) {
      out.push(...findingLines(finding, `[\`${result.model}#${finding.id}\`]`));
      out.push("");
    }
    if (result.report.next_steps.length > 0) {
      out.push("**Next steps:** " + result.report.next_steps.join("; "));
      out.push("");
    }
    // Disclosed per reviewer, exactly as a single report does. A panel hiding
    // what it could not read would be the same omission in a busier page.
    if (result.report.droppedFindings > 0) {
      out.push(
        `_${result.report.droppedFindings} finding(s) from this model were dropped as ` +
          "unreadable. Re-run with --json to inspect the raw output._",
        "",
      );
    }
  }

  return out.join("\n");
}

/**
 * Fallback for output that would not parse as a report.
 *
 * Nothing is ever discarded for being malformed. A review the parser could not
 * read is still a review a person or an agent can read, and silently dropping it
 * would be a far worse failure than printing it with a caveat.
 */
export function renderUnstructured({ text, model, reason, durationSeconds }) {
  return [
    `## Reviewer: \`${model}\` — unstructured${durationSeconds ? `  _(${durationSeconds}s)_` : ""}`,
    "",
    `_This model did not return a readable structured report (${reason}), so its raw output ` +
      "follows verbatim. Findings are not addressable and were not correlated._",
    "",
    text,
    "",
  ].join("\n");
}
