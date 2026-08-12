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

/**
 * Keep a tracked temp directory past process exit, deliberately.
 *
 * Exists for failed runs. When a model times out or loses its turn to a denied
 * tool, the exported transcript in the work dir is the only record of what it
 * was doing — deleting it on the way out converts "what was swe-1-7 doing for
 * 15 minutes" from a question with an answer into one without. Untracking is
 * all it takes: the exit and signal handlers only remove what is tracked.
 *
 * The kept directory is not immortal: it contains the full diff, so it still
 * gets removed by sweepStaleTempDirs once it is a day old.
 */
export function preserveTempDir(dir) {
  tracked.delete(dir);
}

/** The exact shape mkdtemp gives our work dirs: our prefix plus six randoms. */
const STALE_PATTERN = /^devin-(review|rescue|status)-[A-Za-z0-9]{6}$/;

/**
 * Remove work dirs that earlier processes left behind.
 *
 * The exit handlers cannot run on SIGKILL or a machine crash, so hard-killed
 * runs leak their directories. This sweeps them on the next start instead.
 * Age-gated a day rather than swept unconditionally, because the pattern alone
 * cannot distinguish a leak from a CONCURRENT run's live work dir — deleting
 * another process's request file mid-review would be far worse than the litter
 * — or from a directory deliberately kept for inspection minutes ago.
 *
 * What actually keeps a live run safe is the FRESHNESS of its contents, not a
 * bet on how long a run lasts. The default 45m timeout already bounds an
 * ordinary run to well under a day, but `--timeout none` removes that bound, so
 * the gate cannot lean on it. So the age is the newest mtime of the directory
 * AND its immediate children (a panel reviewer caught that a directory's own
 * mtime does not advance when a file inside it is rewritten): a review that
 * keeps re-exporting its transcript stays fresh and is never swept, however long
 * it runs. The 24h gate is then just a generous backstop for a dir whose
 * contents have genuinely stopped changing.
 *
 * The residual gap — a `--timeout none` run in a single very long turn that
 * never re-exports, running past a day, swept by a concurrent invocation — is
 * reachable only in principle: Devin exports at every turn boundary and has its
 * own run limits, and the default timeout rules it out entirely. A cross-process
 * lease would be a large mechanism for a case that does not occur; this is an
 * honest heuristic, not a guarantee, and lowering maxAgeMs is the lever if a
 * real run ever gets close.
 *
 * Entirely best-effort: every failure is swallowed, because refusing to review
 * code over a tidying problem would invert the priorities.
 */
export async function sweepStaleTempDirs(maxAgeMs = 24 * 60 * 60 * 1000) {
  const base = os.tmpdir();
  let entries;
  try {
    entries = await fs.readdir(base);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!STALE_PATTERN.test(entry)) continue;
    const dir = path.join(base, entry);
    if (tracked.has(dir)) continue; // ours, and live
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;

      let newest = stat.mtimeMs;
      try {
        for (const child of await fs.readdir(dir)) {
          const childStat = await fs.stat(path.join(dir, child));
          if (childStat.mtimeMs > newest) newest = childStat.mtimeMs;
        }
      } catch {
        // Cannot enumerate the contents; fall back to the directory's own mtime.
      }
      if (newest > cutoff) continue; // touched recently — assume a live run.

      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Racing another sweep, or a permission oddity: someone else's problem.
    }
  }
  return removed;
}

export const __testing = { tracked, removeAllSync };
