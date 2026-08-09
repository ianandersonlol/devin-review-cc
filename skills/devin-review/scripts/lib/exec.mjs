// Process helpers. Everything spawns with shell:false and an argv array, so no
// user-supplied string is ever parsed by a shell.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a command and resolve with its exit code and output. Never rejects on a
 * non-zero exit — callers decide what a failure means (git diff --no-index
 * exits 1 for "files differ", which is a success for us).
 *
 * Uses spawn rather than execFile for two reasons that both bit us:
 *
 *  - stdin is set to "ignore" so the child sees EOF immediately. execFile opens
 *    a pipe and never closes it, and `agy models` waits on stdin — so it hung
 *    until the timeout killed it and looked, to us, like a broken install.
 *  - a process killed by a signal exits with a null code. Reporting that as
 *    `code ?? 0` turns a timeout into an apparent success; `signal` is carried
 *    through and `timedOut` is set explicitly instead.
 */
export function run(file, args, options = {}) {
  const limit = options.maxBuffer ?? MAX_BUFFER;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: `${file}: ${error.message}`, notFound: true });
      return;
    }

    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const collect = (stream, key) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (sizes[key] >= limit) return;
        sizes[key] += Buffer.byteLength(chunk, "utf8");
        if (sizes[key] > limit) {
          overflow = true;
          chunks[key].push(chunk);
          child.kill("SIGKILL");
          return;
        }
        chunks[key].push(chunk);
      });
      // A read error (EPIPE after our own kill) must not reject the promise.
      stream.on("error", () => {});
    };
    collect(child.stdout, "stdout");
    collect(child.stderr, "stderr");

    let timer = null;
    if (options.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout);
    }

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error) => {
      settle({
        code: 127,
        stdout: chunks.stdout.join(""),
        stderr: `${file}: ${error.message}`,
        notFound: error.code === "ENOENT",
      });
    });

    child.on("close", (code, signal) => {
      settle({
        // Signal-killed children report a null code. Surfacing that as a
        // non-zero failure is the only honest reading.
        code: code === null ? (signal ? 124 : 1) : code,
        stdout: chunks.stdout.join(""),
        stderr: chunks.stderr.join(""),
        signal: signal ?? undefined,
        timedOut,
        overflow,
      });
    });
  });
}

/**
 * Resolve an executable to a full path by walking PATH.
 *
 * Returning the full path matters on Windows: Node's spawn with shell:false
 * does not apply PATHEXT, so bare `spawn("agy")` fails to find `agy.exe` even
 * when it is plainly on PATH. Every caller spawns the resolved path instead.
 */
export async function which(command) {
  const isWindows = process.platform === "win32";
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions = candidateExtensions(command, isWindows);

  // An explicit path (./foo, /usr/bin/foo, C:\foo) bypasses the PATH walk.
  if (command.includes("/") || (isWindows && command.includes("\\"))) {
    const direct = await executableAt(command, extensions, isWindows);
    return direct;
  }

  for (const dir of dirs) {
    const found = await executableAt(path.join(dir, command), extensions, isWindows);
    if (found) return found;
  }
  return null;
}

/**
 * Which suffixes to try for a given command name.
 *
 * On Windows a name that ALREADY carries a PATHEXT extension must be tried
 * as-is: appending unconditionally turns `git.exe` into `git.exe.COM`,
 * `git.exe.EXE`, … and never stats the file that actually exists. Our own call
 * sites pass bare names, but a helper that silently fails on a qualified name
 * is a trap for the next caller.
 */
function candidateExtensions(command, isWindows) {
  if (!isWindows) return [""];
  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = command.toLowerCase();
  const alreadyQualified = pathext.some((ext) => lower.endsWith(ext.toLowerCase()));
  return alreadyQualified ? [""] : pathext;
}

async function executableAt(base, extensions, isWindows) {
  for (const ext of extensions) {
    const candidate = base + ext;
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      if (!isWindows) {
        // Any execute bit will do; we cannot cheaply know which applies to us.
        if ((stat.mode & 0o111) === 0) continue;
      }
      return candidate;
    } catch {
      // Try the next extension.
    }
  }
  return null;
}
