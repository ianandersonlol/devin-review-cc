import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scanForSecrets } from "../skills/devin-review/scripts/lib/secrets.mjs";

const diff = (...lines) => lines.join("\n");

// Every fake credential below is assembled at runtime rather than written as a
// literal. The scanner sees the identical string either way, but the SOURCE of
// this file no longer contains the shapes it is testing — so reviewing this
// repository does not block on its own test fixtures. See the matching split in
// secrets.mjs. Writing them literally is what made `/devin:review` exit 4 here.
const AWS_KEY = `AKIA${"1234567890ABCDEF"}`;
const GITHUB_TOKEN = `ghp${"_"}abcdefghijklmnopqrstuvwxyz0123`;
const STRIPE_KEY = `sk${"_live_"}abcdefghijklmnop1234`;
const SLACK_TOKEN = `xoxb${"-"}1234567890-abcdefg`;
const RSA_HEADER = `-----BEGIN RSA ${"PRIVATE KEY"}-----`;
const API_KEY_ASSIGNMENT = `api${"_key"} = 'abcdefghijklmnopqrstuvwxyz'`;

test("catches an AWS access key id on an added line", () => {
  const hits = scanForSecrets(diff(`+const key = '${AWS_KEY}';`));
  assert.equal(hits.length, 1);
});

test("catches assorted provider token shapes", () => {
  const samples = [GITHUB_TOKEN, STRIPE_KEY, SLACK_TOKEN, RSA_HEADER, API_KEY_ASSIGNMENT];
  for (const sample of samples) {
    assert.equal(scanForSecrets(diff(`+${sample}`)).length, 1, `should match: ${sample}`);
  }
});

test("ignores secrets on removed and context lines", () => {
  // Deleting a secret is not us transmitting a new one, and matching context
  // would fire on every diff that merely sits near a config block.
  assert.deepEqual(scanForSecrets(diff(`-const key = '${AWS_KEY}';`)), []);
  assert.deepEqual(scanForSecrets(diff(` const key = '${AWS_KEY}';`)), []);
});

test("a file path is not mistaken for a credential", () => {
  // The shell implementation matched `+++ b/...` header lines, so a path like
  // this could block a review on its own name.
  const hits = scanForSecrets(diff("+++ b/src/auth/api_key_configuration_helper.ts"));
  assert.deepEqual(hits, []);
});

test("returns 1-based line numbers into the diff", () => {
  const hits = scanForSecrets(diff("+safe", "+also safe", `+${AWS_KEY}`));
  assert.equal(hits[0].line, 3);
});

test("caps the number of reported hits", () => {
  const many = Array.from({ length: 20 }, () => `+${AWS_KEY}`).join("\n");
  assert.equal(scanForSecrets(many).length, 5);
  assert.equal(scanForSecrets(many, 2).length, 2);
});

test("truncates long matches so the report stays readable", () => {
  const hits = scanForSecrets(`+${AWS_KEY}${"x".repeat(500)}`);
  assert.ok(hits[0].text.length <= 160);
});

test("the scanner's own source does not trip the scanner", async () => {
  // The pattern list contains credential prefixes as literals. If they match
  // verbatim, every review of this repository blocks on the scanner itself.
  const source = await readFile(
    new URL("../skills/devin-review/scripts/lib/secrets.mjs", import.meta.url),
    "utf8",
  );
  const asAddedLines = source
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  assert.deepEqual(scanForSecrets(asAddedLines), []);
});

test("a clean diff produces no hits", () => {
  assert.deepEqual(scanForSecrets(diff("+function add(a, b) {", "+  return a + b;", "+}")), []);
});
