// Temp-directory lifecycle.
//
// The request file holds the entire diff. The shell implementation removed it
// with `trap ... EXIT HUP INT QUIT TERM`, so Ctrl+C during a review still
// cleaned up. A bare try/finally does NOT reproduce that: signal termination
// kills the process without unwinding pending promises, so interrupting a
// 60-second review would leave the full diff sitting in the temp directory.
// These handlers restore the shell version's guarantee.

import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tracked = new Set();
let installed = false;

// 128 + signal number, the conventional shell encoding.
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

function removeAllSync() {
  for (const dir of tracked) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: we are on the way out and have nowhere useful to report.
    }
    tracked.delete(dir);
  }
}

function installHandlers() {
  if (installed) return;
  installed = true;

  // Catches normal and error exits, including an uncaught throw.
  process.on("exit", removeAllSync);

  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      removeAllSync();
      // Registering a listener suppresses the default terminate-now behaviour,
      // so exit explicitly with the code the caller's shell expects.
      process.exit(code);
    });
  }
}

/** Create a tracked temp directory that is removed on every exit path. */
export async function createTempDir(prefix) {
  installHandlers();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}

/**
 * Remove a tracked temp directory early, on the normal path.
 *
 * Untracked only after the removal actually succeeds. Dropping it first and
 * swallowing the error — the obvious way to write this — means a transient
 * failure (a lock on Windows, a busy filesystem) leaves the request file, with
 * the whole diff in it, on disk AND removes the last record that anything still
 * needs cleaning up. The exit handler is the retry, so it has to still know.
 */
export async function removeTempDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
    tracked.delete(dir);
  } catch (error) {
    process.stderr.write(
      `devin-review: could not remove temp dir ${dir} (${error?.code ?? error?.message}); ` +
        "retrying at exit\n",
    );
  }
}

export const __testing = { tracked, removeAllSync };
