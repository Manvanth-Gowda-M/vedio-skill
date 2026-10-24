import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CreatorFlowError, ExitCode } from "./errors.ts";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const RETRYABLE_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(from: string, to: string): Promise<void> {
  // On Windows, antivirus/indexers can briefly lock the destination; retry a few times.
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_RENAME.has(code)) break;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Atomically replace `filePath` with `data`: write to a sibling temp file,
 * fsync it, then rename over the target. Readers never see a partial file.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = tempPathFor(filePath);
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw new CreatorFlowError(`Could not write ${filePath}.`, {
      code: "WRITE_FAILED",
      exitCode: ExitCode.IO,
      cause: error,
    });
  }
}

/** Stable, human-diffable JSON with a trailing newline. */
export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, stringifyJson(value));
}

function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}

/**
 * Creates `filePath` with complete content only if it does not exist yet.
 * Uses write-temp + hard-link (link fails with EEXIST and never replaces), so
 * other processes see either no file or the full file. Falls back to an
 * exclusive open on filesystems without hard links (content may then be
 * partial after a crash; callers validate on load).
 * Returns false when the file already exists.
 */
export async function writeFileExclusive(filePath: string, data: string | Uint8Array): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = tempPathFor(filePath);
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(tmp, filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw error;
    try {
      await fs.writeFile(filePath, data, { flag: "wx" });
      return true;
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw fallbackError;
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const TEMP_RE = /^\..+\.(\d+)\.[0-9a-f]{8}\.tmp$/;

/** Default liveness probe: signal 0 checks existence without affecting the process. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but owned by someone else. Anything unexpected: assume alive (conservative).
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Removes temp files left by interrupted atomic writes in `dir`, but only when
 * the writing process (pid embedded in the name) is no longer alive.
 */
export async function cleanupStaleTempFiles(dir: string, isAlive: (pid: number) => boolean = isProcessAlive): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const m = TEMP_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    await fs.rm(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** Reads and parses JSON, converting failures into actionable CreatorFlowErrors. */
export async function readJsonFile(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CreatorFlowError(
      code === "ENOENT" ? `File not found: ${filePath}` : `Could not read ${filePath}.`,
      { code: code === "ENOENT" ? "FILE_NOT_FOUND" : "READ_FAILED", exitCode: ExitCode.CONFIG, cause: error },
    );
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new CreatorFlowError(`Invalid JSON in ${filePath}: ${(error as Error).message}`, {
      code: "JSON_INVALID",
      hint: "Fix the syntax error or regenerate the file with `creatorflow init`.",
      exitCode: ExitCode.CONFIG,
    });
  }
}

/** Recursively copies a directory (files only, no symlink following). */
export async function copyDir(src: string, dest: string): Promise<string[]> {
  const copied: string[] = [];
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied.push(...(await copyDir(from, to)));
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
      copied.push(to);
    }
  }
  return copied;
}
