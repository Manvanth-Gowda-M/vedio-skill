import { promises as fs } from "node:fs";
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { CreatorFlowError, ExitCode, resolveWithin, sha256Hex, stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { readVerifiedOutput, StepError, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import { QaReportSchema, ReviewDecisionSchema, ReviewRecordSchema, validateArtifact, type ReviewDecision, type ReviewRecord } from "@creatorflow/schemas";
import { QA_OUTPUTS } from "./executor.ts";

export const REVIEW_OUTPUTS = { record: "review/record.json" } as const;
/** Written by `creatorflow review approve|reject`; an input of the review step, never an output. */
export const REVIEW_DECISION = "review/decision.json";
export const REVIEW_HISTORY = "review/decisions.jsonl";

export const reviewStepInputs = (ctx: FingerprintContext): unknown => ({ contentId: ctx.item.contentId });
export const reviewStepConfig = (ctx: FingerprintContext): unknown => ({ requireFinalReview: ctx.profile.approval.requireFinalReview });

/** The decision file's hash: a new decision (or a deleted one) re-runs the review step. */
export async function reviewStepExternalInputs(ctx: FingerprintContext & { workspaceDir: string }): Promise<unknown> {
  const raw = await fs.readFile(path.join(ctx.workspaceDir, "jobs", ctx.jobId, REVIEW_DECISION)).catch(() => undefined);
  return { decision: raw ? `sha256:${sha256Hex(raw)}` : null };
}

/**
 * Human review gate. Never decides anything itself: it reads a decision a person
 * recorded for exactly this QA report (hash-bound) and blocks until one exists.
 * The profile may waive review (approval.requireFinalReview = false); that is recorded.
 */
export async function reviewStepExecute(ctx: StepContext): Promise<StepResult> {
  const qr = await readVerifiedOutput(ctx, "qa", QA_OUTPUTS.report);
  const qm = await readVerifiedOutput(ctx, "qa", QA_OUTPUTS.reviewManifest);
  for (const r of [qr, qm]) if (!r.ok) return { status: "blocked", code: r.code, reason: r.reason };
  if (!qr.ok || !qm.ok) throw new Error("unreachable");
  const rv = validateArtifact(QaReportSchema, JSON.parse(qr.file.raw));
  if (!rv.ok) throw new StepError("qa/report.json is invalid", { kind: "permanent", code: "QA_REPORT_INVALID" });
  const report = rv.value;
  if (report.technicalQa.status !== "passed") return { status: "blocked", code: "QA_NOT_PASSED", reason: `technical QA is ${report.technicalQa.status}; nothing can be reviewed for delivery` };
  const base = { schemaVersion: 1 as const, kind: "review-record" as const, jobId: ctx.jobId, qaReport: { path: QA_OUTPUTS.report, sha256: qr.file.sha256 }, video: { path: report.render.outputPath, sha256: report.render.outputSha256 } };
  let record: ReviewRecord;
  if (!ctx.profile.approval.requireFinalReview) {
    record = { ...base, review: { status: "not-required", reason: "creator profile approval.requireFinalReview is false" }, deliveryReadiness: { status: "ready-for-packaging", notes: ["human review was waived by the profile", "packaging is not implemented yet (Stage I); nothing is published"] } };
  } else {
    const raw = await fs.readFile(ctx.outputPath(REVIEW_DECISION), "utf8").catch(() => undefined);
    const hint = `Review qa/review-manifest.json (${report.reviewItems.length} item(s)) and the frames in qa/frames/, then the reviewer runs: creatorflow review approve --job ${ctx.jobId} --qa-hash ${qr.file.sha256.slice(7, 23)} --by "<name>"`;
    if (raw === undefined) return { status: "blocked", code: "NEEDS_HUMAN_REVIEW", reason: hint };
    const dv = validateArtifact(ReviewDecisionSchema, JSON.parse(raw));
    if (!dv.ok) return { status: "blocked", code: "REVIEW_DECISION_INVALID", reason: `${REVIEW_DECISION} is invalid: ${dv.issues[0]?.message}` };
    const d = dv.value;
    if (d.qaReportSha256 !== qr.file.sha256 || d.reviewManifestSha256 !== qm.file.sha256 || d.videoSha256 !== report.render.outputSha256 || d.jobId !== ctx.jobId) return { status: "blocked", code: "REVIEW_STALE", reason: `the recorded ${d.decision} decision (${d.at}, ${d.by}) is for an earlier QA report or video; review the current one. ${hint}` };
    if (d.decision === "rejected") return { status: "blocked", code: "REVIEW_REJECTED", reason: `rejected by ${d.by} on ${d.at}${d.note ? `: ${d.note}` : ""}. Fix the issues (new assets, script or render), then QA and review again` };
    record = { ...base, review: { status: "approved", by: d.by, at: d.at, ...(d.note ? { note: d.note } : {}), decisionSha256: `sha256:${sha256Hex(raw)}` }, deliveryReadiness: { status: "ready-for-packaging", notes: ["approved by a human reviewer", "packaging is not implemented yet (Stage I); nothing is published"] } };
  }
  const v = validateArtifact(ReviewRecordSchema, record);
  if (!v.ok) throw new StepError(`review record invalid: ${v.issues[0]?.message}`, { kind: "permanent", code: "REVIEW_RECORD_INVALID" });
  await fs.mkdir(path.dirname(ctx.outputPath(REVIEW_OUTPUTS.record)), { recursive: true });
  await writeFileAtomic(ctx.outputPath(REVIEW_OUTPUTS.record), stringifyJson(v.value));
  return { status: "succeeded", metadata: { review: record.review.status } };
}

/** Records a human decision bound to the current QA report, manifest and video hashes. */
export async function recordReviewDecision(jobDir: string, d: Omit<ReviewDecision, "schemaVersion" | "kind">): Promise<ReviewDecision> {
  const decision: ReviewDecision = { schemaVersion: 1, kind: "review-decision", ...d };
  const v = validateArtifact(ReviewDecisionSchema, decision);
  if (!v.ok) throw new CreatorFlowError(`Invalid review decision: ${v.issues[0]?.path}: ${v.issues[0]?.message}`, { code: "USAGE", exitCode: ExitCode.USAGE });
  const file = resolveWithin(jobDir, REVIEW_DECISION);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, stringifyJson(v.value));
  await appendFile(resolveWithin(jobDir, REVIEW_HISTORY), `${JSON.stringify(v.value)}\n`);
  return v.value;
}
