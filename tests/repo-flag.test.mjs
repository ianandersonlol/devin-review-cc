// --repo: naming the repository when the host's cwd is not it.
//
// Claude Code runs plugin commands from the user's working directory, so cwd is
// the repository and none of this matters there. Antigravity runs every shell
// command from ~/.gemini/antigravity-cli/scratch no matter which workspace is
// open, and exposes the workspace path in no environment variable — so without
// an explicit flag the tool looks for a repo in a directory that never is one.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, UsageError } from "../skills/devin-review/scripts/lib/args.mjs";
import { run, which } from "../skills/devin-review/scripts/lib/exec.mjs";

const cli = path.resolve("skills/devin-review/scripts/devin-review.mjs");

/** A throwaway repo with one uncommitted change, so there is a diff to preview. */
async function scratchRepo() {
  const git = await which("git");
  assert.ok(git, "git is required by the test suite");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devin-repo-flag-test-"));
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
  return root;
}

/** A directory that is emphatically not a git repository. */
async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "devin-repo-flag-elsewhere-"));
}

test("--repo captures a path and defaults to empty", () => {
  assert.equal(parseArgs([]).repo, "");
  assert.equal(parseArgs(["review", "--repo", "/tmp/x"]).repo, "/tmp/x");
  assert.equal(parseArgs(["rescue", "it broke", "--repo", "/tmp/x"]).repo, "/tmp/x");
});

test("--repo requires a value", () => {
  assert.throws(() => parseArgs(["--repo"]), UsageError);
});

test("--repo reviews that repo from a cwd that is not one", async () => {
  const root = await scratchRepo();
  const elsewhere = await scratchDir();
  try {
    const result = await run(
      process.execPath,
      [cli, "review", "--dry-run", "--uncommitted", "--repo", root],
      { cwd: elsewhere },
    );
    assert.equal(result.code, 0, result.stderr);
    // It has to have found the real repo, not the cwd it was started in: the
    // one uncommitted change is the proof, since the cwd has no diff at all.
    assert.match(result.stderr, /files=1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("without --repo, a non-repo cwd still says to cd", async () => {
  const elsewhere = await scratchDir();
  try {
    const result = await run(process.execPath, [cli, "review", "--dry-run"], { cwd: elsewhere });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not inside a git repository/);
    assert.match(result.stderr, /cd into your project/);
  } finally {
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("under Antigravity the same failure names --repo instead of cd", async () => {
  const elsewhere = await scratchDir();
  try {
    const result = await run(process.execPath, [cli, "review", "--dry-run"], {
      cwd: elsewhere,
      env: { ...process.env, ANTIGRAVITY_AGENT: "1" },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--repo/);
    // "cd into your project" is advice that cannot work under this host, so it
    // must not be what the agent is told to try.
    assert.doesNotMatch(result.stderr, /cd into your project/);
  } finally {
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("a --repo that is not a repository says so, rather than blaming the cwd", async () => {
  const elsewhere = await scratchDir();
  try {
    const result = await run(
      process.execPath,
      [cli, "review", "--dry-run", "--repo", elsewhere],
      { cwd: elsewhere },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--repo/);
    assert.match(result.stderr, /does not resolve/);
  } finally {
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("rescue honours --repo too, since it is the one that writes", async () => {
  const root = await scratchRepo();
  const elsewhere = await scratchDir();
  try {
    const result = await run(
      process.execPath,
      [cli, "rescue", "probe", "--dry-run", "--no-context", "--repo", root],
      { cwd: elsewhere },
    );
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});
