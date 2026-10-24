import { promises as fs } from "node:fs";
import {
  CreatorFlowError,
  ExitCode,
  pathExists,
  stringifyJson,
  writeFileAtomic,
  writeFileExclusive,
} from "@creatorflow/core";
import { JobRecordSchema, Slug, validateArtifact, type JobRecord, type ValidationIssue } from "@creatorflow/schemas";
import type { WorkflowPaths } from "./workspace.ts";

export type JobLoad =
  | { status: "ok"; job: JobRecord }
  | { status: "missing" }
  | { status: "corrupt"; issues: ValidationIssue[]; backup: "valid" | "invalid" | "missing" };

type Parsed = { ok: true; job: JobRecord } | { ok: false; issues: ValidationIssue[] };

function parseJob(raw: string, expectedId: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { ok: false, issues: [{ path: "(file)", message: `Invalid JSON: ${(error as Error).message}` }] };
  }
  const v = validateArtifact(JobRecordSchema, data);
  if (!v.ok) return { ok: false, issues: v.issues };
  if (v.value.jobId !== expectedId) {
    return { ok: false, issues: [{ path: "jobId", message: `Record is for "${v.value.jobId}" but stored under "${expectedId}"` }] };
  }
  return { ok: true, job: v.value };
}

async function readParsed(file: string, jobId: string): Promise<Parsed | "missing"> {
  try {
    return parseJob(await fs.readFile(file, "utf8"), jobId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return { ok: false, issues: [{ path: "(file)", message: (error as Error).message }] };
  }
}

/**
 * File-backed job records: workspace/jobs/<jobId>/job.json.
 *
 * - Every write validates the new record first, then compare-and-swaps on
 *   `revision` against what is on disk, so stale writers fail with
 *   JOB_REVISION_CONFLICT instead of overwriting newer state.
 * - The previous valid record is kept as job.prev.json before each write.
 * - A corrupt job.json is never overwritten in place: `recover` quarantines
 *   it as job.json.corrupt-<timestamp> and restores the backup.
 * Callers hold the job lock (see runner) for read-modify-write sequences.
 */
export class JobStore {
  readonly paths: WorkflowPaths;
  readonly now: () => Date;

  constructor(paths: WorkflowPaths, now: () => Date = () => new Date()) {
    this.paths = paths;
    this.now = now;
  }

  async list(): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.paths.jobsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && Slug.safeParse(e.name).success)
      .map((e) => e.name)
      .sort();
  }

  async load(jobId: string): Promise<JobLoad> {
    const main = await readParsed(this.paths.jobFile(jobId), jobId);
    if (main === "missing") return { status: "missing" };
    if (main.ok) return { status: "ok", job: main.job };
    const backup = await readParsed(this.paths.jobBackup(jobId), jobId);
    return { status: "corrupt", issues: main.issues, backup: backup === "missing" ? "missing" : backup.ok ? "valid" : "invalid" };
  }

  /** Creates a new record; never replaces an existing one. Returns false if it already exists. */
  async create(job: JobRecord): Promise<boolean> {
    const v = validateArtifact(JobRecordSchema, job);
    if (!v.ok) throw this.invalid(job.jobId, v.issues);
    return writeFileExclusive(this.paths.jobFile(job.jobId), stringifyJson(v.value));
  }

  /** Persists `job` if the on-disk revision still equals job.revision. Returns the stored record (revision + 1). */
  async save(job: JobRecord): Promise<JobRecord> {
    const next: JobRecord = { ...job, revision: job.revision + 1, updatedAt: this.now().toISOString() };
    const v = validateArtifact(JobRecordSchema, next);
    if (!v.ok) throw this.invalid(job.jobId, v.issues);

    const file = this.paths.jobFile(job.jobId);
    let currentRaw: string;
    try {
      currentRaw = await fs.readFile(file, "utf8");
    } catch {
      throw new CreatorFlowError(`Job ${job.jobId} disappeared while being updated.`, { code: "JOB_MISSING", exitCode: ExitCode.CONFLICT });
    }
    const current = parseJob(currentRaw, job.jobId);
    if (!current.ok) {
      throw new CreatorFlowError(`Job ${job.jobId} on disk is corrupt; refusing to overwrite it.`, {
        code: "JOB_CORRUPT",
        hint: "Run `creatorflow resume` to quarantine it and restore the last valid copy.",
        exitCode: ExitCode.CHECK_FAILED,
        details: current.issues,
      });
    }
    if (current.job.revision !== job.revision) {
      throw new CreatorFlowError(`Job ${job.jobId} changed on disk (revision ${current.job.revision}, expected ${job.revision}).`, {
        code: "JOB_REVISION_CONFLICT",
        hint: "Another process updated this job. Re-run the command.",
        exitCode: ExitCode.CONFLICT,
      });
    }
    await writeFileAtomic(this.paths.jobBackup(job.jobId), currentRaw);
    await writeFileAtomic(file, stringifyJson(v.value));
    return v.value;
  }

  /**
   * Quarantines a corrupt job.json and restores job.prev.json. Only possible
   * when the backup is valid; otherwise throws JOB_CORRUPT and changes nothing.
   */
  async recover(jobId: string): Promise<{ job: JobRecord; quarantined: string }> {
    const state = await this.load(jobId);
    if (state.status !== "corrupt") throw new Error(`recover() called for ${jobId} in state ${state.status}`);
    if (state.backup !== "valid") {
      throw new CreatorFlowError(`Job ${jobId} is corrupt and has no valid backup.`, {
        code: "JOB_CORRUPT",
        hint: `Inspect ${this.paths.jobFile(jobId)}; fix it by hand or delete the job directory to recreate the job from the plan.`,
        exitCode: ExitCode.CHECK_FAILED,
        details: state.issues,
      });
    }
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    let quarantined = `${this.paths.jobFile(jobId)}.corrupt-${stamp}`;
    for (let i = 1; await pathExists(quarantined); i++) quarantined = `${this.paths.jobFile(jobId)}.corrupt-${stamp}-${i}`;
    await fs.rename(this.paths.jobFile(jobId), quarantined);
    const backupRaw = await fs.readFile(this.paths.jobBackup(jobId), "utf8");
    await writeFileAtomic(this.paths.jobFile(jobId), backupRaw);
    const restored = parseJob(backupRaw, jobId);
    if (!restored.ok) throw new Error("backup changed during recovery");
    restored.job.history.push({
      at: this.now().toISOString(),
      type: "recovered",
      reason: `job.json was invalid (${state.issues[0]?.path}: ${state.issues[0]?.message}); restored job.prev.json; corrupt copy kept at ${quarantined.split(/[\\/]/).pop()}`.slice(0, 2000),
    });
    return { job: await this.save(restored.job), quarantined };
  }

  private invalid(jobId: string, issues: ValidationIssue[]): CreatorFlowError {
    return new CreatorFlowError(`Refusing to write an invalid record for job ${jobId}.`, {
      code: "JOB_INVALID",
      exitCode: ExitCode.INTERNAL,
      details: issues,
    });
  }
}
