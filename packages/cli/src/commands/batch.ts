import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId, CreatorFlowError, ExitCode, resolveWithin, stringifyJson, writeJsonAtomic, type ExitCodeValue } from "@creatorflow/core";
import { generateBatchReport, runBatch, PlanStore, workflowPaths, type Pipeline } from "@creatorflow/orchestrator";
import type { BatchReport } from "@creatorflow/schemas";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

async function ctxOf(dir: string, weekId?: string) {
  const project = await requireProject(dir);
  const paths = workflowPaths(resolveWithin(project.paths.dir, project.config.workspaceDir));
  const plans = new PlanStore(paths);
  const resolvedWeek = weekId ?? (await plans.latestWeek());
  if (!resolvedWeek) {
    throw new CreatorFlowError("No weekly plans found in the workspace.", {
      code: "PLAN_NOT_FOUND",
      hint: "Create a plan with `creatorflow plan add --file <plan.json>` and approve it.",
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  return { project, paths, weekId: resolvedWeek };
}

function printBatchSummary(o: Output, rep: BatchReport): void {
  o.line(`Batch Report: ${rep.weekId} (plan v${rep.plan.version}, hash ${rep.plan.contentHash.slice(0, 16)}…)`);
  o.line(
    `  Summary: ${rep.summary.total} total items | ${rep.summary.packaged} packaged | ${rep.summary.reviewPending} review pending | ${rep.summary.reviewed} reviewed | ${rep.summary.qaPassed} QA passed | ${rep.summary.rendered} rendered | ${rep.summary.blocked} blocked | ${rep.summary.failed} failed`,
  );
  o.line("  Jobs:");
  for (const job of rep.jobs) {
    const qa = job.qaVerdict !== "none" ? `QA:${job.qaVerdict}` : "";
    const rev = job.reviewStatus !== "none" ? `Review:${job.reviewStatus}` : "";
    const pkg = job.packageStatus === "packaged" ? "PACKAGED" : "";
    const flags = [qa, rev, pkg].filter(Boolean).join(" ");
    const info = job.blocked ? `BLOCKED: ${job.blocked.code}` : job.failure ? `FAILED: ${job.failure.code}` : "";
    o.line(`    ${job.jobId.padEnd(32)} ${job.state.padEnd(14)} ${flags.padEnd(28)} ${info}`);
    if (job.pendingApproval) {
      o.line(`      -> Action required: ${job.pendingApproval.instructions}`);
    }
  }
  if (rep.notes.length > 0) {
    for (const note of rep.notes) o.line(`  Note: ${note}`);
  }
}

// ------------------------------------------------------------------ batch status

export async function batchStatusCommand(o: Output, dir: string, weekId?: string): Promise<ExitCodeValue> {
  const { paths, weekId: resolvedWeek } = await ctxOf(dir, weekId);
  const rep = await generateBatchReport(paths, resolvedWeek);
  o.result(rep);
  printBatchSummary(o, rep);
  return ExitCode.OK;
}

// ------------------------------------------------------------------ batch run

export async function batchRunCommand(
  o: Output,
  dir: string,
  pipeline: Pipeline,
  f: { week?: string; stopAfter?: string; retryFailed?: boolean },
): Promise<ExitCodeValue> {
  const { project, paths, weekId } = await ctxOf(dir, f.week);

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);

  let res;
  try {
    res = await runBatch({
      paths,
      pipeline,
      profile: project.profile,
      config: project.config,
      weekId,
      stopAfter: f.stopAfter,
      retryFailed: f.retryFailed,
      signal: ac.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
  }

  o.result({
    ok: res.batchReport.summary.failed === 0 && res.batchReport.summary.blocked === 0,
    resume: res.resumeReport,
    batch: res.batchReport,
  });

  printBatchSummary(o, res.batchReport);

  const allDone = res.batchReport.summary.packaged === res.batchReport.summary.total;
  const anyFailed = res.batchReport.summary.failed > 0 || res.batchReport.summary.blocked > 0;

  if (allDone) return ExitCode.OK;
  return anyFailed ? ExitCode.CHECK_FAILED : ExitCode.OK;
}

// ------------------------------------------------------------------ batch resume

export async function batchResumeCommand(
  o: Output,
  dir: string,
  pipeline: Pipeline,
  f: { week?: string; retryFailed?: boolean },
): Promise<ExitCodeValue> {
  return batchRunCommand(o, dir, pipeline, f);
}

// ------------------------------------------------------------------ batch report

export async function batchReportCommand(o: Output, dir: string, f: { week?: string; out?: string }): Promise<ExitCodeValue> {
  const { paths, weekId } = await ctxOf(dir, f.week);
  const rep = await generateBatchReport(paths, weekId);

  if (f.out) {
    const outPath = path.isAbsolute(f.out) ? f.out : resolveWithin(dir, f.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await writeJsonAtomic(outPath, rep);
  }

  o.result(rep);
  printBatchSummary(o, rep);
  return ExitCode.OK;
}
