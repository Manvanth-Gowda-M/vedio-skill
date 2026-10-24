import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId, CreatorFlowError, ExitCode, resolveWithin, sha256File, type ExitCodeValue } from "@creatorflow/core";
import { JobStore, resumeWorkflow, weekFromJobId, workflowPaths, type Pipeline } from "@creatorflow/orchestrator";
import { exportPackage, PACKAGE_OUTPUTS, verifyPackage } from "@creatorflow/qa";
import { validateArtifact, PackageManifestSchema } from "@creatorflow/schemas";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

async function ctxOf(dir: string, jobId: string) {
  assertSafeId(jobId, "job id");
  const project = await requireProject(dir);
  const paths = workflowPaths(resolveWithin(project.paths.dir, project.config.workspaceDir));
  const l = await new JobStore(paths).load(jobId);
  if (l.status === "missing") {
    throw new CreatorFlowError(`Job ${jobId} does not exist.`, {
      code: "JOB_NOT_FOUND",
      hint: "Run `creatorflow status` to list job ids.",
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  if (l.status === "corrupt") {
    throw new CreatorFlowError(`Job ${jobId} has a corrupt record.`, {
      code: "JOB_CORRUPT",
      hint: "Run `creatorflow resume` to recover it.",
      exitCode: ExitCode.CHECK_FAILED,
    });
  }
  return { project, paths, job: l.job, dir: paths.jobDir(jobId) };
}

// ------------------------------------------------------------------ package run

export async function packageRunCommand(
  o: Output,
  dir: string,
  pipeline: Pipeline,
  f: { job: string; force?: boolean; retryFailed?: boolean },
): Promise<ExitCodeValue> {
  const { project, paths } = await ctxOf(dir, f.job);
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);

  let rep;
  try {
    rep = await resumeWorkflow({
      paths,
      pipeline,
      profile: project.profile,
      config: project.config,
      jobId: f.job,
      ...(weekFromJobId(f.job) ? { weekId: weekFromJobId(f.job)! } : {}),
      signal: ac.signal,
      stopAfter: "package",
      ...(f.force ? { forceSteps: new Set(["package"]) } : {}),
      ...(f.retryFailed ? { retryFailed: true } : {}),
    });
  } finally {
    process.off("SIGINT", onSigint);
  }

  const outcome = rep.jobs[0]!;
  if (outcome.result === "cancelled") return ExitCode.INTERRUPTED;
  if (outcome.result === "locked") {
    o.result({ ok: false, error: "LOCK_HELD", message: outcome.message });
    o.warn(outcome.message ?? "job is locked");
    return ExitCode.CONFLICT;
  }

  const { job, dir: jdir } = await ctxOf(dir, f.job);
  const packageDir = path.join(jdir, "package");
  const verification = await verifyPackage(packageDir);
  const passed = verification.ok && job.state === "PACKAGE_READY";

  o.result({
    ok: passed,
    ran: outcome.stepsRun.includes("package") ? "now" : "reused",
    state: job.state,
    blocked: job.blocked ?? null,
    failure: job.failure ?? null,
    verified: verification.ok,
    issues: verification.issues,
    manifest: verification.manifest ?? null,
    fileCount: verification.fileCount ?? 0,
    totalBytes: verification.totalBytes ?? 0,
  });

  o.line(
    `${f.job}: state ${job.state}${job.blocked ? ` (blocked at ${job.blocked.step}: ${job.blocked.code})` : ""}${
      job.failure ? ` (failed at ${job.failure.step}: ${job.failure.code})` : ""
    }; steps run: ${outcome.stepsRun.join(", ") || "none"}`,
  );

  if (passed && verification.manifest) {
    const m = verification.manifest;
    o.line(`  Package created: ${verification.fileCount} files, ${verification.totalBytes} bytes in package/`);
    o.line(`  Delivery status: ${m.delivery.status}; QA: ${m.qa.technicalQa}; Review: ${m.review.status}`);
  } else if (job.blocked) {
    o.line(`  Blocked: ${job.blocked.reason}`);
  } else if (job.failure) {
    o.line(`  Failed: ${job.failure.message}`);
  } else if (!verification.ok) {
    o.warn(`  Package verification issues: ${verification.issues.join("; ")}`);
  }

  return passed ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

// ------------------------------------------------------------------ package show

export async function packageShowCommand(o: Output, dir: string, f: { job: string }): Promise<ExitCodeValue> {
  const { job, dir: jdir } = await ctxOf(dir, f.job);
  const packageDir = path.join(jdir, "package");
  const verification = await verifyPackage(packageDir);

  if (!verification.manifest) {
    o.result({
      ok: false,
      state: job.state,
      error: "PACKAGE_NOT_FOUND",
      message: `No valid package found for job ${f.job}.`,
      issues: verification.issues,
    });
    o.warn(`Job ${f.job} has no package yet (current state: ${job.state}).`);
    return ExitCode.NOT_FOUND;
  }

  const m = verification.manifest;
  o.result({
    ok: verification.ok,
    state: job.state,
    verified: verification.ok,
    manifest: m,
    fileCount: verification.fileCount,
    totalBytes: verification.totalBytes,
    issues: verification.issues,
  });

  o.line(`Package for ${f.job} (state: ${job.state}, packaged ${m.packagedAt})`);
  o.line(`  Plan: ${m.weekId} v${m.plan.version} (${m.plan.planHash.slice(0, 16)})`);
  o.line(`  Technical QA: ${m.qa.technicalQa.toUpperCase()} (${m.qa.reportSha256.slice(0, 16)})`);
  const reviewDetail = m.review.status === "approved" ? `approved by ${m.review.by} on ${m.review.at}` : `not required: ${m.review.reason}`;
  o.line(`  Human review: ${m.review.status.toUpperCase()} (${reviewDetail})`);
  o.line(`  Files (${m.files.length} items, ${verification.totalBytes} bytes):`);
  for (const file of m.files) {
    o.line(`    - ${file.path.padEnd(28)} [${file.role.padEnd(14)}] ${String(file.bytes).padStart(8)} B  ${file.sha256.slice(0, 20)}…`);
  }
  if (m.omissions.length > 0) {
    o.line("  Omissions:");
    for (const om of m.omissions) {
      o.line(`    - ${om.role}: ${om.reason}`);
    }
  }

  if (!verification.ok) {
    o.warn(`  Integrity verification warnings: ${verification.issues.join("; ")}`);
  }

  return verification.ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

// ------------------------------------------------------------------ package verify

export async function packageVerifyCommand(
  o: Output,
  dir: string,
  f: { job?: string; path?: string },
): Promise<ExitCodeValue> {
  let packageDir: string;
  let label: string;

  if (f.path) {
    packageDir = path.isAbsolute(f.path) ? f.path : resolveWithin(dir, f.path);
    label = f.path;
  } else if (f.job) {
    const { dir: jdir } = await ctxOf(dir, f.job);
    packageDir = path.join(jdir, "package");
    label = `job ${f.job}`;
  } else {
    throw new CreatorFlowError("Either --job <id> or --path <dir> is required for package verification.", {
      code: "USAGE",
      exitCode: ExitCode.USAGE,
    });
  }

  const v = await verifyPackage(packageDir);
  o.result({
    ok: v.ok,
    verified: v.ok,
    fileCount: v.fileCount ?? 0,
    totalBytes: v.totalBytes ?? 0,
    issues: v.issues,
    manifest: v.manifest ?? null,
  });

  if (v.ok && v.manifest) {
    o.line(`Package verification PASSED for ${label}.`);
    o.line(`  ${v.fileCount} file(s), ${v.totalBytes} bytes independently verified against manifest hashes and sizes.`);
    o.line(`  QA: ${v.manifest.qa.technicalQa}; Review: ${v.manifest.review.status}`);
    return ExitCode.OK;
  } else {
    o.warn(`Package verification FAILED for ${label}:`);
    for (const issue of v.issues) {
      o.warn(`  - ${issue}`);
    }
    return ExitCode.CHECK_FAILED;
  }
}

// ------------------------------------------------------------------ package export

export async function packageExportCommand(
  o: Output,
  dir: string,
  f: { job: string; out: string },
): Promise<ExitCodeValue> {
  const { dir: jdir } = await ctxOf(dir, f.job);
  const packageDir = path.join(jdir, "package");
  const outPath = path.isAbsolute(f.out) ? f.out : resolveWithin(dir, f.out);

  const res = await exportPackage(packageDir, outPath);

  o.result({
    ok: true,
    jobId: f.job,
    type: res.type,
    outPath: res.outPath,
    files: res.files,
    bytes: res.bytes,
  });

  o.line(`Package for ${f.job} exported as ${res.type.toUpperCase()}:`);
  o.line(`  Destination: ${res.outPath}`);
  o.line(`  Contents: ${res.files} file(s), ${res.bytes} bytes total.`);

  return ExitCode.OK;
}
