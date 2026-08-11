import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReport } from "../skills/devin-review/scripts/lib/findings.mjs";
import { renderPanel, renderReport, renderUnstructured } from "../skills/devin-review/scripts/lib/render.mjs";

const report = (findings, over = {}) => normalizeReport({
  verdict: "REVISE", summary: "Two problems.", findings, next_steps: ["Fix the retry."], ...over,
}, "defect");

const FINDING = {
  severity: "high", title: "Retry loop double-charges", body: "Two charges on a timeout.",
  file: "billing.py", line_start: 88, line_end: 90, confidence: 0.82,
  grounding: "verified", recommendation: "Add an idempotency key.",
};

const result = (model, findings, over = {}) => ({
  model, ok: true, durationSeconds: 10, className: "ok", report: report(findings), ...over,
});

// ── single report ────────────────────────────────────────────────────────────

test("a single report states verdict, location, grounding and confidence", () => {
  const text = renderReport({
    report: report([FINDING]), model: "swe-1-7", lens: "defect", scope: "branch", durationSeconds: 10,
  });
  assert.match(text, /\*\*Verdict: REVISE\*\*/);
  assert.match(text, /billing\.py:88-90/);
  assert.match(text, /verified/);
  assert.match(text, /conf 0\.82/);
  assert.match(text, /Add an idempotency key/);
});

test("findings are addressable by a stable id", () => {
  // The reader needs to refer to a finding without quoting it back.
  const text = renderReport({ report: report([FINDING]), model: "m", lens: "defect", scope: "s" });
  assert.match(text, /### \[1\] HIGH Retry loop double-charges/);
});

test("absent confidence renders as n/a, never as a made-up number", () => {
  const text = renderReport({
    report: report([{ ...FINDING, confidence: undefined }]), model: "m", lens: "defect", scope: "s",
  });
  assert.match(text, /conf n\/a/);
  assert.ok(!/conf 0\.50/.test(text));
});

test("a finding with no location says so rather than inventing one", () => {
  const text = renderReport({
    report: report([{ ...FINDING, file: "", line_start: null, line_end: null }]),
    model: "m", lens: "defect", scope: "s",
  });
  assert.match(text, /location not given/);
});

test("a clean report renders as no findings rather than as an empty section", () => {
  const text = renderReport({
    report: report([], { verdict: "SHIP", summary: "Looks fine." }),
    model: "m", lens: "defect", scope: "s",
  });
  assert.match(text, /No findings reported/);
  assert.match(text, /\*\*Verdict: SHIP\*\*/);
});

test("dropped findings are disclosed, not silently swallowed", () => {
  const withJunk = normalizeReport({
    verdict: "REVISE", summary: "", next_steps: [],
    findings: [FINDING, { severity: "high" }],
  }, "defect");
  const text = renderReport({ report: withJunk, model: "m", lens: "defect", scope: "s" });
  assert.match(text, /1 finding\(s\) were dropped/);
});

test("the model is named even on a single review", () => {
  // A single review today is pasted beside another tool's output tomorrow.
  const text = renderReport({ report: report([FINDING]), model: "kimi-k3-high", lens: "defect", scope: "s" });
  assert.match(text, /kimi-k3-high/);
});

// ── panel ────────────────────────────────────────────────────────────────────

test("the panel leads with a per-model comparison table", () => {
  const text = renderPanel({
    results: [result("a", [FINDING]), result("b", [FINDING])],
    lens: "defect", scope: "branch", warnings: [],
  });
  assert.match(text, /\| `a` \| REVISE \| 1 HIGH \| 10s \|/);
});

test("corroborated sites are called out with the models that found them", () => {
  const text = renderPanel({
    results: [
      result("a", [FINDING]),
      result("b", [{ ...FINDING, line_start: 91, title: "charged twice" }]),
    ],
    lens: "defect", scope: "branch", warnings: [],
  });
  assert.match(text, /Corroborated — 1 site/);
  assert.match(text, /2 models \(a, b\)/);
  assert.match(text, /`a#1`/);
  assert.match(text, /`b#1`/);
});

test("single-source findings are flagged as needing verification", () => {
  const text = renderPanel({
    results: [
      result("a", [FINDING]),
      result("b", [{ ...FINDING, file: "other.js", line_start: 3, title: "unrelated" }]),
    ],
    lens: "defect", scope: "branch", warnings: [],
  });
  assert.match(text, /Single-source — 2 site/);
  assert.match(text, /sharpest finding in the set or a hallucination/);
});

test("panel findings are addressed by model and id", () => {
  const text = renderPanel({
    results: [result("swe-1-7", [FINDING])], lens: "defect", scope: "s", warnings: [],
  });
  assert.match(text, /\[`swe-1-7#1`\] HIGH/);
});

test("disagreement between verdicts is stated explicitly", () => {
  const text = renderPanel({
    results: [
      result("a", [FINDING]),
      { ...result("b", []), report: report([], { verdict: "SHIP" }) },
    ],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.match(text, /panel disagrees.*REVISE vs SHIP/is);
});

test("a unanimous panel is not told that it disagrees", () => {
  const text = renderPanel({
    results: [result("a", [FINDING]), result("b", [FINDING])],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.ok(!/panel disagrees/i.test(text));
});

test("models that produced nothing are reported as missing data", () => {
  const text = renderPanel({
    results: [
      result("a", [FINDING]),
      { model: "b", ok: false, durationSeconds: 2, className: "quota", reason: "out of budget" },
    ],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.match(text, /out of budget/);
  assert.match(text, /not as agreement/i);
});

test("a narrowed panel says so ABOVE the findings, not only at the bottom", () => {
  // Position is the whole point, so position is what is asserted. The failure
  // detail has always been printed further down; what it could not do is stop a
  // reader taking "the other models flagged nothing here" as agreement, because
  // by the time they reached it they had already read the findings.
  const text = renderPanel({
    results: [
      result("a", [FINDING]),
      { model: "b", ok: false, durationSeconds: 2, className: "blocked_tool", reason: "tried exec" },
      { model: "c", ok: false, durationSeconds: 1, className: "quota", reason: "out of budget" },
    ],
    lens: "defect", scope: "s", warnings: [],
  });

  const notice = text.indexOf("2 of 3 model(s) returned nothing");
  assert.ok(notice > -1, `expected a count of silent models, got:\n${text.slice(0, 400)}`);
  assert.ok(notice < text.indexOf("| Model | Verdict |"), "the notice must precede the results table");
  assert.ok(notice < text.indexOf("## Where to look first"), "the notice must precede the findings");

  // Naming the models and why each one died, in the notice itself: "2 of 3
  // returned nothing" without saying which is not actionable.
  const banner = text.slice(notice, text.indexOf("| Model | Verdict |"));
  assert.match(banner, /`b` — blocked_tool/);
  assert.match(banner, /`c` — quota/);
});

test("a complete panel carries no missing-data notice at all", () => {
  const text = renderPanel({
    results: [result("a", [FINDING]), result("b", [FINDING])],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.ok(!/returned nothing/i.test(text), "a full panel must not warn about models that did run");
});

test("warnings reach the report body, not only stderr", () => {
  const text = renderPanel({
    results: [result("a", [FINDING])], lens: "defect", scope: "s",
    warnings: ["these two are siblings"],
  });
  assert.match(text, /these two are siblings/);
});

test("a model that returned unparseable text is still rendered in full", () => {
  // Discarding a review because a model got its punctuation wrong would lose
  // exactly the finding that was paid for.
  const text = renderUnstructured({
    text: "### HIGH something real\n- it is broken", model: "glm-5-2", reason: "no JSON object found",
  });
  assert.match(text, /something real/);
  assert.match(text, /unstructured/i);
  assert.match(text, /no JSON object found/);
});

test("a panel never drops an unstructured reviewer's text", () => {
  // Found by the plugin reviewing itself: ok-but-unstructured results fell
  // between `usable` and `failed`, so the review was printed nowhere at all.
  const text = renderPanel({
    results: [
      result("good", [FINDING]),
      { model: "prose", ok: true, durationSeconds: 7, className: "ok", report: null,
        format: "unstructured", review: "CRITICAL: the auth check is inverted" },
    ],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.match(text, /the auth check is inverted/);
});

test("an unstructured row is labelled as such, not as a clean 'ok'", () => {
  const text = renderPanel({
    results: [{ model: "prose", ok: true, durationSeconds: 7, className: "ok", report: null,
      review: "some prose" }],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.match(text, /\| `prose` \| unstructured \| see below \|/);
  assert.ok(!/— \(ok\)/.test(text), "'ok' with no findings reads as a clean review");
});

test("the corroboration map discloses that unstructured models sat it out", () => {
  const text = renderPanel({
    results: [
      result("good", [FINDING]),
      { model: "prose", ok: true, durationSeconds: 7, className: "ok", report: null, review: "x" },
    ],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.match(text, /take no part\s+in this map/);
});

test("a panel discloses dropped findings per reviewer, as a single report does", () => {
  const withJunk = normalizeReport({
    verdict: "REVISE", summary: "", next_steps: [], findings: [FINDING, { severity: "high" }],
  }, "defect");
  const text = renderPanel({
    results: [{ model: "m", ok: true, durationSeconds: 5, className: "ok", report: withJunk }],
    lens: "defect", scope: "s", warnings: [],
  });
  assert.match(text, /1 finding\(s\) from this model were dropped/);
});
