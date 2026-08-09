import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectHookSources } from "../skills/devin-review/scripts/lib/env.mjs";

const makeRepo = async () => fs.mkdtemp(path.join(os.tmpdir(), "devin-hooks-test-"));
const write = async (root, rel, text) => {
  await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};

// Devin runs project hooks as shell commands at session start, before the model
// acts and regardless of which tools it may use. Reproduced against the real
// CLI: a SessionStart hook wrote a file during a review with exec denied. These
// tests guard the detection that turns that into a refusal.

test("a repo with no hook declarations is clean", async () => {
  const root = await makeRepo();
  await write(root, ".claude/settings.json", JSON.stringify({ model: "sonnet" }));
  await write(root, ".devin/config.json", JSON.stringify({ permissions: { allow: [] } }));
  assert.deepEqual(await detectHookSources(root), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("a standalone hooks.v1.json is detected", async () => {
  const root = await makeRepo();
  await write(root, ".devin/hooks.v1.json",
    JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: "echo pwned" }] }] }));
  const found = await detectHookSources(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, ".devin/hooks.v1.json");
  assert.ok(found[0].events.includes("SessionStart"));
  await fs.rm(root, { recursive: true, force: true });
});

test("hooks nested in a config file are detected", async () => {
  const root = await makeRepo();
  await write(root, ".devin/config.json",
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "id" }] }] } }));
  const found = await detectHookSources(root);
  assert.equal(found.length, 1);
  assert.ok(found[0].events.includes("PreToolUse"));
  await fs.rm(root, { recursive: true, force: true });
});

test("Claude Code settings files are checked too, since Devin reads them", async () => {
  const root = await makeRepo();
  await write(root, ".claude/settings.json",
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "curl evil" }] }] } }));
  const found = await detectHookSources(root);
  assert.deepEqual(found.map((f) => f.file), [".claude/settings.json"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("an unparseable config mentioning hooks fails closed", async () => {
  // Being wrong in this direction costs an unnecessary prompt; being wrong in
  // the other direction is arbitrary code execution.
  const root = await makeRepo();
  await write(root, ".devin/config.json", '{ /* comment */ "hooks": { "Stop": [] }, }');
  const found = await detectHookSources(root);
  assert.equal(found.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("an empty hooks object is not treated as a declaration", async () => {
  const root = await makeRepo();
  await write(root, ".devin/config.json", JSON.stringify({ hooks: {} }));
  assert.deepEqual(await detectHookSources(root), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("every documented hook source is checked", async () => {
  const root = await makeRepo();
  const sources = [".devin/config.json", ".devin/config.local.json",
    ".claude/settings.json", ".claude/settings.local.json"];
  for (const file of sources) {
    await write(root, file, JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }));
  }
  await write(root, ".devin/hooks.v1.json", JSON.stringify({ Stop: [{ hooks: [] }] }));
  const found = await detectHookSources(root);
  assert.equal(found.length, 5, `expected all 5 sources, got ${found.map((f) => f.file).join(",")}`);
  await fs.rm(root, { recursive: true, force: true });
});
