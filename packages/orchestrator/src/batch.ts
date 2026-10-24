import { promises as fs } from "node:fs";
import path from "node:path";
import { CreatorFlowError, ExitCode, resolveWithin, sha256File, writeJsonAtomic } from "@creatorflow/core";
import {
  BatchReportSchema,
  PackageManifestSchema,
  QaReportSchema,
  ReviewRecordSchema,
  validateArtifact,
  type BatchJobItem,
  type BatchReport,
  type BatchSummary,
} from "@creatorflow/schemas";
import { JobStore } from "./job-store.ts";
import { PlanStore } from "./plan-store.ts";
import { resumeWorkflow, weekFromJobId, type ResumeOptions, type ResumeReport } from "./workflow.ts";
import { jobIdFor, type WorkflowPaths } from "./workspace.ts";

export const BATCH_REPORT_FILE = "batch-report.json";

/**
 * Inspects all jobs for an approved weekly plan and generates a validated BatchReport.
 * Never executes jobs; this is an inspection and aggregation utility.
 */
export async function generateBatchReport(
  paths: WorkflowPaths,
  weekId: string,
  options: { now?: () => Date } = {},
): Promise<BatchReport> {
  const clock = options.now ?? (() => new Date());
  const plans = new PlanStore(paths, { now: clock });
  const approvedPlan = await plans.approvedPlan(weekId);

  // Find the approval event for metadata
  const index = await plans.loadIndex(weekId);
  const approvalEvent = index?.events
    ?.filter((e) => e.type === "approved" && e.version === approvedPlan.version)
    .pop();

  const jobStore = new JobStore(paths, clock);
  const jobs: BatchJobItem[] = [];

  const summary: BatchSummary = {
    total: approvedPlan.content.items.length,
    planned: 0,
    inProgress: 0,
    rendered: 0,
    qaPassed: 0,
    reviewPending: 0,
    reviewed: 0,
    packaged: 0,
    blocked: 0,
    failed: 0,
  };

  const inProgressStates = new Set([
    "RESEARCHED",
    "SCRIPTED",
    "LOCALIZED",
    "NARRATED",
    "ASSETS_READY",
    "RENDER_QUEUED",
  ]);

  for (const item of approvedPlan.content.items) {
    const jobId = jobIdFor(weekId, item.contentId);
    const jobDir = paths.jobDir(jobId);
    const loaded = await jobStore.load(jobId);

    if (loaded.status === "missing") {
      summary.planned++;
      jobs.push({
        jobId,
        contentId: item.contentId,
        title: item.topic,
        category: item.category,
        state: "PLANNED",
        stepsCompleted: [],
        stepsReused: [],
        qaVerdict: "none",
        reviewStatus: "none",
        packageStatus: "none",
      });
      continue;
    }

    if (loaded.status === "corrupt") {
      summary.failed++;
      jobs.push({
        jobId,
        contentId: item.contentId,
        title: item.topic,
        category: item.category,
        state: "FAILED",
        failure: {
          step: "core",
          kind: "permanent",
          code: "JOB_CORRUPT",
          message: "job.json is corrupt and cannot be read",
        },
        stepsCompleted: [],
        stepsReused: [],
        qaVerdict: "none",
        reviewStatus: "none",
        packageStatus: "none",
      });
      continue;
    }

    const job = loaded.job;
    const stepsCompleted: string[] = [];
    for (const [stepId, rec] of Object.entries(job.steps)) {
      if (rec.status === "succeeded") stepsCompleted.push(stepId);
    }

    // Inspect QA Report
    let qaVerdict: BatchJobItem["qaVerdict"] = "none";
    let qaHash: string | undefined;
    const qaPath = path.join(jobDir, "qa", "report.json");
    try {
      const rawQa = await fs.readFile(qaPath, "utf8");
      const qav = validateArtifact(QaReportSchema, JSON.parse(rawQa));
      if (qav.ok) {
        qaVerdict = qav.value.technicalQa.status;
        qaHash = `sha256:${(await sha256File(qaPath)).sha256}`;
      } else {
        qaVerdict = "failed";
      }
    } catch {
      if (stepsCompleted.includes("render")) qaVerdict = "pending";
    }

    // Inspect Review Status
    let reviewStatus: BatchJobItem["reviewStatus"] = "none";
    const reviewPath = path.join(jobDir, "review", "record.json");
    try {
      const rawReview = await fs.readFile(reviewPath, "utf8");
      const rrv = validateArtifact(ReviewRecordSchema, JSON.parse(rawReview));
      if (rrv.ok) {
        reviewStatus = rrv.value.review.status;
      }
    } catch {
      if (job.state === "QA_PASSED" || (job.state === "BLOCKED" && job.blocked?.code === "NEEDS_HUMAN_REVIEW")) {
        reviewStatus = "pending";
      }
    }

    // Inspect Package Status
    let packageStatus: BatchJobItem["packageStatus"] = "none";
    let packagePath: string | undefined;
    let packageManifestSha256: string | undefined;
    const pkgManifestPath = path.join(jobDir, "package", "manifest.json");
    try {
      const rawPkg = await fs.readFile(pkgManifestPath, "utf8");
      const pv = validateArtifact(PackageManifestSchema, JSON.parse(rawPkg));
      if (pv.ok) {
        const ph = await sha256File(pkgManifestPath);
        packageStatus = "packaged";
        packagePath = path.relative(paths.workspaceDir, path.join(jobDir, "package")).replace(/\\/g, "/");
        packageManifestSha256 = ph.sha256;
      } else {
        packageStatus = "corrupt";
      }
    } catch {
      if (job.state === "PACKAGE_READY") packageStatus = "missing";
    }

    // Pending Approval check
    let pendingApproval: BatchJobItem["pendingApproval"];
    if (job.state === "QA_PASSED" || (job.state === "BLOCKED" && job.blocked?.code === "NEEDS_HUMAN_REVIEW")) {
      if (qaHash) {
        pendingApproval = {
          type: "review",
          requiredHash: qaHash,
          instructions: `creatorflow review approve --job ${jobId} --qa-hash ${qaHash.slice(7, 23)} --by "<name>"`,
        };
      }
    }

    // Update Counts
    if (job.state === "PACKAGE_READY") {
      summary.packaged++;
    } else if (job.state === "REVIEWED") {
      summary.reviewed++;
    } else if (job.state === "QA_PASSED" || (job.state === "BLOCKED" && job.blocked?.code === "NEEDS_HUMAN_REVIEW")) {
      summary.reviewPending++;
      if (job.state === "QA_PASSED") summary.qaPassed++;
    } else if (job.state === "RENDERED") {
      summary.rendered++;
    } else if (job.state === "BLOCKED") {
      summary.blocked++;
    } else if (job.state === "FAILED") {
      summary.failed++;
    } else if (inProgressStates.has(job.state)) {
      summary.inProgress++;
    } else if (job.state === "PLANNED") {
      summary.planned++;
    }

    const jobItem: BatchJobItem = {
      jobId,
      contentId: item.contentId,
      title: item.topic,
      category: item.category,
      state: job.state,
      currentStep: job.currentStep,
      lastSuccessfulStep: job.lastSuccessfulStep,
      stepsCompleted,
      stepsReused: [],
      qaVerdict,
      reviewStatus,
      packageStatus,
      ...(packagePath ? { packagePath } : {}),
      ...(packageManifestSha256 ? { packageManifestSha256 } : {}),
      ...(job.blocked ? { blocked: { step: job.blocked.step, code: job.blocked.code, reason: job.blocked.reason } } : {}),
      ...(job.failure ? { failure: { step: job.failure.step, kind: job.failure.kind, code: job.failure.code, message: job.failure.message } } : {}),
      ...(pendingApproval ? { pendingApproval } : {}),
    };

    jobs.push(jobItem);
  }

  const notes: string[] = [];
  if (summary.packaged === summary.total) {
    notes.push(`All ${summary.total} video packages are completed and ready for distribution.`);
  } else {
    notes.push(
      `Batch progress: ${summary.packaged}/${summary.total} packaged, ${summary.reviewPending} awaiting review, ${summary.blocked} blocked, ${summary.failed} failed.`,
    );
  }

  const report: BatchReport = {
    schemaVersion: 1,
    kind: "batch-report",
    weekId,
    generatedAt: clock().toISOString(),
    plan: {
      version: approvedPlan.version,
      contentHash: approvedPlan.contentHash,
      ...(approvalEvent ? { approvedAt: approvalEvent.at, approvedBy: approvalEvent.by } : {}),
    },
    summary,
    jobs,
    notes,
  };

  const rv = validateArtifact(BatchReportSchema, report);
  if (!rv.ok) {
    throw new CreatorFlowError(`Generated batch report is invalid: ${rv.issues[0]?.message}`, {
      code: "BATCH_REPORT_INVALID",
      exitCode: ExitCode.INTERNAL,
    });
  }

  // Persist batch-report.json in the plan directory
  const planDir = paths.weekDir(weekId);
  await fs.mkdir(planDir, { recursive: true });
  await writeJsonAtomic(path.join(planDir, BATCH_REPORT_FILE), rv.value);

  return rv.value;
}

export interface RunBatchOptions extends ResumeOptions {
  stopAfter?: string;
}

export interface RunBatchResult {
  resumeReport: ResumeReport;
  batchReport: BatchReport;
}

/**
 * Runs batch execution for an approved week sequentially with concurrency 1.
 * Returns the final execution report and validated batch report.
 */
export async function runBatch(options: RunBatchOptions): Promise<RunBatchResult> {
  const resumeReport = await resumeWorkflow(options);
  const batchReport = await generateBatchReport(options.paths, resumeReport.weekId, {
    now: options.now,
  });
  return { resumeReport, batchReport };
}
