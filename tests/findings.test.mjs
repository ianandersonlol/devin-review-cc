import assert from "node:assert/strict";
import test from "node:test";

import {
  correlate,
  extractJson,
  normalizeReport,
  SEVERITIES,
  VERDICTS,
} from "../skills/devin-review/scripts/lib/findings.mjs";

// ── extraction ───────────────────────────────────────────────────────────────
//
// Devin cannot enforce a schema the way the Codex CLI can, so we ask firmly and
// parse forgivingly. These cover the shapes models actually return.

const REPORT = {
  verdict: "REVISE",
  summary: "Two real problems.",
  findings: [
    { severity: "high", title: "A", body: "b", file: "x.js", line_start: 1, line_end: 2,
      confidence: 0.9, grounding: "verified", recommendation: "fix" },
  ],
  next_steps: ["do the thing"],
};

test("extractJson reads a bare JSON object", () => {
  assert.deepEqual(extractJson(JSON.stringify(REPORT)), REPORT);
});

test("extractJson reads a ```json fenced block", () => {
  assert.deepEqual(extractJson("```json\n" + JSON.stringify(REPORT) + "\n```"), REPORT);
});

test("extractJson reads an unlabelled fenced block", () => {
  assert.deepEqual(extractJson("```\n" + JSON.stringify(REPORT) + "\n```"), REPORT);
});

test("extractJson survives a model that adds preamble prose", () => {
  const text = "Here is my review of the change:\n\n" + JSON.stringify(REPORT) + "\n\nHope that helps.";
  assert.deepEqual(extractJson(text), REPORT);
});

test("extractJson is not fooled by braces inside a prose body", () => {
  // A string-blind brace scanner ends the object early here and parses nothing.
  const tricky = { ...REPORT, summary: 'the literal `{"a": 1}` appears in the diff' };
  assert.deepEqual(extractJson(JSON.stringify(tricky)), tricky);
});

test("extractJson prefers the real report over an illustrative snippet", () => {
  const text = "For example:\n```json\n{\"verdict\":\"x\"}\n```\nMy actual review:\n```json\n" +
    JSON.stringify(REPORT) + "\n```";
  assert.deepEqual(extractJson(text), REPORT);
});

test("extractJson returns null for prose with no JSON at all", () => {
  assert.equal(extractJson("### HIGH something\n- **Where:** a.js\n"), null);
  assert.equal(extractJson(""), null);
});

test("extractJson ignores a JSON array at the top level", () => {
  assert.equal(extractJson("[1, 2, 3]"), null);
});

// ── normalisation ────────────────────────────────────────────────────────────

test("normalizeReport keeps a well-formed report intact", () => {
  const report = normalizeReport(REPORT, "defect");
  assert.equal(report.verdict, "REVISE");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].confidence, 0.9);
  assert.equal(report.droppedFindings, 0);
});

test("a verdict from the wrong lens is rejected rather than passed through", () => {
  assert.equal(normalizeReport({ ...REPORT, verdict: "SOUND" }, "defect").verdict, null);
  assert.equal(normalizeReport({ ...REPORT, verdict: "SOUND" }, "design").verdict, "SOUND");
});

test("one malformed finding does not discard its well-formed siblings", () => {
  // Losing four good findings to one bad sibling is the worst possible trade.
  const report = normalizeReport({
    ...REPORT,
    findings: [REPORT.findings[0], { severity: "high" }, { title: "B", body: "b2" }],
  }, "defect");
  assert.equal(report.findings.length, 2);
  assert.equal(report.droppedFindings, 1);
});

test("an unknown severity degrades to medium instead of dropping the finding", () => {
  const report = normalizeReport({
    ...REPORT, findings: [{ ...REPORT.findings[0], severity: "catastrophic" }],
  }, "defect");
  assert.equal(report.findings[0].severity, "medium");
});

test("grounding defaults to inferred, never to verified", () => {
  // A false `verified` sends the reader straight past the thing that was wrong.
  const report = normalizeReport({
    ...REPORT, findings: [{ ...REPORT.findings[0], grounding: undefined }],
  }, "defect");
  assert.equal(report.findings[0].grounding, "inferred");
});

test("absent confidence stays null rather than becoming a fabricated 0.5", () => {
  const report = normalizeReport({
    ...REPORT, findings: [{ ...REPORT.findings[0], confidence: undefined }],
  }, "defect");
  assert.equal(report.findings[0].confidence, null);
});

test("a percentage is read as one, and a slight overshoot as certainty", () => {
  // These are two different model mistakes and reading one as the other
  // inverts the answer: 1.2 read as a percentage becomes 0.012, sorting a
  // confident finding to the bottom of the report.
  const conf = (value) => normalizeReport({
    ...REPORT, findings: [{ ...REPORT.findings[0], confidence: value }],
  }, "defect").findings[0].confidence;
  assert.equal(conf(85), 0.85);
  assert.equal(conf(100), 1);
  assert.equal(conf(1.2), 1, "1.2 is an overshoot of the 0..1 scale, not 1.2%");
  assert.equal(conf(1.4), 1);
  assert.equal(conf(-2), 0);
  assert.equal(conf("0.3"), 0.3);
  assert.equal(conf(0), 0);
});

test("findings are ordered by severity then confidence, and given stable ids", () => {
  const report = normalizeReport({
    ...REPORT,
    findings: [
      { title: "low one", body: "b", severity: "low", confidence: 0.9 },
      { title: "crit", body: "b", severity: "critical", confidence: 0.2 },
      { title: "high sure", body: "b", severity: "high", confidence: 0.9 },
      { title: "high unsure", body: "b", severity: "high", confidence: 0.1 },
    ],
  }, "defect");
  assert.deepEqual(report.findings.map((f) => f.title),
    ["crit", "high sure", "high unsure", "low one"]);
  assert.deepEqual(report.findings.map((f) => f.id), [1, 2, 3, 4]);
});

test("a backwards line range is repaired, not discarded", () => {
  const report = normalizeReport({
    ...REPORT, findings: [{ ...REPORT.findings[0], line_start: 90, line_end: 12 }],
  }, "defect");
  assert.equal(report.findings[0].line_end, 90);
});

test("a finding with neither title nor body is not a finding", () => {
  const report = normalizeReport({ ...REPORT, findings: [{ severity: "high", file: "a.js" }] }, "defect");
  assert.equal(report.findings.length, 0);
  assert.equal(report.droppedFindings, 1);
});

test("an empty findings array is a valid report, not a failure", () => {
  const report = normalizeReport({ verdict: "SHIP", summary: "clean", findings: [], next_steps: [] }, "defect");
  assert.equal(report.verdict, "SHIP");
  assert.deepEqual(report.findings, []);
});

test("normalizeReport rejects non-objects", () => {
  assert.equal(normalizeReport(null, "defect"), null);
  assert.equal(normalizeReport("nope", "defect"), null);
});

test("the two lenses keep disjoint verdict vocabularies", () => {
  assert.deepEqual(VERDICTS.defect.filter((v) => VERDICTS.design.includes(v)), []);
});

// ── correlation ──────────────────────────────────────────────────────────────
//
// The mechanical half of what a panel is for. Deliberately arithmetic: a model
// deciding whether two findings "mean the same thing" would be a fourth opinion
// with no repository access.

const review = (model, findings) => ({
  model,
  report: normalizeReport({ verdict: "REVISE", summary: "", findings, next_steps: [] }, "defect"),
});

test("the same site found by two models is one corroborated cluster", () => {
  const clusters = correlate([
    review("a", [{ title: "double charge", body: "b", severity: "high", file: "billing.py", line_start: 88, line_end: 92 }]),
    review("b", [{ title: "charged twice on retry", body: "b", severity: "critical", file: "billing.py", line_start: 90, line_end: 94 }]),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].agreement, 2);
  assert.deepEqual(clusters[0].models, ["a", "b"]);
  // The cluster takes the highest severity any member assigned it.
  assert.equal(clusters[0].severity, "critical");
});

test("distant lines in one file stay separate findings", () => {
  const clusters = correlate([
    review("a", [{ title: "x", body: "b", severity: "high", file: "app.js", line_start: 10 }]),
    review("b", [{ title: "y", body: "b", severity: "high", file: "app.js", line_start: 900 }]),
  ]);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.agreement === 1));
});

test("the same line in different files is not agreement", () => {
  const clusters = correlate([
    review("a", [{ title: "x", body: "b", severity: "high", file: "a.js", line_start: 5 }]),
    review("b", [{ title: "y", body: "b", severity: "high", file: "b.js", line_start: 5 }]),
  ]);
  assert.equal(clusters.length, 2);
});

test("path spelling differences do not split a cluster", () => {
  const clusters = correlate([
    review("a", [{ title: "x", body: "b", severity: "high", file: "./src/App.js", line_start: 5, line_end: 8 }]),
    review("b", [{ title: "y", body: "b", severity: "high", file: "src/app.js", line_start: 6, line_end: 9 }]),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].agreement, 2);
});

test("one model repeating itself is not corroboration", () => {
  // Agreement counts distinct models, not findings.
  const clusters = correlate([
    review("a", [
      { title: "x", body: "b", severity: "high", file: "a.js", line_start: 5 },
      { title: "y", body: "b", severity: "low", file: "a.js", line_start: 6 },
    ]),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].agreement, 1);
  assert.equal(clusters[0].entries.length, 2);
});

test("corroborated clusters sort ahead of single-source ones", () => {
  const clusters = correlate([
    review("a", [
      { title: "solo crit", body: "b", severity: "critical", file: "solo.js", line_start: 1 },
      { title: "shared", body: "b", severity: "low", file: "shared.js", line_start: 1 },
    ]),
    review("b", [{ title: "shared too", body: "b", severity: "low", file: "shared.js", line_start: 2 }]),
  ]);
  // Agreement outranks severity: two labs on one line beats one lab shouting.
  assert.equal(clusters[0].file, "shared.js");
  assert.equal(clusters[0].agreement, 2);
});

test("a finding with no location does not crash correlation", () => {
  const clusters = correlate([review("a", [{ title: "vague", body: "b", severity: "low" }])]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].agreement, 1);
});

test("severity ordering is the documented one", () => {
  assert.deepEqual(SEVERITIES, ["critical", "high", "medium", "low"]);
});

test("adjacent but distinct bugs in one small file are NOT merged", () => {
  // Regression: a twelve-line proximity window with a drifting anchor collapsed
  // every finding in a small file into one cluster reading "2 models agree",
  // across two entirely unrelated bugs. Over-merging manufactures the exact
  // signal this tool exists to produce, so it is the unsafe direction.
  const clusters = correlate([
    review("a", [
      { title: "add subtracts", body: "b", severity: "critical", file: "calc.py", line_start: 1, line_end: 2 },
      { title: "withdraw overdrafts", body: "b", severity: "high", file: "calc.py", line_start: 4, line_end: 6 },
    ]),
    review("b", [
      { title: "add returns a-b", body: "b", severity: "critical", file: "calc.py", line_start: 1, line_end: 2 },
      { title: "withdraw allows negative", body: "b", severity: "high", file: "calc.py", line_start: 4, line_end: 6 },
    ]),
  ]);
  assert.equal(clusters.length, 2, "add and withdraw are different bugs");
  assert.ok(clusters.every((c) => c.agreement === 2), "each should be corroborated by both models");
  assert.deepEqual(clusters.map((c) => c.lineStart).sort((x, y) => x - y), [1, 4]);
});

test("far-apart citations of one bug are deliberately left unmerged", () => {
  // The acknowledged cost of the tolerance being tiny. Two models describing the
  // same bug from lines 20 apart show up as two single-source entries rather
  // than one corroborated site — an undercount, which is recoverable by reading,
  // where a fabricated "2 models agree" is not. Observed behaviour makes this
  // cheap: models reviewing the same diff anchor on the same hunk lines.
  const clusters = correlate([
    review("a", [{ title: "leak", body: "b", severity: "high", file: "a.js", line_start: 10, line_end: 12 }]),
    review("b", [{ title: "same leak", body: "b", severity: "high", file: "a.js", line_start: 30, line_end: 32 }]),
  ]);
  assert.equal(clusters.length, 2);
});

test("the same function cited one line apart still meets", () => {
  const clusters = correlate([
    review("a", [{ title: "x", body: "b", severity: "high", file: "billing.py", line_start: 88, line_end: 90 }]),
    review("b", [{ title: "y", body: "b", severity: "high", file: "billing.py", line_start: 91, line_end: 93 }]),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].agreement, 2);
});

test("absorbing a finding never widens the net for the next one", () => {
  // The anchor is fixed at the cluster's first member, so clusters cannot
  // chain-merge their way across a file.
  const clusters = correlate([
    review("a", [
      { title: "one", body: "b", severity: "high", file: "a.js", line_start: 10, line_end: 11 },
      { title: "two", body: "b", severity: "high", file: "a.js", line_start: 12, line_end: 13 },
      { title: "three", body: "b", severity: "high", file: "a.js", line_start: 15, line_end: 16 },
    ]),
  ]);
  // 10-11 and 12-13 touch; 15-16 is two clear lines past 13 and stays separate.
  assert.equal(clusters.length, 2);
});

test("a located and an unlocated finding are not claimed to be the same site", () => {
  const clusters = correlate([
    review("a", [{ title: "x", body: "b", severity: "high", file: "a.js", line_start: 5 }]),
    review("b", [{ title: "y", body: "b", severity: "high", file: "a.js" }]),
  ]);
  assert.equal(clusters.length, 2, "unknowable proximity must not become agreement");
});
