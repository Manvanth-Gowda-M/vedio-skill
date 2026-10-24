import os from "node:os";
import path from "node:path";
import {
  createLogger,
  CreatorFlowError,
  envVarPresent,
  ExitCode,
  fileSink,
  readJsonFile,
  resolveWithin,
  type ExitCodeValue,
} from "@creatorflow/core";
import {
  buildStatus,
  PlanStore,
  resumeWorkflow,
  syncJobs,
  workflowPaths,
  assertWeekId,
  type JobStatus,
  type Pipeline,
  type PlanSummary,
  type ResumeReport,
  type StatusReport,
  type WorkflowPaths,
} from "@creatorflow/orchestrator";
import type { CreatorFlowConfig } from "@creatorflow/schemas";
import type { Output } from "../output.ts";
import { loadProject, requireProject } from "../project.ts";

async function requireConfig(dir: string): Promise<{ config: CreatorFlowConfig; paths: WorkflowPaths }> {
  const p = await loadProject(dir);
  if (!p.config.exists) {
    throw new CreatorFlowError(`Missing creatorflow.config.json in ${p.paths.dir}.`, {
      code: "PROJECT_NOT_INITIALIZED",
      hint: "Run `creatorflow init` first.",
      exitCode: ExitCode.CONFIG,
    });
  }
  if (!p.config.value) {
    throw new CreatorFlowError("creatorflow.config.json is invalid.", {
      code: "PROJECT_INVALID",
      hint: "Run `creatorflow profile validate` for details.",
      exitCode: ExitCode.CONFIG,
      details: p.config.issues,
    });
  }
  return { config: p.config.value, paths: workflowPaths(resolveWithin(p.paths.dir, p.config.value.workspaceDir)) };
}

async function resolveWeek(plans: PlanStore, week: string | undefined): Promise<string> {
  if (week) return assertWeekId(week);
  const latest = await plans.latestWeek();
  if (!latest) {
    throw new CreatorFlowError("No weekly plans found in the workspace.", {
      code: "PLAN_NOT_FOUND",
      hint: "Create one with `creatorflow plan add --file <plan.json>`.",
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  return latest;
}

const short = (hash: string) => `${hash.slice(0, 19)}…`;

function planHeadline(p: PlanSummary): string {
  if (p.approvedVersion !== undefined) return `plan v${p.approvedVersion} APPROVED`;
  if (p.effectiveVersion !== undefined) {
    const v = p.versions.find((x) => x.version === p.effectiveVersion)!;
    return v.state === "invalid" ? `plan v${v.version} INVALID (${v.integrityIssue})` : `plan v${v.version} AWAITING APPROVAL`;
  }
  return "no plan version awaiting production (all rejected)";
}

// ------------------------------------------------------------------ plan add

export async function planAddCommand(o: Output, dir: string, file: string): Promise<ExitCodeValue> {
  const { paths } = await requireConfig(dir);
  const data = await readJsonFile(path.resolve(file));
  const r = await new PlanStore(paths).addVersion(data);
  o.result({ ok: true, ...r });
  if (r.status === "unchanged") o.line(`Unchanged: content is identical to ${r.weekId} v${r.version}; no new version created.`);
  else o.line(`Created ${r.weekId} v${r.version}`);
  o.line(`  hash: ${r.contentHash}`);
  o.line(`Review it, then approve with:\n  creatorflow approve-plan --week ${r.weekId} --plan-version ${r.version} --hash ${r.contentHash}`);
  return ExitCode.OK;
}

// ------------------------------------------------------------------ approve-plan

export interface ApproveFlags {
  week?: string;
  planVersion: string;
  hash: string;
  by?: string;
  note?: string;
  reject?: boolean;
}

export async function approvePlanCommand(o: Output, dir: string, f: ApproveFlags): Promise<ExitCodeValue> {
  const version = Number(f.planVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new CreatorFlowError(`--plan-version must be a positive integer (got "${f.planVersion}").`, { code: "USAGE", exitCode: ExitCode.USAGE });
  }
  const { paths } = await requireConfig(dir);
  const plans = new PlanStore(paths);
  const weekId = await resolveWeek(plans, f.week);
  let by = f.by;
  if (!by) {
    try {
      by = os.userInfo().username || "local-user";
    } catch {
      by = "local-user";
    }
  }
  const r = await plans.decide({
    weekId,
    version,
    hash: f.hash,
    decision: f.reject ? "rejected" : "approved",
    by,
    ...(f.note ? { note: f.note } : {}),
  });
  let created: string[] = [];
  if (!f.reject) created = await syncJobs(paths, await plans.approvedPlan(weekId));
  o.result({ ok: true, status: r.status, event: r.event, createdJobs: created, plan: r.summary });
  const verb = f.reject ? "Rejected" : "Approved";
  o.line(r.status === "already" ? `${weekId} v${version} was already ${r.event.type}; nothing recorded.` : `${verb} ${weekId} v${version} (${short(r.event.contentHash)}) by ${r.event.by}`);
  if (created.length) o.line(`Created ${created.length} job record(s); run \`creatorflow resume\` to start production.`);
  if (!f.reject) o.line("Note: plan approval covers production only. Nothing is published automatically.");
  return ExitCode.OK;
}

// ------------------------------------------------------------------ status

function jobNote(j: JobStatus): string {
  const notes: string[] = [];
  if (j.corrupt) notes.push(`CORRUPT record (${j.corrupt.issues[0]?.path}: ${j.corrupt.issues[0]?.message}); backup ${j.corrupt.backup}`);
  if (j.runningPid) notes.push(`running (pid ${j.runningPid})`);
  if (j.staleLock) notes.push("stale lock from a dead process");
  if (j.blocked) notes.push(`blocked at ${j.blocked.step}: ${j.blocked.code}: ${j.blocked.reason}`);
  if (j.failure) notes.push(`failed at ${j.failure.step}: ${j.failure.code} (${j.failure.kind})`);
  if (!j.inApprovedPlan) notes.push("not in the approved plan");
  if (j.planCurrent === false) notes.push("plan item changed; re-evaluated on resume");
  if (j.staleSteps.length) notes.push(`re-check on resume: ${j.staleSteps.join(", ")}`);
  return notes.join("; ");
}

export async function statusCommand(o: Output, dir: string, pipeline: Pipeline, week?: string): Promise<ExitCodeValue> {
  const { paths } = await requireConfig(dir);
  const plans = new PlanStore(paths);
  const weekId = await resolveWeek(plans, week);
  const s: StatusReport = await buildStatus(paths, pipeline, weekId);
  const corrupt = s.jobs.filter((j) => j.corrupt).length;
  o.result({ ok: corrupt === 0, ...s });

  o.line(`Week ${s.weekId}: ${planHeadline(s.plan)}`);
  for (const v of s.plan.versions) {
    const d = v.lastDecision ? ` — ${v.lastDecision.type} by ${v.lastDecision.by} at ${v.lastDecision.at}` : "";
    o.line(`  v${v.version}  ${v.state.padEnd(10)} ${short(v.contentHash)}  ${v.itemCount} item(s)${d}${v.integrityIssue ? ` — ${v.integrityIssue}` : ""}`);
  }
  if (s.plan.unindexedFiles.length) o.line(`  unindexed version files (interrupted write, adopted on next plan write): ${s.plan.unindexedFiles.join(", ")}`);
  const counts = Object.entries(s.counts).map(([k, n]) => `${k} ${n}`).join(", ");
  o.line(`Jobs: ${s.jobs.length}${counts ? ` (${counts})` : ""}`);
  if (s.jobs.length === 0) o.line(s.plan.approvedVersion ? "  No job records yet. Run `creatorflow resume`." : "  No job records. Approve the plan first.");
  for (const j of s.jobs) {
    const state = j.corrupt ? "CORRUPT" : (j.state ?? "?");
    const note = jobNote(j);
    o.line(`  ${j.jobId.padEnd(40)} ${state.padEnd(13)} ${`${j.progress.verified}/${j.progress.total}`.padEnd(5)} next: ${(j.nextStep ?? "-").padEnd(12)}${note ? ` ${note}` : ""}`);
  }
  if (s.missingJobs.length) o.line(`  Not yet created: ${s.missingJobs.join(", ")}`);
  return corrupt ? ExitCode.CHECK_FAILED : ExitCode.OK;
}

// ------------------------------------------------------------------ resume

export interface ResumeFlags {
  week?: string;
  job?: string;
  retryFailed?: boolean;
  forceStep?: string[];
}

export async function resumeCommand(o: Output, dir: string, pipeline: Pipeline, f: ResumeFlags): Promise<ExitCodeValue> {
  const project = await requireProject(dir);
  const paths = workflowPaths(resolveWithin(project.paths.dir, project.config.workspaceDir));
  const unknown = (f.forceStep ?? []).filter((s) => !pipeline.steps.some((p) => p.id === s));
  if (unknown.length) {
    throw new CreatorFlowError(`Unknown step(s) for --force-step: ${unknown.join(", ")}.`, {
      code: "USAGE",
      hint: `Steps: ${pipeline.steps.map((s) => s.id).join(", ")}.`,
      exitCode: ExitCode.USAGE,
    });
  }
  const knownSecrets = Object.values(project.config.providers)
    .map((p) => p.apiKeyEnv)
    .filter((n): n is string => Boolean(n) && envVarPresent(n!))
    .map((n) => process.env[n]!);
  const logger = createLogger({ level: project.config.logging.level, sinks: [fileSink(path.join(paths.logsDir, "workflow.jsonl"))] });

  const ac = new AbortController();
  const onSigint = () => {
    o.warn("Interrupt received: finishing the current attempt record and stopping…");
    ac.abort();
  };
  process.once("SIGINT", onSigint);
  let report: ResumeReport;
  try {
    report = await resumeWorkflow({
      paths,
      pipeline,
      profile: project.profile,
      config: project.config,
      signal: ac.signal,
      logger,
      knownSecrets,
      ...(f.week ? { weekId: assertWeekId(f.week) } : {}),
      ...(f.job ? { jobId: f.job } : {}),
      ...(f.retryFailed ? { retryFailed: true } : {}),
      ...(f.forceStep?.length ? { forceSteps: new Set(f.forceStep) } : {}),
    });
  } finally {
    process.off("SIGINT", onSigint);
  }

  const s = report.summary;
  const code: ExitCodeValue = s.cancelled
    ? ExitCode.INTERRUPTED
    : s.locked
      ? ExitCode.CONFLICT
      : s.failed || s.blocked || s.corrupt
        ? ExitCode.CHECK_FAILED
        : ExitCode.OK;
  o.result({ ok: code === ExitCode.OK, ...report });
  o.line(`Resumed ${report.weekId} plan v${report.planVersion}: ${report.jobs.length} job(s)`);
  if (report.created.length) o.line(`  created ${report.created.length} new job record(s)`);
  for (const j of report.jobs) {
    const ran = j.stepsRun.length ? ` ran: ${j.stepsRun.join(", ")}` : "";
    const reused = j.stepsReused.length ? ` reused: ${j.stepsReused.join(", ")}` : "";
    o.line(`  [${j.result}] ${j.jobId} -> ${j.state ?? "?"}${ran}${reused}`);
    if (j.message) o.line(`      ${j.message}`);
    for (const n of j.notes) o.line(`      note: ${n}`);
  }
  o.line(Object.entries(s).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing to do");
  return code;
}
