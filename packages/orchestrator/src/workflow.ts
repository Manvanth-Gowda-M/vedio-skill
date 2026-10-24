import { CreatorFlowError, ExitCode } from "@creatorflow/core";
import { JobStore } from "./job-store.ts";
import { PlanStore, type ApprovedPlan } from "./plan-store.ts";
import { createJobRecord, runJob, type JobOutcome, type JobResult, type RunJobOptions } from "./runner.ts";
import { jobIdFor, type WorkflowPaths } from "./workspace.ts";

/** Creates job records for plan items that have none yet. Never modifies existing jobs. */
export async function syncJobs(paths: WorkflowPaths, plan: ApprovedPlan, now: () => Date = () => new Date()): Promise<string[]> {
  const store = new JobStore(paths, now);
  const created: string[] = [];
  for (const item of plan.content.items) {
    const job = createJobRecord(plan, item, now().toISOString());
    if ((await store.load(job.jobId)).status === "missing" && (await store.create(job))) created.push(job.jobId);
  }
  return created;
}

/** "2026-w44-some-topic" -> "2026-W44" */
export function weekFromJobId(jobId: string): string | undefined {
  const m = /^(\d{4})-w(\d{2})-/.exec(jobId);
  return m ? `${m[1]}-W${m[2]}` : undefined;
}

export interface ResumeOptions extends Omit<RunJobOptions, "plan" | "item"> {
  weekId?: string;
  jobId?: string;
}

export interface ResumeReport {
  weekId: string;
  planVersion: number;
  planHash: string;
  created: string[];
  jobs: JobOutcome[];
  summary: Record<JobResult, number>;
}

/**
 * Resumes every job of the approved plan for a week (or one job), in plan
 * order. Jobs are independent: one job failing or being locked does not stop
 * the others; only user cancellation stops the batch.
 */
export async function resumeWorkflow(o: ResumeOptions): Promise<ResumeReport> {
  const plans = new PlanStore(o.paths, o.now ? { now: o.now } : {});
  const weekId = o.weekId ?? (o.jobId ? weekFromJobId(o.jobId) : undefined) ?? (await plans.latestWeek());
  if (!weekId) {
    throw new CreatorFlowError("No weekly plans found in the workspace; there is nothing to resume.", {
      code: "PLAN_NOT_FOUND",
      hint: "Create a plan with `creatorflow plan add --file <plan.json>` and approve it.",
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  const plan = await plans.approvedPlan(weekId);
  let items = plan.content.items;
  if (o.jobId) {
    items = items.filter((i) => jobIdFor(weekId, i.contentId) === o.jobId);
    if (items.length === 0) {
      throw new CreatorFlowError(`Job ${o.jobId} is not part of approved plan ${weekId} v${plan.version}.`, {
        code: "JOB_NOT_FOUND",
        hint: "Run `creatorflow status` to list job ids.",
        exitCode: ExitCode.NOT_FOUND,
      });
    }
  }
  const created = await syncJobs(o.paths, plan, o.now);
  const jobs: JobOutcome[] = [];
  for (const item of items) {
    const outcome = await runJob({ ...o, plan, item });
    jobs.push(outcome);
    if (outcome.result === "cancelled") break;
  }
  const summary: Record<JobResult, number> = { completed: 0, unchanged: 0, blocked: 0, failed: 0, locked: 0, corrupt: 0, cancelled: 0 };
  for (const j of jobs) summary[j.result]++;
  return { weekId, planVersion: plan.version, planHash: plan.contentHash, created, jobs, summary };
}
