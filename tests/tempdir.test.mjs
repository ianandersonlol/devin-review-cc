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
