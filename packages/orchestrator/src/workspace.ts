import { assertSafeId, CreatorFlowError, ExitCode, resolveWithin } from "@creatorflow/core";
import { WeekId } from "@creatorflow/schemas";

/** All workflow paths derive from here, so every path is checked against the workspace. */
export interface WorkflowPaths {
  workspaceDir: string;
  jobsDir: string;
  plansDir: string;
  logsDir: string;
  jobDir(jobId: string): string;
  jobFile(jobId: string): string;
  jobBackup(jobId: string): string;
  jobLock(jobId: string): string;
  weekDir(weekId: string): string;
  planIndex(weekId: string): string;
  planVersion(weekId: string, version: number): string;
  planLock(weekId: string): string;
}

export function assertWeekId(weekId: string): string {
  if (!WeekId.safeParse(weekId).success) {
    throw new CreatorFlowError(`Invalid week id "${weekId}".`, {
      code: "WEEK_INVALID",
      hint: "Use an ISO week such as 2026-W44.",
      exitCode: ExitCode.USAGE,
    });
  }
  return weekId;
}

/** Stable, deterministic job id: derived only from the week and the plan's persisted content id. */
export function jobIdFor(weekId: string, contentId: string): string {
  return assertSafeId(`${assertWeekId(weekId).toLowerCase()}-${contentId}`, "job id");
}

export const versionFileName = (version: number): string => `v${String(version).padStart(4, "0")}.json`;

export function workflowPaths(workspaceDir: string): WorkflowPaths {
  const ws = resolveWithin(workspaceDir, ".");
  const jobsDir = resolveWithin(ws, "jobs");
  const plansDir = resolveWithin(ws, "plans");
  const jobDir = (id: string) => resolveWithin(jobsDir, assertSafeId(id, "job id"));
  const weekDir = (w: string) => resolveWithin(plansDir, assertWeekId(w));
  return {
    workspaceDir: ws,
    jobsDir,
    plansDir,
    logsDir: resolveWithin(ws, "logs"),
    jobDir,
    jobFile: (id) => resolveWithin(jobDir(id), "job.json"),
    jobBackup: (id) => resolveWithin(jobDir(id), "job.prev.json"),
    jobLock: (id) => resolveWithin(jobDir(id), "job.lock"),
    weekDir,
    planIndex: (w) => resolveWithin(weekDir(w), "index.json"),
    planVersion: (w, v) => {
      if (!Number.isInteger(v) || v < 1) throw new CreatorFlowError(`Invalid plan version "${v}".`, { code: "VERSION_INVALID", exitCode: ExitCode.USAGE });
      return resolveWithin(weekDir(w), versionFileName(v));
    },
    planLock: (w) => resolveWithin(weekDir(w), "plan.lock"),
  };
}
