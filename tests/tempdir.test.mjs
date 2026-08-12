import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createTempDir, removeTempDir } from "../skills/devin-review/scripts/lib/tempdir.mjs";

const execFileAsync = promisify(execFile);
const TEMPDIR_MODULE = fileURLToPath(
  new URL("../skills/devin-review/scripts/lib/tempdir.mjs", import.meta.url),
);

test("createTempDir returns a real, writable directory", async () => {
  const dir = await createTempDir("devin-test-");
  try {
    const stat = await fs.stat(dir);
    assert.ok(stat.isDirectory());
    await fs.writeFile(path.join(dir, "x"), "data");
  } finally {
    await removeTempDir(dir);
  }
});

test("removeTempDir deletes the directory and its contents", async () => {
  const dir = await createTempDir("devin-test-");
  await fs.writeFile(path.join(dir, "secret.diff"), "sensitive");
  await removeTempDir(dir);
  await assert.rejects(() => fs.stat(dir));
});

test("the directory is removed when the process exits normally", async () => {
  // The whole point of the module: the diff must not outlive the process.
  const { stdout } = await execFileAsync(process.execPath, [
    "-e",
    `import(${JSON.stringify(TEMPDIR_MODULE)}).then(async (m) => {
       const dir = await m.createTempDir("devin-exit-");
       process.stdout.write(dir);
     });`,
  ]);
  const dir = stdout.trim();
  assert.ok(dir.length > 0);
  await assert.rejects(() => fs.stat(dir), "temp dir should not survive the process");
});

test("the directory is removed when the process is interrupted", { skip: process.platform === "win32" ? "POSIX signals" : false }, async () => {
  // The regression this module exists to prevent: a try/finally does not run on
  // signal termination, so Ctrl+C during a review left the full diff on disk.
  const child = execFile(process.execPath, [
    "-e",
    `import(${JSON.stringify(TEMPDIR_MODULE)}).then(async (m) => {
       const dir = await m.createTempDir("devin-signal-");
       process.stdout.write(dir + "\\n");
       setTimeout(() => {}, 30000);
     });`,
  ]);

  const dir = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) resolve(buffer.trim());
    });
    child.on("error", reject);
  });

  assert.ok((await fs.stat(dir)).isDirectory(), "should exist before the signal");

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.kill("SIGINT");
  });

  await assert.rejects(() => fs.stat(dir), "temp dir must not survive SIGINT");
  assert.equal(exitCode, 130, "SIGINT should exit 130, the conventional encoding");
});

test("removing an already-removed directory is not an error", async () => {
  const dir = await createTempDir("devin-test-");
  await removeTempDir(dir);
  await removeTempDir(dir);
});

// ── keeping evidence, and sweeping what nobody kept on purpose ───────────────

import os from "node:os";
import { preserveTempDir, sweepStaleTempDirs, __testing } from "../skills/devin-review/scripts/lib/tempdir.mjs";

test("a preserved directory survives the exit handlers", async () => {
  const dir = await createTempDir("devin-review-");
  try {
    preserveTempDir(dir);
    __testing.removeAllSync();
    assert.ok((await fs.stat(dir)).isDirectory(), "preserve must untrack before the handlers run");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the sweep removes only day-old dirs matching our exact pattern", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  // A leaked dir from a hard-killed run: our prefix, our mkdtemp shape, old —
  // and its CONTENTS are old too, which is what makes it look dead. The sweep
  // reads the newest child mtime, so the file has to be aged as well as the dir.
  const stale = await fs.mkdtemp(path.join(os.tmpdir(), "devin-review-"));
  const staleFile = path.join(stale, "session-config.json");
  await fs.writeFile(staleFile, "{}");
  await fs.utimes(staleFile, twoDaysAgo, twoDaysAgo);
  await fs.utimes(stale, twoDaysAgo, twoDaysAgo);

  // A live run from a CONCURRENT process: same shape, but fresh.
  const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "devin-rescue-"));

  // An old dir that is NOT ours: the pattern must not reach it.
  const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "devin-review-not-ours-"));
  await fs.utimes(foreign, twoDaysAgo, twoDaysAgo);

  try {
    await sweepStaleTempDirs();
    await assert.rejects(() => fs.stat(stale), "the leaked dir should be swept");
    assert.ok((await fs.stat(fresh)).isDirectory(), "a fresh dir may belong to a live run");
    assert.ok((await fs.stat(foreign)).isDirectory(), "an unrecognised name is not ours to delete");
  } finally {
    for (const dir of [stale, fresh, foreign]) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the sweep never touches a dir tracked by THIS process, however old", async () => {
  const dir = await createTempDir("devin-review-");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fs.utimes(dir, twoDaysAgo, twoDaysAgo);
  try {
    await sweepStaleTempDirs();
    assert.ok((await fs.stat(dir)).isDirectory(), "a tracked dir is live by definition");
  } finally {
    await removeTempDir(dir);
  }
});

test("a long run whose transcript is fresh survives even with an old dir mtime", async () => {
  // The race a panel reviewer (GPT) flagged: directory mtime does not advance
  // when a transcript inside it is re-exported, so a multi-hour review looked
  // idle by the dir alone and could be swept by a concurrent invocation. The
  // sweep reads the newest CHILD mtime to avoid exactly this.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-review-"));
  await fs.utimes(dir, twoDaysAgo, twoDaysAgo); // old dir mtime…
  await fs.writeFile(path.join(dir, "transcript-swe-1-7.json"), "{}"); // …fresh child
  try {
    await sweepStaleTempDirs();
    assert.ok((await fs.stat(dir)).isDirectory(), "a dir with a recently-written child is a live run");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
