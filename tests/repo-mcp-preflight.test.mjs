import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MODEL_DEFAULT, PANEL_DEFAULT } from "../skills/devin-review/scripts/lib/devin.mjs";
import { run, which } from "../skills/devin-review/scripts/lib/exec.mjs";

const cli = path.resolve("skills/devin-review/scripts/devin-review.mjs");

// The mock roster is derived from the real defaults rather than hardcoded, so
// changing MODEL_DEFAULT or PANEL_DEFAULT cannot leave this fixture describing
// an account that cannot run them — which fails as "unknown model", nowhere
// near the MCP pre-flight these tests are actually about.
// Real newlines here: this string is embedded into the mock's source with
// JSON.stringify, which does the escaping.
const MOCK_ROSTER = [...new Set([MODEL_DEFAULT, ...PANEL_DEFAULT])]
  .map((id) => `Mock ${id} (mock-${id})\n  ${id}  Mock ${id}  [1M context, Free]`)
  .join("\n\n");

async function scratchRepo() {
  const git = await which("git");
  assert.ok(git, "git is required by the test suite");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devin-repo-mcp-test-"));
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    assert.equal((await run(git, args, { cwd: root })).code, 0);
  }
  await fs.writeFile(path.join(root, "tracked.txt"), "before\n");
  assert.equal((await run(git, ["add", "tracked.txt"], { cwd: root })).code, 0);
  assert.equal((await run(git, ["commit", "-qm", "base"], { cwd: root })).code, 0);
  await fs.writeFile(path.join(root, "tracked.txt"), "after\n");
  await fs.mkdir(path.join(root, ".devin"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".devin", "mcp_config.json"),
    JSON.stringify({ mcpServers: { hostile: { command: "touch", args: ["SHOULD_NOT_RUN"] } } }),
  );
  return root;
}

async function mockDevinPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-mock-bin-"));
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "models" && args[1] === "list") {
  console.log(${JSON.stringify(MOCK_ROSTER)});
  process.exit(0);
}
if (args[0] === "--help") {
  console.log("--config --prompt-file --model --permission-mode --respect-workspace-trust --export --sandbox");
  process.exit(0);
}
if (args[0] === "--version") {
  console.log("devin test");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log("Logged in\\nEmail: test@example.com\\nPlan: Test");
  process.exit(0);
}
process.exit(2);
`;
  if (process.platform === "win32") {
    await fs.writeFile(path.join(dir, "devin.js"), script);
    await fs.writeFile(path.join(dir, "devin.cmd"), '@echo off\r\nnode "%~dp0devin.js" %*\r\n');
  } else {
    await fs.writeFile(path.join(dir, "devin"), script, { mode: 0o755 });
  }
  return dir;
}

test("review refuses repo MCP startup before Devin is called", async () => {
  const root = await scratchRepo();
  try {
    const result = await run(process.execPath, [cli, "review", "--dry-run", "--uncommitted"], { cwd: root });
    assert.equal(result.code, 8);
    assert.match(result.stderr, /BLOCKED.*repository configures Devin MCP servers/is);
    assert.match(result.stderr, /\.devin\/mcp_config\.json/);
    assert.match(result.stderr, /--allow-repo-mcp/);
    assert.ok(!await fs.stat(path.join(root, "SHOULD_NOT_RUN")).then(() => true, () => false));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rescue uses the same repo MCP pre-flight", async () => {
  const root = await scratchRepo();
  try {
    const result = await run(
      process.execPath,
      [cli, "rescue", "probe", "--dry-run", "--no-context"],
      { cwd: root },
    );
    assert.equal(result.code, 8);
    assert.match(result.stderr, /BLOCKED.*MCP servers/is);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--allow-repo-mcp is an explicit override, including on dry runs", async () => {
  const root = await scratchRepo();
  const mockBin = await mockDevinPath();
  try {
    const result = await run(
      process.execPath,
      [cli, "review", "--dry-run", "--uncommitted", "--allow-repo-mcp"],
      {
        cwd: root,
        env: { ...process.env, PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /repository MCP servers enabled/i);
    assert.match(result.stderr, /dry run OK/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(mockBin, { recursive: true, force: true });
  }
});

test("status reports hook declarations that would block a session", async () => {
  const root = await scratchRepo();
  const mockBin = await mockDevinPath();
  try {
    await fs.writeFile(
      path.join(root, ".devin", "hooks.v1.json"),
      JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: "echo probe" }] }] }),
    );
    const result = await run(process.execPath, [cli, "status"], {
      cwd: root,
      env: { ...process.env, PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /repo hooks:.*hooks\.v1\.json.*SessionStart/is);
    assert.match(result.stdout, /session would be BLOCKED.*--allow-hooks/is);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(mockBin, { recursive: true, force: true });
  }
});
