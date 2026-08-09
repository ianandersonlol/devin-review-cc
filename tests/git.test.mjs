import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run, which } from "../skills/devin-review/scripts/lib/exec.mjs";
import {
  collectDiff,
  GitError,
  refExists,
  repoRoot,
  resolveBase,
} from "../skills/devin-review/scripts/lib/git.mjs";

const gitPath = await which("git");
const skip = gitPath ? false : "git is not installed";

/** Build a throwaway repo with one commit on main. */
async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-git-test-"));
  const real = await fs.realpath(dir);
  const git = (...args) => run(gitPath, args, { cwd: real });
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(real, "tracked.txt"), "original\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  return { dir: real, git };
}

async function workDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "devin-git-work-"));
}

const cleanup = async (...dirs) => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
};

test("repoRoot finds the top level", { skip }, async () => {
  const { dir } = await makeRepo();
  try {
    const nested = path.join(dir, "a", "b");
    await fs.mkdir(nested, { recursive: true });
    assert.equal(await repoRoot(gitPath, nested), dir);
  } finally {
    await cleanup(dir);
  }
});

test("repoRoot returns null outside a repository", { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-not-a-repo-"));
  try {
    assert.equal(await repoRoot(gitPath, dir), null);
  } finally {
    await cleanup(dir);
  }
});

test("refExists distinguishes real refs from typos", { skip }, async () => {
  const { dir } = await makeRepo();
  try {
    assert.equal(await refExists(gitPath, dir, "main"), true);
    assert.equal(await refExists(gitPath, dir, "no-such-ref"), false);
  } finally {
    await cleanup(dir);
  }
});

test("resolveBase honours an explicit ref and rejects a bad one", { skip }, async () => {
  const { dir } = await makeRepo();
  try {
    assert.equal(await resolveBase(gitPath, dir, "main"), "main");
    assert.equal(await resolveBase(gitPath, dir, "nope"), null);
  } finally {
    await cleanup(dir);
  }
});

test("resolveBase falls back through the candidate list", { skip }, async () => {
  const { dir } = await makeRepo();
  try {
    // No origin/* in a fresh local repo, so it should land on main.
    assert.equal(await resolveBase(gitPath, dir, ""), "main");
  } finally {
    await cleanup(dir);
  }
});

test("untracked files are included as new-file diffs", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.writeFile(path.join(dir, "brand-new.js"), "export const x = 1;\n");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: [], workDir: work,
    });
    assert.ok(diff.text.includes("diff --git a/brand-new.js b/brand-new.js"));
    assert.ok(diff.text.includes("new file mode 100644"));
    assert.ok(diff.text.includes("--- /dev/null"));
    assert.ok(diff.text.includes("+++ b/brand-new.js"));
    assert.ok(diff.text.includes("+export const x = 1;"));
    assert.equal(diff.filesChanged, 1);
  } finally {
    await cleanup(dir, work);
  }
});

test("no temp path leaks into a synthesized new-file diff", { skip }, async () => {
  // Untracked files are diffed against a real empty file rather than /dev/null,
  // because MSYS mangles /dev/null on the way to git.exe. The headers are
  // rewritten afterwards; if that rewrite regressed, the model would see a
  // meaningless absolute temp path as the original filename.
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.writeFile(path.join(dir, "new.txt"), "hello\n");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: [], workDir: work,
    });
    assert.ok(!diff.text.includes(work), "the work directory must not appear in the diff");
    assert.ok(!diff.text.includes("empty"), "the empty sentinel file must not appear");
    assert.ok(/^index 0000000\.\.[0-9a-f]+$/m.test(diff.text), "should use git's new-file index form");
  } finally {
    await cleanup(dir, work);
  }
});

test("oversized untracked files are skipped and reported", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.writeFile(path.join(dir, "huge.bin"), "x".repeat(300000));
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: [], workDir: work,
    });
    assert.equal(diff.untrackedSkipped.length, 1);
    assert.ok(diff.untrackedSkipped[0].includes("huge.bin"));
    assert.ok(!diff.text.includes("huge.bin"));
  } finally {
    await cleanup(dir, work);
  }
});

test("staged mode excludes unstaged and untracked work", { skip }, async () => {
  const { dir, git } = await makeRepo();
  const work = await workDir();
  try {
    await fs.writeFile(path.join(dir, "staged.txt"), "staged\n");
    await git("add", "staged.txt");
    await fs.writeFile(path.join(dir, "loose.txt"), "loose\n");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "staged", base: "", paths: [], workDir: work,
    });
    assert.ok(diff.text.includes("staged.txt"));
    assert.ok(!diff.text.includes("loose.txt"), "untracked is out of scope for --staged");
  } finally {
    await cleanup(dir, work);
  }
});

test("uncommitted mode sees working-tree edits to tracked files", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.writeFile(path.join(dir, "tracked.txt"), "changed\n");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "uncommitted", base: "", paths: [], workDir: work,
    });
    assert.ok(diff.text.includes("+changed"));
    assert.ok(diff.text.includes("-original"));
  } finally {
    await cleanup(dir, work);
  }
});

test("branch mode covers committed and uncommitted work together", { skip }, async () => {
  const { dir, git } = await makeRepo();
  const work = await workDir();
  try {
    await git("checkout", "-b", "feature");
    await fs.writeFile(path.join(dir, "committed.txt"), "committed\n");
    await git("add", "."); await git("commit", "-m", "work");
    await fs.writeFile(path.join(dir, "tracked.txt"), "edited\n");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "main", paths: [], workDir: work,
    });
    assert.ok(diff.text.includes("committed.txt"), "committed-on-branch work must be included");
    assert.ok(diff.text.includes("+edited"), "uncommitted work must be included");
  } finally {
    await cleanup(dir, work);
  }
});

test("path scoping limits what is collected", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "in.js"), "in\n");
    await fs.writeFile(path.join(dir, "out.js"), "out\n");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: ["src"], workDir: work,
    });
    assert.ok(diff.text.includes("src/in.js"));
    assert.ok(!diff.text.includes("out.js"));
  } finally {
    await cleanup(dir, work);
  }
});

test("an unchanged repo yields an empty diff", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: [], workDir: work,
    });
    assert.equal(diff.text.trim(), "");
    assert.equal(diff.filesChanged, 0);
  } finally {
    await cleanup(dir, work);
  }
});

test("a failed git invocation raises rather than reporting an empty diff", { skip }, async () => {
  // Returning "" on failure made `collectDiff` report "no changes to review"
  // and exit 0 — which a user reads as "my branch is clean". Silence is the one
  // answer a review tool must never give when it has actually failed.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-not-a-repo-"));
  const work = await workDir();
  try {
    await assert.rejects(
      () => collectDiff({
        gitPath, repoRoot: dir, mode: "uncommitted", base: "", paths: [], workDir: work,
      }),
      GitError,
    );
  } finally {
    await cleanup(dir, work);
  }
});

test("an unresolvable explicit base falls back instead of failing", { skip }, async () => {
  // Distinct from the case above: a base that does not resolve is a scope
  // question, not a git failure. The entry point validates --base up front.
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.writeFile(path.join(dir, "tracked.txt"), "changed\n");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "definitely-not-a-ref", paths: [], workDir: work,
    });
    assert.ok(diff.text.includes("+changed"));
  } finally {
    await cleanup(dir, work);
  }
});

test("a corrupt repository surfaces the git error", { skip }, async () => {
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.rm(path.join(dir, ".git", "objects"), { recursive: true, force: true });
    await fs.writeFile(path.join(dir, "tracked.txt"), "changed\n");
    await assert.rejects(
      () => collectDiff({
        gitPath, repoRoot: dir, mode: "uncommitted", base: "", paths: [], workDir: work,
      }),
      (error) => error instanceof GitError && /git/.test(error.message),
    );
  } finally {
    await cleanup(dir, work);
  }
});

test("an untracked symlink is never dereferenced into the diff", { skip: skip || process.platform === "win32" ? "needs POSIX symlinks" : false }, async () => {
  // `fs.stat` follows symlinks, so an untracked `ln -s /etc/passwd notes.txt`
  // would have shipped the TARGET's contents to Google. Git represents a
  // symlink as mode 120000 whose content is the link text; so do we.
  const { dir } = await makeRepo();
  const work = await workDir();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "devin-outside-"));
  try {
    const secretFile = path.join(outside, "secret.txt");
    await fs.writeFile(secretFile, "TOP_SECRET_PAYLOAD_DO_NOT_TRANSMIT\n");
    await fs.symlink(secretFile, path.join(dir, "innocent.txt"));

    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: [], workDir: work,
    });
    assert.ok(
      !diff.text.includes("TOP_SECRET_PAYLOAD_DO_NOT_TRANSMIT"),
      "the symlink target's contents must never enter the diff",
    );
    assert.ok(diff.text.includes("new file mode 120000"), "should be rendered as a symlink");
    assert.ok(diff.text.includes(`+${secretFile}`), "the link target path is the content");
  } finally {
    await cleanup(dir, work, outside);
  }
});

test("an empty untracked file still appears in the diff", { skip }, async () => {
  // git diff prints nothing when both sides are empty, so a new `__init__.py`
  // silently vanished from review. Its existence is the content.
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    await fs.writeFile(path.join(dir, "__init__.py"), "");
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: [], workDir: work,
    });
    assert.ok(diff.text.includes("diff --git a/__init__.py b/__init__.py"));
    assert.ok(diff.text.includes("new file mode 100644"));
    assert.equal(diff.filesChanged, 1);
  } finally {
    await cleanup(dir, work);
  }
});

test("an untracked executable keeps its mode", { skip: skip || process.platform === "win32" ? "needs POSIX modes" : false }, async () => {
  const { dir } = await makeRepo();
  const work = await workDir();
  try {
    const script = path.join(dir, "deploy.sh");
    await fs.writeFile(script, "#!/bin/sh\necho hi\n");
    await fs.chmod(script, 0o755);
    const diff = await collectDiff({
      gitPath, repoRoot: dir, mode: "branch", base: "", paths: [], workDir: work,
    });
    assert.ok(diff.text.includes("new file mode 100755"), "executable bit must survive");
    assert.ok(!diff.text.includes("new file mode 100644"));
  } finally {
    await cleanup(dir, work);
  }
});
