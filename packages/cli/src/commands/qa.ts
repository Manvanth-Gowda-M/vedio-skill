import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeId, CreatorFlowError, ExitCode, resolveWithin, sha256File, type ExitCodeValue } from "@creatorflow/core";
import { JobStore, resumeWorkflow, weekFromJobId, workflowPaths, type Pipeline } from "@creatorflow/orchestrator";
import { QA_OUTPUTS, recordReviewDecision, REVIEW_DECISION, REVIEW_OUTPUTS } from "@creatorflow/qa";
import { QaReportSchema, ReviewDecisionSchema, ReviewManifestSchema, ReviewRecordSchema, validateArtifact, type JobRecord, type QaReport } from "@creatorflow/schemas";
import { RENDER_OUTPUTS } from "@creatorflow/video-engine";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

async function ctxOf(dir: string, jobId: string) {
  assertSafeId(jobId, "job id");
  const project = await requireProject(dir);
  const paths = workflowPaths(resolveWithin(project.paths.dir, project.config.workspaceDir));
  const l = await new JobStore(paths).load(jobId);
  if (l.status === "missing") throw new CreatorFlowError(`Job ${jobId} does not exist.`, { code: "JOB_NOT_FOUND", hint: "Run `creatorflow status` to list job ids.", exitCode: ExitCode.NOT_FOUND });
  if (l.status === "corrupt") throw new CreatorFlowError(`Job ${jobId} has a corrupt record.`, { code: "JOB_CORRUPT", hint: "Run `creatorflow resume` to recover it.", exitCode: ExitCode.CHECK_FAILED });
  return { project, paths, job: l.job, dir: paths.jobDir(jobId) };
}

/** Recorded outputs of a step whose files still hash to the recorded values. */
async function verifiedOutputs(dir: string, job: JobRecord, step: string): Promise<Map<string, string> | undefined> {
  const rec = job.steps[step];
  if (rec?.status !== "succeeded") return undefined;
  const out = new Map<string, string>();
  for (const o of rec.outputs) {
    const h = await sha256File(path.join(dir, o.path)).catch(() => undefined);
    if (h?.sha256 !== o.sha256) return undefined;
    out.set(o.path, o.sha256);
  }
  return out;
}

export interface QaState {
  /** "verified": the QA step's recorded output for the current render; "unverified": a report left by a failed/blocked attempt. */
  source: "verified" | "unverified" | "none";
  report?: QaReport;
  reportSha256?: string;
  /** The report describes a different MP4 than the current verified render. */
  stale: boolean;
  renderSha256?: string;
}

export async function readQaState(dir: string, job: JobRecord): Promise<QaState> {
  const render = await verifiedOutputs(dir, job, "render");
  const renderSha256 = render?.get(RENDER_OUTPUTS.video);
  const qa = await verifiedOutputs(dir, job, "qa");
  const raw = await fs.readFile(path.join(dir, QA_OUTPUTS.report), "utf8").catch(() => undefined);
  if (raw === undefined) return { source: "none", stale: false, ...(renderSha256 ? { renderSha256 } : {}) };
  const v = validateArtifact(QaReportSchema, JSON.parse(raw));
  if (!v.ok) return { source: "none", stale: false, ...(renderSha256 ? { renderSha256 } : {}) };
  const sha = (await sha256File(path.join(dir, QA_OUTPUTS.report))).sha256;
  const source = qa?.get(QA_OUTPUTS.report) === sha ? "verified" : "unverified";
  return { source, report: v.value, reportSha256: sha, stale: !renderSha256 || v.value.render.outputSha256 !== renderSha256, ...(renderSha256 ? { renderSha256 } : {}) };
}

function printReport(o: Output, s: QaState, failedOnly = false): void {
  const r = s.report!;
  const label = s.source === "verified" ? "verified" : "UNVERIFIED (left by a failed or blocked QA attempt)";
  o.line(`QA report (${label}${s.stale ? ", STALE: it describes a different video than the current render" : ""}) ${s.reportSha256?.slice(0, 23)}…  ${r.qaVersion}, inspected ${r.inspectedAt}`);
  o.line(`  technical QA: ${r.technicalQa.status.toUpperCase()}   human review: ${r.humanReview.status}   delivery: ${r.deliveryReadiness.status}${r.deliveryReadiness.blockers.length ? ` (${r.deliveryReadiness.blockers.join("; ")})` : ""}`);
  o.line(`  checks: ${Object.entries(r.summary).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  for (const c of r.checks) {
    if (failedOnly && c.status === "PASS") continue;
    o.line(`  ${c.status.padEnd(14)} ${c.id.padEnd(24)} ${c.required ? "required" : "optional"}  ${c.detail.slice(0, 220)}`);
  }
  o.line(`  media: ${r.media.video ? `${r.media.video.codec} ${r.media.video.width}x${r.media.video.height} ${r.media.video.fps} fps, ${r.media.decodedFrames ?? "?"} frames decoded` : "not inspected"}; audio streams ${r.media.audioStreams ?? "?"}${r.media.audio ? ` (${r.media.audio.codec}, decoded ${r.media.audio.decodedDurationSec ?? "?"}s, peak ${r.media.audio.peakDbfs ?? "?"} dBFS)` : ""}`);
  o.line(`  frames: ${r.frames.samples.length} in ${r.frames.dir}/; captions ${r.captions.timing}, ${r.captions.cues} cues; ${r.reviewItems.length} human review item(s); QA took ${Math.round(r.performance.totalMs / 1000)}s`);
}

// ------------------------------------------------------------------ qa run / show

export async function qaRunCommand(o: Output, dir: string, pipeline: Pipeline, f: { job: string; force?: boolean; retryFailed?: boolean }): Promise<ExitCodeValue> {
  const { project, paths } = await ctxOf(dir, f.job);
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  let rep;
  try {
    rep = await resumeWorkflow({ paths, pipeline, profile: project.profile, config: project.config, jobId: f.job, ...(weekFromJobId(f.job) ? { weekId: weekFromJobId(f.job)! } : {}), signal: ac.signal, stopAfter: "qa", ...(f.force ? { forceSteps: new Set(["qa"]) } : {}), ...(f.retryFailed ? { retryFailed: true } : {}) });
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
  const s = await readQaState(jdir, job);
  const passed = s.source === "verified" && !s.stale && s.report?.technicalQa.status === "passed";
  o.result({ ok: passed, ran: outcome.stepsRun.includes("qa") ? "now" : "reused", state: job.state, blocked: job.blocked ?? null, failure: job.failure ?? null, renderedNow: outcome.stepsRun.includes("render"), qa: s.report ?? null, qaReportSha256: s.reportSha256 ?? null, source: s.source, stale: s.stale });
  o.line(`${f.job}: state ${job.state}${job.blocked ? ` (blocked at ${job.blocked.step}: ${job.blocked.code})` : ""}${job.failure ? ` (failed at ${job.failure.step}: ${job.failure.code})` : ""}; steps run: ${outcome.stepsRun.join(", ") || "none"}`);
  if (s.report && !(s.stale && s.source !== "verified")) printReport(o, s, true);
  else if (outcome.message) o.line(`  ${outcome.message}`);
  if (passed) o.line(`  Next: a human reviews qa/review-manifest.json, then \`creatorflow review approve --job ${f.job} --qa-hash ${s.reportSha256!.slice(7, 23)} --by "<name>"\`. Nothing is published.`);
  return passed ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

export async function qaShowCommand(o: Output, dir: string, f: { job: string; all?: boolean }): Promise<ExitCodeValue> {
  const { job, dir: jdir } = await ctxOf(dir, f.job);
  const s = await readQaState(jdir, job);
  const passed = s.source === "verified" && !s.stale && s.report?.technicalQa.status === "passed";
  o.result({ ok: passed, jobId: job.jobId, state: job.state, qaStep: job.steps["qa"]?.status ?? "not started", source: s.source, stale: s.stale, qaReportSha256: s.reportSha256 ?? null, report: s.report ?? null, blocked: job.blocked ?? null, failure: job.failure ?? null });
  o.line(`${job.jobId}: state ${job.state}; qa step ${job.steps["qa"]?.status ?? "not started"}${job.blocked ? ` — blocked at ${job.blocked.step}: ${job.blocked.code}: ${job.blocked.reason.slice(0, 300)}` : ""}${job.failure ? ` — failed at ${job.failure.step}: ${job.failure.code}` : ""}`);
  if (!s.report) {
    o.line("  No QA report exists yet. Run `creatorflow qa run --job <id>`.");
    return ExitCode.CHECK_FAILED;
  }
  printReport(o, s, !f.all);
  if (s.report.reviewItems.length) {
    o.line("  Human review items (answer them before `review approve`):");
    for (const i of s.report.reviewItems.slice(0, f.all ? 100 : 12)) o.line(`    - [${i.topic}] ${i.question.slice(0, 240)}`);
  }
  return passed ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

// ------------------------------------------------------------------ review

export async function reviewShowCommand(o: Output, dir: string, f: { job: string }): Promise<ExitCodeValue> {
  const { project, job, dir: jdir } = await ctxOf(dir, f.job);
  const s = await readQaState(jdir, job);
  const manifestRaw = await fs.readFile(path.join(jdir, QA_OUTPUTS.reviewManifest), "utf8").catch(() => undefined);
  const manifest = manifestRaw ? validateArtifact(ReviewManifestSchema, JSON.parse(manifestRaw)) : undefined;
  const decRaw = await fs.readFile(path.join(jdir, REVIEW_DECISION), "utf8").catch(() => undefined);
  const dec = decRaw ? validateArtifact(ReviewDecisionSchema, JSON.parse(decRaw)) : undefined;
  const reviewOut = await verifiedOutputs(jdir, job, "review");
  const recRaw = reviewOut ? await fs.readFile(path.join(jdir, REVIEW_OUTPUTS.record), "utf8") : undefined;
  const rec = recRaw ? validateArtifact(ReviewRecordSchema, JSON.parse(recRaw)) : undefined;
  const decision = dec?.ok ? dec.value : null;
  const current = decision && s.reportSha256 === decision.qaReportSha256 && s.source === "verified" && !s.stale;
  const status = rec?.ok ? rec.value.review.status : !project.profile.approval.requireFinalReview ? "not-required" : decision ? (current ? decision.decision : "stale-decision") : "pending";
  const ready = rec?.ok ? rec.value.deliveryReadiness.status : "blocked";
  o.result({ ok: ready === "ready-for-packaging", jobId: job.jobId, state: job.state, review: status, decision, record: rec?.ok ? rec.value : null, deliveryReadiness: ready, qaReportSha256: s.reportSha256 ?? null, qaSource: s.source, manifest: manifest?.ok ? manifest.value : null });
  o.line(`${job.jobId}: review ${status}; delivery readiness ${ready}${ready === "blocked" ? "" : " (packaging and publishing are not implemented; nothing is uploaded)"}`);
  if (!manifest?.ok) {
    o.line("  No review manifest yet: technical QA has not produced one. Run `creatorflow qa run --job <id>`.");
    return ExitCode.CHECK_FAILED;
  }
  const m = manifest.value;
  o.line(`  QA ${m.technicalQa}; video ${m.video.path} ${m.video.sha256.slice(0, 19)}…; ${m.frames.length} frames under qa/frames/ (open them in any image viewer; there is no review GUI)`);
  for (const i of m.items) o.line(`  - [${i.topic}] ${i.question.slice(0, 260)}${i.evidence.length ? ` (${i.evidence.length} evidence file(s))` : ""}`);
  if (decision) o.line(`  Recorded decision: ${decision.decision} by ${decision.by} at ${decision.at}${current ? "" : " — for an EARLIER QA report or video; it no longer applies"}`);
  if (status === "pending" || status === "stale-decision") o.line(`  ${m.instructions}`);
  return ready === "ready-for-packaging" ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

export async function reviewDecideCommand(o: Output, dir: string, f: { job: string; qaHash: string; by?: string; note?: string; decision: "approved" | "rejected" }): Promise<ExitCodeValue> {
  const { job, dir: jdir } = await ctxOf(dir, f.job);
  const s = await readQaState(jdir, job);
  if (s.source !== "verified" || s.stale || !s.report) throw new CreatorFlowError(`There is no verified, current QA report for ${f.job} to review.`, { code: "QA_NOT_VERIFIED", hint: `Run \`creatorflow qa run --job ${f.job}\` first.`, exitCode: ExitCode.CHECK_FAILED });
  if (s.report.technicalQa.status !== "passed") throw new CreatorFlowError(`Technical QA is ${s.report.technicalQa.status}; a failed or blocked video cannot be approved.`, { code: "QA_NOT_PASSED", exitCode: ExitCode.CHECK_FAILED });
  const want = f.qaHash.replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(want)) throw new CreatorFlowError("--qa-hash must be at least 12 hex characters of the QA report hash.", { code: "USAGE", exitCode: ExitCode.USAGE });
  if (!s.reportSha256!.slice(7).startsWith(want)) throw new CreatorFlowError(`--qa-hash does not match the current QA report (${s.reportSha256!.slice(0, 23)}…). The video or its QA changed; review the current report.`, { code: "QA_HASH_MISMATCH", exitCode: ExitCode.CONFLICT });
  if (f.decision === "rejected" && !f.note) throw new CreatorFlowError("A rejection needs --note explaining what must change.", { code: "USAGE", exitCode: ExitCode.USAGE });
  const manifest = await sha256File(path.join(jdir, QA_OUTPUTS.reviewManifest));
  const d = await recordReviewDecision(jdir, { jobId: job.jobId, qaReportSha256: s.reportSha256!, reviewManifestSha256: manifest.sha256, videoSha256: s.report.render.outputSha256, decision: f.decision, by: f.by ?? os.userInfo().username, at: new Date().toISOString(), ...(f.note ? { note: f.note } : {}) });
  o.result({ ok: true, decision: d });
  o.line(`Recorded: ${d.decision} by ${d.by} for QA report ${d.qaReportSha256.slice(0, 23)}… (video ${d.videoSha256.slice(0, 19)}…).`);
  o.line(`Run \`creatorflow resume --job ${f.job}\` to apply it.${d.decision === "approved" ? " Approval marks the video ready for packaging only; nothing is published." : ""}`);
  return ExitCode.OK;
}
