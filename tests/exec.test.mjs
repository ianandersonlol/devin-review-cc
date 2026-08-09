import assert from "node:assert/strict";
import test from "node:test";

import { run, which } from "../skills/devin-review/scripts/lib/exec.mjs";

const NODE = process.execPath;

test("which resolves a command on PATH to an absolute path", async () => {
  // Spawning the resolved path rather than a bare name is what makes this work
  // on Windows, where shell:false does not apply PATHEXT.
  const found = await which("git");
  if (found) assert.ok(found.length > "git".length, "should be a full path");
});

test("which returns null for a command that does not exist", async () => {
  assert.equal(await which("definitely-not-a-real-binary-xyzzy"), null);
});

test("run captures stdout and a zero exit", async () => {
  const result = await run(NODE, ["-e", "process.stdout.write('hello')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hello");
});

test("run reports a non-zero exit without throwing", async () => {
  // git diff --no-index exits 1 for "files differ", which is success for us.
  const result = await run(NODE, ["-e", "process.exit(3)"]);
  assert.equal(result.code, 3);
});

test("run separates stderr from stdout", async () => {
  const result = await run(NODE, ["-e", "process.stdout.write('out');process.stderr.write('err')"]);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("stdin is closed so a child waiting on it cannot hang", async () => {
  // This is the bug that made `devin models list` look like a broken install: execFile
  // leaves stdin open, the CLI waited for EOF, and the timeout killed it.
  const result = await run(NODE, [
    "-e",
    "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>{process.stdout.write('eof:'+n)})",
  ], { timeout: 5000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "eof:0");
  assert.notEqual(result.timedOut, true);
});

test("a signal-killed child never reports success", async () => {
  // `code ?? 0` would turn a timeout into an apparent clean run.
  const result = await run(NODE, ["-e", "setTimeout(()=>{}, 60000)"], { timeout: 300 });
  assert.notEqual(result.code, 0, "a killed process must not look successful");
  assert.equal(result.timedOut, true);
  assert.ok(result.signal, "the signal should be surfaced");
});

test("a missing binary is reported, not thrown", async () => {
  const result = await run("definitely-not-a-real-binary-xyzzy", []);
  assert.equal(result.notFound, true);
  assert.notEqual(result.code, 0);
});

test("output past the buffer limit sets overflow instead of growing forever", async () => {
  // One large write against a small limit, so the threshold is crossed by the
  // first chunk. Dribbling it out in a loop made this sensitive to scheduling
  // under a loaded test run.
  const result = await run(NODE, ["-e", "process.stdout.write('x'.repeat(65536))"], {
    maxBuffer: 1024,
  });
  assert.notEqual(result.notFound, true, "the child should have started");
  assert.equal(result.overflow, true);
});

test("cwd is honoured", async () => {
  const result = await run(NODE, ["-e", "process.stdout.write(process.cwd())"], {
    cwd: process.cwd(),
  });
  assert.ok(result.stdout.length > 0);
});

test("arguments are passed literally, never through a shell", async () => {
  // shell:false is the whole reason a focus string or path cannot inject.
  const nasty = "; rm -rf /; $(whoami) `id` && echo pwned";
  const result = await run(NODE, ["-e", "process.stdout.write(process.argv[1])", nasty]);
  assert.equal(result.stdout, nasty);
});
