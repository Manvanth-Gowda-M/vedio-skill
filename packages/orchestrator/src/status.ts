import { promises as fs } from "node:fs";
import os from "node:os";
import { fingerprint, isCreatorFlowError, isProcessAlive } from "@creatorflow/core";
import type { JobRecord, ValidationIssue, VideoState } from "@creatorflow/schemas";
import { JobStore } from "./job-store.ts";
import type { Pipeline } from "./pipeline.ts";
import { PlanStore, type PlanSummary } from "./plan-store.ts";
import { COUNTED_OUTCOMES } from "./runner.ts";
import { jobIdFor, type WorkflowPaths } from "./workspace.ts";

export interface JobStatus {
  jobId: string;
  contentId?: string;
  state?: VideoState;
  progress: { verified: number; total: number };
  nextStep?: string;
  lastSuccessfulStep?: string | null;
  /** Steps recorded as succeeded after an unverified step; they are re-checked on resume. */
  staleSteps: string[];
  attempts: number;
  countedAttempts: number;
  inApprovedPlan: boolean;
  /** False when the approved plan changed this item since the job last ran. */
  planCurrent?: boolean;
  blocked?: JobRecord["blocked"];
  failure?: JobRecord["failure"];
  /** A live process currently holds this job's lock. */
  runningPid?: number;
  /** Lock file left by a process that is no longer running (recovered on resume). */
  staleLock?: boolean;
  corrupt?: { issues: ValidationIssue[]; backup: "valid" | "invalid" | "missing" };
  updatedAt?: string;
}

export interface StatusReport {
  weekId: string;
  plan: PlanSummary;
  jobs: JobStatus[];
  /** Approved items that do not have a job record yet. */
  missingJobs: string[];
  counts: Record<string, number>;
}

async function lockState(file: string): Promise<{ pid?: number; stale?: boolean }> {
  try {
    const info = JSON.parse(await fs.readFile(file, "utf8")) as { pid?: number; hostname?: string };
    if (typeof info.pid !== "number") return {};
    if (info.hostname === os.hostname() && !isProcessAlive(info.pid)) return { stale: true };
    return { pid: info.pid };
  } catch {
    return {};
  }
}

/** Read-only status: never modifies plans, jobs or locks. */
export async function buildStatus(paths: WorkflowPaths, pipeline: Pipeline, weekId: string): Promise<StatusReport> {
  const plans = new PlanStore(paths);
  const store = new JobStore(paths);
  const plan = await plans.summary(weekId);

  let approvedItems = new Map<string, string>();
  try {
    const approved = await plans.approvedPlan(weekId);
    approvedItems = new Map(approved.content.items.map((i) => [jobIdFor(weekId, i.contentId), fingerprint(i)]));
  } catch (error) {
    if (!isCreatorFlowError(error)) throw error;
  }

  const prefix = `${weekId.toLowerCase()}-`;
  const jobs: JobStatus[] = [];
  for (const jobId of (await store.list()).filter((id) => id.startsWith(prefix))) {
    const loaded = await store.load(jobId);
    const lock = await lockState(paths.jobLock(jobId));
    const base = {
      jobId,
      staleSteps: [] as string[],
      progress: { verified: 0, total: pipeline.steps.length },
      attempts: 0,
      countedAttempts: 0,
      inApprovedPlan: approvedItems.has(jobId),
      ...(lock.pid ? { runningPid: lock.pid } : {}),
      ...(lock.stale ? { staleLock: true } : {}),
    };
    if (loaded.status === "missing") continue;
    if (loaded.status === "corrupt") {
      jobs.push({ ...base, corrupt: { issues: loaded.issues, backup: loaded.backup } });
      continue;
    }
    const job = loaded.job;
    let verified = 0;
    let next: string | undefined;
    const stale: string[] = [];
    for (const step of pipeline.steps) {
      const rec = job.steps[step.id];
      if (rec?.status === "succeeded" && next === undefined) verified++;
      else if (next === undefined) next = step.id;
      else if (rec?.status === "succeeded") stale.push(step.id);
    }
    let attempts = 0;
    let counted = 0;
    for (const rec of Object.values(job.steps)) {
      attempts += rec.attempts.length;
      counted += rec.attempts.slice(rec.budgetStart).filter((a) => a.outcome && COUNTED_OUTCOMES.has(a.outcome)).length;
    }
    const approvedHash = approvedItems.get(jobId);
    jobs.push({
      ...base,
      contentId: job.contentId,
      state: job.state,
      progress: { verified, total: pipeline.steps.length },
      ...(next ? { nextStep: next } : {}),
      lastSuccessfulStep: job.lastSuccessfulStep,
      staleSteps: stale,
      attempts,
      countedAttempts: counted,
      ...(approvedHash ? { planCurrent: approvedHash === job.planRef.itemHash } : {}),
      ...(job.blocked ? { blocked: job.blocked } : {}),
      ...(job.failure ? { failure: job.failure } : {}),
      updatedAt: job.updatedAt,
    });
  }

  const known = new Set(jobs.map((j) => j.jobId));
  const missingJobs = [...approvedItems.keys()].filter((id) => !known.has(id));
  const counts: Record<string, number> = {};
  for (const j of jobs) {
    const key = j.corrupt ? "CORRUPT" : (j.state ?? "UNKNOWN");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  if (missingJobs.length) counts["NOT_CREATED"] = missingJobs.length;
  return { weekId, plan, jobs, missingJobs, counts };
}
