import { z } from "zod";
import { RelativePath, Slug } from "./common.ts";

export const QA_SCHEMA_VERSION = 1 as const;

const Fp = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected sha256:<64 hex>");
const IsoDT = z.iso.datetime({ offset: true });

/**
 * Per-check result:
 * - PASS / FAIL: an objective measurement was made and met / did not meet its criterion.
 * - BLOCKED: the check could not run because required evidence is missing, stale or inconsistent.
 * - NOT_INSPECTED: the check could not run because a tool or capability is unavailable.
 * - NEEDS_REVIEW: no reliable automated verdict; a human must look (evidence attached).
 * - NOT_APPLICABLE: the check does not apply to this job (e.g. audio speech in a silent video).
 */
export const QaCheckStatus = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_INSPECTED", "NEEDS_REVIEW", "NOT_APPLICABLE"]);
export type QaCheckStatus = z.infer<typeof QaCheckStatus>;

export const QaCheckSchema = z.strictObject({
  id: z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/),
  category: z.enum(["file", "video", "audio", "captions", "visual", "content", "provenance"]),
  title: z.string(),
  /** Required checks decide the technical QA verdict; optional ones only add warnings/review items. */
  required: z.boolean(),
  /** objective: a measurement with a pass criterion; heuristic: a measurement that can miss problems. */
  method: z.enum(["objective", "heuristic", "human"]),
  status: QaCheckStatus,
  detail: z.string().max(4000),
  evidence: z.array(z.string().max(500)).max(50).optional(),
});
export type QaCheck = z.infer<typeof QaCheckSchema>;

export const FrameSampleSchema = z.strictObject({
  frame: z.int().min(0),
  timeSec: z.number().min(0),
  sceneId: z.string(),
  purpose: z.enum(["start", "middle", "end", "scene-mid", "scene-start", "interval"]),
  /** Entrance/exit animations may legitimately show an empty background. */
  blankAllowed: z.boolean(),
  activeCueId: z.string().nullable(),
  /** Relative to the job directory. */
  path: RelativePath,
  sha256: Fp,
  width: z.int(),
  height: z.int(),
  metrics: z.strictObject({
    lumaMean: z.number(),
    lumaStdDev: z.number(),
    uniformFraction: z.number(),
    blank: z.boolean(),
    marginForeground: z.int().min(0),
    edgeForeground: z.int().min(0),
    captionBox: z.strictObject({ top: z.int(), bottom: z.int(), left: z.int(), right: z.int(), pixels: z.int() }).nullable(),
    captionContrast: z.number().nullable(),
  }),
});
export type FrameSample = z.infer<typeof FrameSampleSchema>;

export const ToolInfoSchema = z.strictObject({ name: z.string(), version: z.string(), source: z.string() });

export const QaReportSchema = z
  .strictObject({
    schemaVersion: z.literal(QA_SCHEMA_VERSION),
    kind: z.literal("qa-report"),
    qaVersion: z.string(),
    jobId: Slug,
    contentId: Slug,
    plan: z.strictObject({ weekId: z.string(), version: z.int().min(1), contentHash: Fp }),
    render: z.strictObject({ reportPath: RelativePath, reportSha256: Fp, outputPath: RelativePath, outputSha256: Fp, outputBytes: z.int().min(0) }),
    /** Real execution clock; the only timestamps in the report. */
    inspectedAt: IsoDT,
    tools: z.array(ToolInfoSchema),
    media: z.strictObject({
      container: z.strictObject({ ok: z.boolean(), boxes: z.array(z.string()), problem: z.string().optional() }),
      video: z.strictObject({ codec: z.string(), width: z.int(), height: z.int(), fps: z.number(), frames: z.int().nullable(), durationSec: z.number(), pixelFormat: z.string().optional() }).nullable(),
      decodedFrames: z.int().nullable(),
      audioStreams: z.int().nullable(),
      audio: z.strictObject({ codec: z.string(), sampleRate: z.int().nullable(), channels: z.int().nullable(), durationSec: z.number().nullable(), decodedDurationSec: z.number().nullable(), peakDbfs: z.number().nullable(), rmsDbfs: z.number().nullable(), clippedSamples: z.int().nullable() }).nullable(),
    }),
    frames: z.strictObject({ dir: RelativePath, samples: z.array(FrameSampleSchema) }),
    captions: z.strictObject({ track: z.string(), timing: z.enum(["estimated", "sentence-aligned", "word-aligned"]), cues: z.int().min(0), burnedIn: z.boolean() }),
    checks: z.array(QaCheckSchema).min(1),
    summary: z.record(QaCheckStatus, z.int().min(0)),
    reviewItems: z.array(z.strictObject({ id: z.string(), topic: z.string(), question: z.string(), evidence: z.array(z.string()) })),
    technicalQa: z.strictObject({ status: z.enum(["passed", "failed", "blocked"]), reasons: z.array(z.string()) }),
    humanReview: z.strictObject({ required: z.boolean(), status: z.enum(["pending", "not-required"]) }),
    deliveryReadiness: z.strictObject({ status: z.enum(["blocked", "ready-for-packaging"]), blockers: z.array(z.string()) }),
    limitations: z.array(z.string()),
    performance: z.strictObject({ totalMs: z.int().min(0), decodeMs: z.int().min(0), framesMs: z.int().min(0), nodeRssPeakMb: z.number().min(0) }),
  })
  .superRefine((r, ctx) => {
    const req = r.checks.filter((c) => c.required);
    const bad = req.filter((c) => c.status === "FAIL");
    const missing = req.filter((c) => c.status === "BLOCKED" || c.status === "NOT_INSPECTED");
    const expected = bad.length ? "failed" : missing.length ? "blocked" : "passed";
    if (r.technicalQa.status !== expected) ctx.addIssue({ code: "custom", path: ["technicalQa", "status"], message: `must be "${expected}" given the required checks` });
    if (r.deliveryReadiness.status === "ready-for-packaging" && (r.technicalQa.status !== "passed" || r.humanReview.status === "pending")) ctx.addIssue({ code: "custom", path: ["deliveryReadiness"], message: "cannot be ready without passed QA and completed review" });
  });
export type QaReport = z.infer<typeof QaReportSchema>;

/** qa/review-manifest.json: what a human reviewer should look at. A file, not an interactive tool. */
export const ReviewManifestSchema = z.strictObject({
  schemaVersion: z.literal(QA_SCHEMA_VERSION),
  kind: z.literal("qa-review-manifest"),
  jobId: Slug,
  qaReport: z.strictObject({ path: RelativePath, sha256: Fp }),
  video: z.strictObject({ path: RelativePath, sha256: Fp }),
  technicalQa: z.enum(["passed", "failed", "blocked"]),
  frames: z.array(z.strictObject({ path: RelativePath, sha256: Fp, frame: z.int(), timeSec: z.number(), sceneId: z.string(), purpose: z.string(), sceneText: z.string(), captionLines: z.array(z.string()) })),
  scenes: z.array(z.strictObject({ sceneId: z.string(), type: z.string(), startSec: z.number(), endSec: z.number(), primary: z.string(), secondary: z.string().optional(), assets: z.array(z.string()) })),
  items: z.array(z.strictObject({ id: z.string(), topic: z.string(), question: z.string(), evidence: z.array(z.string()) })),
  warnings: z.array(z.string()),
  instructions: z.string(),
});
export type ReviewManifest = z.infer<typeof ReviewManifestSchema>;

/** review/decision.json: written only by `creatorflow review approve|reject` on a human's instruction. */
export const ReviewDecisionSchema = z.strictObject({
  schemaVersion: z.literal(QA_SCHEMA_VERSION),
  kind: z.literal("review-decision"),
  jobId: Slug,
  qaReportSha256: Fp,
  reviewManifestSha256: Fp,
  videoSha256: Fp,
  decision: z.enum(["approved", "rejected"]),
  by: z.string().min(1).max(120),
  at: IsoDT,
  note: z.string().max(2000).optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/** review/record.json: output of the review step. */
export const ReviewRecordSchema = z.strictObject({
  schemaVersion: z.literal(QA_SCHEMA_VERSION),
  kind: z.literal("review-record"),
  jobId: Slug,
  qaReport: z.strictObject({ path: RelativePath, sha256: Fp }),
  video: z.strictObject({ path: RelativePath, sha256: Fp }),
  review: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("approved"), by: z.string(), at: IsoDT, note: z.string().optional(), decisionSha256: Fp }),
    z.strictObject({ status: z.literal("not-required"), reason: z.string() }),
  ]),
  deliveryReadiness: z.strictObject({ status: z.literal("ready-for-packaging"), notes: z.array(z.string()) }),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
