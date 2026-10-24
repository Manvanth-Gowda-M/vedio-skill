import { execFile, spawn } from "node:child_process";

export interface RunResult {
  /** Process exit code, or null when the process could not start or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** "ENOENT" not found; "TIMEOUT" killed by timeout; "ABORTED" killed via AbortSignal. */
  errorCode?: string;
}

/**
 * Runs an executable with an argument array (never through a shell), so
 * untrusted values in `args` cannot be interpreted as shell syntax.
 * Passing `signal` kills the child when the signal aborts (used by step timeouts).
 */
export function runCommand(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 15_000,
        cwd: options.cwd,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (err.code === "ENOENT") {
          resolve({ exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" });
        } else if (err.name === "AbortError" || err.code === "ABORT_ERR") {
          resolve({ exitCode: null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), errorCode: "ABORTED" });
        } else if (err.killed) {
          resolve({ exitCode: null, stdout, stderr, errorCode: "TIMEOUT" });
        } else {
          resolve({ exitCode: typeof err.code === "number" ? err.code : 1, stdout, stderr });
        }
      },
    );
  });
}


export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Last ~64 KiB of output. */
  stdout: string;
  stderr: string;
  pid?: number;
  errorCode?: "ENOENT" | "TIMEOUT" | "ABORTED" | "SPAWN_FAILED";
  durationMs: number;
}

const TAIL = 64 * 1024;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

/** Kills a process and all its descendants (Windows: taskkill /T; POSIX: the process group). */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 10_000 });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Long-running subprocess with argument arrays (no shell). On timeout or
 * abort the WHOLE process tree is killed (e.g. a renderer and the browser it
 * launched) and the promise resolves only after the child has exited.
 */
export function runProcess(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; onStdoutLine?: (line: string) => void; input?: string } = {},
): Promise<ProcessResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", errorCode: "ABORTED", durationMs: 0 });
      return;
    }
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", errorCode: "SPAWN_FAILED", durationMs: Date.now() - t0 });
      return;
    }
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined); // child may exit before reading everything
      child.stdin.end(options.input, "utf8");
    }
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let reason: "TIMEOUT" | "ABORTED" | undefined;
    let spawnError: string | undefined;
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      stdout = tail(stdout + d);
      if (options.onStdoutLine) {
        lineBuf += d;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() ?? "";
        for (const l of lines) options.onStdoutLine(l);
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = tail(stderr + d)));
    const stop = (why: "TIMEOUT" | "ABORTED") => {
      if (reason || child.exitCode !== null) return;
      reason = why;
      if (child.pid) void killProcessTree(child.pid);
    };
    const timer = options.timeoutMs ? setTimeout(() => stop("TIMEOUT"), options.timeoutMs) : undefined;
    const onAbort = () => stop("ABORTED");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e: NodeJS.ErrnoException) => (spawnError = e.code ?? "SPAWN_FAILED"));
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const errorCode = reason ?? (spawnError === "ENOENT" ? "ENOENT" : spawnError ? "SPAWN_FAILED" : undefined);
      resolve({ exitCode: code, signal: sig, stdout, stderr, ...(child.pid ? { pid: child.pid } : {}), ...(errorCode ? { errorCode } : {}), durationMs: Date.now() - t0 });
    });
  });
}
