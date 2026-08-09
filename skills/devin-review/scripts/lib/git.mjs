// Git plumbing: repo discovery, base-ref resolution, diff assembly.

import { promises as fs } from "node:fs";
import path from "node:path";
import { run, which } from "./exec.mjs";

const UNTRACKED_SIZE_LIMIT = 262144; // 256KB
const BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

/** A git invocation failed outright — as opposed to reporting no differences. */
export class GitError extends Error {}

export async function findGit() {
  return which("git");
}

export async function repoRoot(gitPath, cwd = process.cwd()) {
  const result = await run(gitPath, ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  return root ? path.normalize(root) : null;
}

export async function currentBranch(gitPath, cwd) {
  const result = await run(gitPath, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return result.code === 0 ? result.stdout.trim() : "?";
}

export async function refExists(gitPath, cwd, ref) {
  const result = await run(gitPath, ["rev-parse", "--verify", "--quiet", ref], { cwd });
  return result.code === 0 && result.stdout.trim() !== "";
}

/** First of origin/HEAD, origin/main, origin/master, main, master that resolves. */
export async function resolveBase(gitPath, cwd, explicit) {
  if (explicit) return (await refExists(gitPath, cwd, explicit)) ? explicit : null;
  for (const candidate of BASE_CANDIDATES) {
    if (await refExists(gitPath, cwd, candidate)) return candidate;
  }
  return null;
}

/**
 * Build the diff under review.
 *
 * Default mode ("branch") diffs the WORKING TREE against the merge-base, so
 * committed-on-this-branch and still-uncommitted work are reviewed together.
 *
 * @returns {{text: string, description: string, filesChanged: number,
 *            untrackedSkipped: string[], truncated: boolean}}
 */
export async function collectDiff({ gitPath, repoRoot: root, mode, base, paths, workDir }) {
  const pathArgs = paths.length > 0 ? ["--", ...paths] : ["--", "."];
  let text = "";
  let description = "";
  let truncated = false;

  const capture = async (args) => {
    const result = await run(gitPath, args, { cwd: root });
    if (result.overflow) truncated = true;
    // git diff exits 0 normally and 1 when invoked in a mode that signals
    // differences. Anything above that is a real failure — a corrupt index, an
    // unreadable object, a permissions problem. Returning stdout regardless
    // would report "no changes to review" and exit 0, which a user reads as
    // "my branch is clean". Silence is the one answer a review tool must never
    // give when it has actually failed.
    if (result.code > 1) {
      const detail = result.stderr.trim() || `git exited ${result.code}`;
      throw new GitError(`git ${args[0]} failed: ${detail}`);
    }
    return result.stdout ?? "";
  };

  if (mode === "staged") {
    description = "staged changes (git diff --cached)";
    text = await capture(["diff", "--cached", "--no-color", ...pathArgs]);
  } else if (mode === "uncommitted") {
    description = "uncommitted changes (git diff HEAD)";
    text = await capture(["diff", "HEAD", "--no-color", ...pathArgs]);
  } else {
    const baseRef = await resolveBase(gitPath, root, base);
    if (baseRef) {
      const mergeBaseResult = await run(gitPath, ["merge-base", baseRef, "HEAD"], { cwd: root });
      const mergeBase = mergeBaseResult.code === 0 ? mergeBaseResult.stdout.trim() : baseRef;
      description = `working tree vs ${baseRef} (merge-base ${mergeBase.slice(0, 8)})`;
      text = await capture(["diff", mergeBase, "--no-color", ...pathArgs]);
    } else {
      description = "uncommitted changes (no base branch found; vs HEAD)";
      text = await capture(["diff", "HEAD", "--no-color", ...pathArgs]);
    }
  }

  // `git diff` ignores untracked files entirely, so a brand-new file on this
  // branch would be silently excluded — and new files are where new bugs live.
  // --staged is exempt: `git diff --cached` already covers newly added files,
  // and an unstaged file is deliberately out of scope for that mode.
  const untrackedSkipped = [];
  if (mode !== "staged") {
    const listed = await run(gitPath, ["ls-files", "--others", "--exclude-standard", ...pathArgs], {
      cwd: root,
    });
    if (listed.code !== 0) {
      const detail = listed.stderr.trim() || `git exited ${listed.code}`;
      throw new GitError(`git ls-files failed: ${detail}`);
    }
    const files = listed.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    if (files.length > 0) {
      const emptyFile = path.join(workDir, "empty");
      await fs.writeFile(emptyFile, "");
      for (const relative of files) {
        const absolute = path.join(root, relative);
        let stat;
        try {
          // lstat, NOT stat: an untracked symlink pointing outside the repo
          // (`ln -s /etc/passwd notes.txt`) would otherwise be dereferenced and
          // its TARGET's contents shipped to Google. Git represents a symlink as
          // mode 120000 whose content is the link text, so that is what we send.
          stat = await fs.lstat(absolute);
        } catch {
          continue;
        }

        if (stat.isSymbolicLink()) {
          const target = await fs.readlink(absolute).catch(() => null);
          if (target === null) continue;
          const synthesized = symlinkDiff(relative, target);
          text += (text.endsWith("\n") || text === "" ? "" : "\n") + synthesized;
          continue;
        }

        if (!stat.isFile()) continue;
        if (stat.size > UNTRACKED_SIZE_LIMIT) {
          untrackedSkipped.push(`${relative} (${stat.size} bytes)`);
          continue;
        }

        const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
        const synthesized = stat.size === 0
          // git diff prints nothing when both sides are empty, so an empty new
          // file would vanish from the review. Its existence is the content.
          ? emptyFileDiff(relative, mode)
          : await diffAgainstEmpty(gitPath, root, emptyFile, absolute, relative, mode);
        if (synthesized) text += (text.endsWith("\n") || text === "" ? "" : "\n") + synthesized;
      }
    }
  }

  const filesChanged = (text.match(/^diff --git /gm) ?? []).length;
  return { text, description, filesChanged, untrackedSkipped, truncated };
}

/**
 * Produce a new-file diff for an untracked path.
 *
 * The shell version diffed against /dev/null. That is not portable: under Git
 * Bash on Windows, MSYS rewrites /dev/null on its way to git.exe and untracked
 * files silently vanished from the review. Diffing against a real empty file
 * works identically everywhere; we rewrite the headers afterwards so the model
 * sees a conventional new-file diff instead of a temp path.
 */
/**
 * Capture the entire working tree — tracked edits AND untracked files — as a
 * git tree object, without touching the user's index, working tree, or HEAD.
 *
 * This is how `rescue` reports exactly what agy changed: snapshot before,
 * snapshot after, diff the two trees. `git stash` would have mutated the
 * working tree, and comparing against HEAD would wrongly attribute the user's
 * own uncommitted work to agy.
 *
 * `indexFile` MUST live outside the repository. A scratch index placed inside
 * the worktree gets picked up by `git add -A` and shows up as a change agy
 * supposedly made.
 */
export async function snapshotTree(gitPath, root, indexFile) {
  if (!path.relative(root, indexFile).startsWith("..")) {
    throw new GitError("snapshot index must live outside the repository");
  }
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const added = await run(gitPath, ["add", "-A"], { cwd: root, env });
  if (added.code !== 0) {
    throw new GitError(`git add failed while snapshotting: ${added.stderr.trim() || added.code}`);
  }
  const written = await run(gitPath, ["write-tree"], { cwd: root, env });
  if (written.code !== 0) {
    throw new GitError(`git write-tree failed: ${written.stderr.trim() || written.code}`);
  }
  return written.stdout.trim();
}

/** Unified diff between two tree objects. */
export async function diffTrees(gitPath, root, before, after) {
  const result = await run(gitPath, ["diff", "--no-color", before, after], { cwd: root });
  if (result.code > 1) {
    throw new GitError(`git diff failed: ${result.stderr.trim() || result.code}`);
  }
  return result.stdout;
}

/** `[{status: "M", file: "src/x.js"}, …]` between two tree objects. */
export async function treeChanges(gitPath, root, before, after) {
  const result = await run(gitPath, ["diff", "--name-status", before, after], { cwd: root });
  if (result.code > 1) {
    throw new GitError(`git diff --name-status failed: ${result.stderr.trim() || result.code}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, file: rest.join(" → ") };
    });
}

function toPosix(relative) {
  return relative.split(path.sep).join("/");
}

/** A new-file diff with a header but no hunk — the file exists and is empty. */
function emptyFileDiff(relative, mode) {
  const posix = toPosix(relative);
  // e69de29 is git's hash of the empty blob.
  return `diff --git a/${posix} b/${posix}\nnew file mode ${mode}\nindex 0000000..e69de29\n`;
}

/**
 * A new symlink, rendered the way git renders one: mode 120000, content is the
 * link target. Deliberately synthesized rather than delegated to git, so the
 * link is never followed and the target's contents never enter the diff.
 */
function symlinkDiff(relative, target) {
  const posix = toPosix(relative);
  return (
    `diff --git a/${posix} b/${posix}\n` +
    `new file mode 120000\n` +
    `--- /dev/null\n` +
    `+++ b/${posix}\n` +
    `@@ -0,0 +1 @@\n` +
    `+${target}\n` +
    `\\ No newline at end of file\n`
  );
}

async function diffAgainstEmpty(gitPath, root, emptyFile, absolute, relative, mode = "100644") {
  const result = await run(
    gitPath,
    ["diff", "--no-index", "--no-color", "--", emptyFile, absolute],
    { cwd: root },
  );
  // 0 = identical (empty file), 1 = differs (the normal case). Anything else is a
  // real failure; skip the file rather than emitting a malformed hunk.
  if (result.code !== 0 && result.code !== 1) return "";
  const raw = result.stdout;
  if (!raw.trim()) return "";

  const posix = toPosix(relative);
  if (/^Binary files /m.test(raw)) {
    return `diff --git a/${posix} b/${posix}\nnew file mode ${mode}\nBinary files /dev/null and b/${posix} differ\n`;
  }

  const lines = raw.split("\n");
  const out = [];
  let seenPlusPlusPlus = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      out.push(`diff --git a/${posix} b/${posix}`);
      out.push(`new file mode ${mode}`);
    } else if (line.startsWith("new file mode ") || line.startsWith("old mode ")) {
      // Already emitted above.
    } else if (line.startsWith("index ")) {
      // Diffing against a real empty file yields `index e69de29..<new> 100644`.
      // Git's own new-file form is `index 0000000..<new>`; match it so the
      // synthesized hunk is indistinguishable from one git produced itself.
      const match = /^index [0-9a-f]+\.\.([0-9a-f]+)/.exec(line);
      out.push(match ? `index 0000000..${match[1]}` : line);
    } else if (line.startsWith("--- ") && !seenPlusPlusPlus) {
      out.push("--- /dev/null");
    } else if (line.startsWith("+++ ") && !seenPlusPlusPlus) {
      out.push(`+++ b/${posix}`);
      seenPlusPlusPlus = true;
    } else {
      out.push(line);
    }
  }
  const joined = out.join("\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}
