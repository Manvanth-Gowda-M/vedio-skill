import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { CreatorFlowError, ExitCode } from "./errors.ts";
import { isProcessAlive, stringifyJson, writeFileExclusive } from "./fs.ts";

/**
 * Advisory lock files with validated stale-lock recovery.
 *
 * - Acquire: the lock file is created complete-or-not-at-all with
 *   writeFileExclusive (hard link, never replaces an existing file).
 * - A held lock is only considered stale when it was written on THIS host and
 *   its owner PID is no longer alive. Age alone never breaks a lock; locks from
 *   other hosts (e.g. a shared network drive) are never broken automatically.
 * - Breaking: the stale file is renamed to a unique tombstone, re-read, and
 *   only deleted if it is still the exact lock that was judged stale (token
 *   match). If another process re-locked in between, its lock is restored with
 *   a no-replace link and acquisition fails as "held".
 *
 * Known limits: PID reuse (a new unrelated process with the same PID) makes a
 * dead owner look alive, which fails safe (lock reported as held). Locks are
 * advisory: only CreatorFlow code honours them.
 */

export interface LockInfo {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  purpose: string;
}

export interface LockHandle {
  path: string;
  info: LockInfo;
  /** Set when a stale lock from a dead process was recovered to acquire this one. */
  recoveredStale?: LockInfo;
  release(): Promise<void>;
}

export interface LockOptions {
  purpose: string;
  /** Total time to keep retrying while the lock is held by a live owner. Default 0 (fail fast). */
  waitMs?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  hostname?: string;
  now?: () => Date;
}

function parseLock(raw: string): LockInfo | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof v.token === "string" && typeof v.pid === "number" && typeof v.hostname === "string") return v as LockInfo;
  } catch {
    // fall through
  }
  return undefined;
}

async function readLock(lockPath: string): Promise<LockInfo | "missing" | "unreadable"> {
  try {
    return parseLock(await fs.readFile(lockPath, "utf8")) ?? "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

function heldError(lockPath: string, holder: LockInfo | "unreadable"): CreatorFlowError {
  if (holder === "unreadable") {
    return new CreatorFlowError(`Lock file ${lockPath} exists but cannot be read.`, {
      code: "LOCK_UNREADABLE",
      hint: "No CreatorFlow process should be running for this item. Inspect the file and delete it manually only if you are sure.",
      exitCode: ExitCode.CONFLICT,
    });
  }
  return new CreatorFlowError(`Locked by pid ${holder.pid} on ${holder.hostname} (${holder.purpose}, since ${holder.acquiredAt}).`, {
    code: "LOCK_HELD",
    hint: "Wait for the other CreatorFlow process to finish. Locks from dead processes on this machine are recovered automatically.",
    exitCode: ExitCode.CONFLICT,
    details: { pid: holder.pid, hostname: holder.hostname, purpose: holder.purpose, acquiredAt: holder.acquiredAt },
  });
}

export async function acquireLock(lockPath: string, options: LockOptions): Promise<LockHandle> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const hostname = options.hostname ?? os.hostname();
  const now = options.now ?? (() => new Date());
  const deadline = Date.now() + (options.waitMs ?? 0);
  const pollMs = options.pollMs ?? 100;
  let recoveredStale: LockInfo | undefined;

  for (;;) {
    const info: LockInfo = {
      token: randomBytes(12).toString("hex"),
      pid: process.pid,
      hostname,
      acquiredAt: now().toISOString(),
      purpose: options.purpose,
    };
    if (await writeFileExclusive(lockPath, stringifyJson(info))) {
      return {
        path: lockPath,
        info,
        ...(recoveredStale ? { recoveredStale } : {}),
        release: () => releaseLock(lockPath, info.token),
      };
    }

    const holder = await readLock(lockPath);
    if (holder === "missing") continue; // released between our attempt and the read
    const stale = holder !== "unreadable" && holder.hostname === hostname && holder.pid !== process.pid && !isAlive(holder.pid);

    if (stale) {
      const tombstone = `${lockPath}.stale-${info.token}`;
      try {
        await fs.rename(lockPath, tombstone);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = await readLock(tombstone);
      if (moved !== "missing" && moved !== "unreadable" && moved.token === holder.token) {
        await fs.rm(tombstone, { force: true });
        recoveredStale = holder;
        continue;
      }
      // We displaced a fresh lock taken by someone else after our check: put it back without replacing anything.
      try {
        await fs.link(tombstone, lockPath);
      } catch {
        // Someone else holds the path now; leave the tombstone for diagnosis.
        throw heldError(lockPath, moved === "missing" ? "unreadable" : moved);
      }
      await fs.rm(tombstone, { force: true });
      if (Date.now() >= deadline) throw heldError(lockPath, moved === "missing" ? "unreadable" : moved);
    } else if (Date.now() >= deadline) {
      throw heldError(lockPath, holder);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Releases only our own lock (token match); never deletes another owner's lock. */
export async function releaseLock(lockPath: string, token: string): Promise<void> {
  const current = await readLock(lockPath);
  if (current === "missing") return;
  if (current === "unreadable" || current.token !== token) {
    throw new CreatorFlowError(`Refusing to release ${lockPath}: it is not owned by this process.`, {
      code: "LOCK_NOT_OWNED",
      exitCode: ExitCode.CONFLICT,
    });
  }
  await fs.rm(lockPath, { force: true });
}

/** Runs `fn` while holding the lock, always releasing it afterwards. */
export async function withLock<T>(lockPath: string, options: LockOptions, fn: (lock: LockHandle) => Promise<T>): Promise<T> {
  const lock = await acquireLock(lockPath, options);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
