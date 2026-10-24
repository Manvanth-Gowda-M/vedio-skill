import { z } from "zod";
import { LanguageTag, PlatformId, RelativePath, Slug } from "./common.ts";
import { ClaimKind, ClaimSupport } from "./research.ts";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

// ----------------------------------------------------------------- states

/** Lifecycle milestones in order. A job's state is the last *verified* milestone. */
export const LIFECYCLE_STATES = [
  "PLANNED",
  "RESEARCHED",
  "SCRIPTED",
  "LOCALIZED",
  /** Stage G: narration audio generated (or the job is explicitly silent) with its timing. */
  "NARRATED",
  "ASSETS_READY",
  "RENDER_QUEUED",
  "RENDERED",
  "QA_PASSED",
  /** Stage H: a human approved the QA'd video (or the profile does not require review). */
  "REVIEWED",
  "PACKAGE_READY",
] as const;
export const VideoState = z.enum([...LIFECYCLE_STATES, "BLOCKED", "FAILED"]);
export type VideoState = z.infer<typeof VideoState>;
export const LifecycleState = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof LifecycleState>;

// ----------------------------------------------------------------- shared

export const Fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected sha256:<64 hex>");
export const IsoDateTime = z.iso.datetime({ offset: true });
export const WeekId = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, "Expected an ISO week such as 2026-W44");
export const StepId = Slug;

/** Monday (UTC date) of an ISO week id, e.g. 2026-W44 -> 2026-10-26. */
export function isoWeekMonday(weekId: string): Date {
  const [y, w] = weekId.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon=0
  return new Date(Date.UTC(y, 0, 4 - jan4Dow + (w - 1) * 7));
}

// ----------------------------------------------------------------- plans

export const ContentCategory = z.enum(["news", "explainer", "tutorial", "comparison", "experiment", "recap"]);

export const AspectRatio = z.enum(["9:16", "16:9", "1:1", "4:5"]);

/** Link from a plan item to the research it was planned from (verified by the research step). */
export const PlanItemResearchSchema = z.strictObject({
  sessionId: Slug,
  candidateId: z.string().regex(/^cand-[a-z0-9-]+$/),
  scoringModel: z.string().min(1),
  score: z.number().min(0).max(100),
  eligibility: z.literal("eligible"),
  /** fingerprint of the candidate, claim and source records the item relies on. */
  evidenceHash: Fingerprint,
  sources: z.array(z.strictObject({ sourceId: z.string(), contentHash: Fingerprint })).min(1),
  claims: z.array(z.strictObject({ claimId: z.string(), kind: ClaimKind, support: ClaimSupport })).min(1),
});

/** Monday-based ISO week id of a calendar date (YYYY-MM-DD). */
export function isoWeekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d.getTime() + (3 - dow) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * One planned video. Only *content* lives here: production status (script,
 * storyboard, approval) is runtime state tracked in job records and the plan
 * index, so status changes never alter the plan hash.
 */
export const PlanItemSchema = z.strictObject({
  contentId: Slug.max(60),
  publishDate: z.iso.date(),
  topic: z.string().min(3).max(200),
  audienceProblem: z.string().min(3).max(500).optional(),
  rationale: z.string().min(3).max(1000).optional(),
  angle: z.string().min(3).max(500).optional(),
  /** Research record IDs (Stage D). Empty means unresearched, which later stages flag. */
  sourceIds: z.array(z.string().min(1)).default([]),
  hook: z.string().min(3).max(300).optional(),
  takeaway: z.string().min(3).max(300).optional(),
  category: ContentCategory,
  platform: PlatformId,
  language: LanguageTag,
  durationSec: z.int().min(5).max(7200),
  requiredAssets: z.array(z.string().min(1)).default([]),
  estimatedEffort: z.enum(["low", "medium", "high"]).optional(),
  qualityRequirements: z.array(z.string().min(1)).default([]),
  // ---- Stage D fields. Optional WITHOUT defaults so content hashes of earlier plans are unchanged.
  workingTitle: z.string().min(3).max(150).optional(),
  aspectRatio: AspectRatio.optional(),
  /** Present when the item was planned from a research session. */
  research: PlanItemResearchSchema.optional(),
  scriptRequirements: z.array(z.string().min(1).max(300)).max(20).optional(),
  caveats: z.array(z.string().min(1).max(500)).max(30).optional(),
  openQuestions: z.array(z.string().min(1).max(500)).max(30).optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const WeeklyPlanContentSchema = z
  .strictObject({
    $schema: z.string().optional(),
    weekId: WeekId,
    items: z.array(PlanItemSchema).min(1).max(14),
    notes: z.string().max(4000).optional(),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    const monday = isoWeekMonday(plan.weekId).getTime();
    plan.items.forEach((item, i) => {
      if (seen.has(item.contentId)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "contentId"], message: `Duplicate contentId "${item.contentId}"` });
      }
      seen.add(item.contentId);
      const day = Date.parse(`${item.publishDate}T00:00:00Z`);
      if (day < monday || day >= monday + 7 * 86_400_000) {
        ctx.addIssue({ code: "custom", path: ["items", i, "publishDate"], message: `Date is outside ${plan.weekId}` });
      }
    });
  });
export type WeeklyPlanContent = z.infer<typeof WeeklyPlanContentSchema>;
export type WeeklyPlanContentInput = z.input<typeof WeeklyPlanContentSchema>;

/** Immutable file plans/<week>/vNNNN.json. */
export const PlanVersionSchema = z.strictObject({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  kind: z.literal("weekly-plan-version"),
  weekId: WeekId,
  version: z.int().min(1),
  createdAt: IsoDateTime,
  /** fingerprint() of the normalised `content` (without $schema). */
  contentHash: Fingerprint,
  content: WeeklyPlanContentSchema,
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const PlanEventSchema = z.strictObject({
  type: z.enum(["approved", "rejected"]),
  version: z.int().min(1),
  contentHash: Fingerprint,
  at: IsoDateTime,
  by: z.string().min(1).max(120),
  note: z.string().max(1000).optional(),
});
export type PlanEvent = z.infer<typeof PlanEventSchema>;

/** plans/<week>/index.json: version list plus the append-only approval history. */
export const PlanIndexSchema = z.strictObject({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  kind: z.literal("weekly-plan-index"),
  weekId: WeekId,
  revision: z.int().min(0),
  versions: z.array(
    z.strictObject({
      version: z.int().min(1),
      contentHash: Fingerprint,
      createdAt: IsoDateTime,
      itemCount: z.int().min(1),
      /** True when the version file was adopted after an interrupted write. */
      recovered: z.boolean().optional(),
    }),
  ),
  events: z.array(PlanEventSchema),
});
export type PlanIndex = z.infer<typeof PlanIndexSchema>;

// ----------------------------------------------------------------- jobs

export const AttemptOutcome = z.enum([
  "succeeded",
  "failed-retryable",
  "failed-permanent",
  "timeout",
  "verification-failed",
  "blocked",
  "interrupted",
  "cancelled",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

const ErrorInfo = z.strictObject({ code: z.string().min(1), message: z.string().max(2000) });

export const AttemptSchema = z.strictObject({
  n: z.int().min(1),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
  runner: z.strictObject({ pid: z.int(), hostname: z.string() }),
  outcome: AttemptOutcome.optional(),
  error: ErrorInfo.optional(),
  durationMs: z.int().min(0).optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const OutputRecordSchema = z.strictObject({
  /** Relative to the job directory. */
  path: RelativePath,
  sha256: Fingerprint,
  bytes: z.int().min(0),
  role: z.string().optional(),
});
export type OutputRecord = z.infer<typeof OutputRecordSchema>;

export const StepRecordSchema = z.strictObject({
  status: z.enum(["pending", "running", "succeeded", "failed", "blocked"]),
  inputFingerprint: Fingerprint.optional(),
  configFingerprint: Fingerprint.optional(),
  outputs: z.array(OutputRecordSchema).default([]),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  attempts: z.array(AttemptSchema).default([]),
  /** Index into `attempts` where the current retry budget starts. */
  budgetStart: z.int().min(0).default(0),
  completedAt: IsoDateTime.optional(),
  failure: z
    .strictObject({
      kind: z.enum(["permanent", "retries-exhausted"]),
      code: z.string(),
      message: z.string().max(2000),
      at: IsoDateTime,
      inputFingerprint: Fingerprint,
    })
    .optional(),
  blocked: z.strictObject({ code: z.string(), reason: z.string().max(2000), at: IsoDateTime }).optional(),
});
export type StepRecord = z.infer<typeof StepRecordSchema>;

export const ArtifactRole = z.enum(["research", "script", "storyboard", "sceneManifest", "captions", "localization", "subtitles", "narration", "narrationAudio", "narrationSubtitles", "assets", "renderRequest", "render", "renderReport", "quality", "qaReview", "review", "package"]);
export type ArtifactRole = z.infer<typeof ArtifactRole>;

export const JobEventSchema = z.strictObject({
  at: IsoDateTime,
  type: z.enum(["created", "transition", "invalidated", "retry-granted", "interrupted-attempt", "recovered", "plan-updated", "reused"]),
  from: VideoState.optional(),
  to: VideoState.optional(),
  step: StepId.optional(),
  reason: z.string().max(2000).optional(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;

export const JobRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
    kind: z.literal("video-job"),
    jobId: Slug,
    contentId: Slug,
    weekId: WeekId,
    /** Incremented on every write; used for compare-and-swap. */
    revision: z.int().min(0),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    state: VideoState,
    /** Milestone to return to when leaving BLOCKED/FAILED. Required in those states. */
    resumeState: LifecycleState.optional(),
    currentStep: StepId.nullable(),
    lastSuccessfulStep: StepId.nullable(),
    planRef: z.strictObject({ version: z.int().min(1), planHash: Fingerprint, itemHash: Fingerprint }),
    steps: z.record(StepId, StepRecordSchema),
    /** Workspace-relative paths of the latest verified artifact per role. */
    artifacts: z.partialRecord(ArtifactRole, RelativePath).default({}),
    blocked: z.strictObject({ step: StepId, code: z.string(), reason: z.string().max(2000), since: IsoDateTime }).optional(),
    failure: z
      .strictObject({ step: StepId, kind: z.enum(["permanent", "retries-exhausted"]), code: z.string(), message: z.string().max(2000), at: IsoDateTime })
      .optional(),
    history: z.array(JobEventSchema),
  })
  .superRefine((job, ctx) => {
    const special = job.state === "BLOCKED" || job.state === "FAILED";
    if (special && !job.resumeState) ctx.addIssue({ code: "custom", path: ["resumeState"], message: `Required when state is ${job.state}` });
    if (!special && job.resumeState) ctx.addIssue({ code: "custom", path: ["resumeState"], message: "Only allowed in BLOCKED or FAILED" });
    if ((job.state === "BLOCKED") !== Boolean(job.blocked)) ctx.addIssue({ code: "custom", path: ["blocked"], message: "Must be present exactly when state is BLOCKED" });
    if ((job.state === "FAILED") !== Boolean(job.failure)) ctx.addIssue({ code: "custom", path: ["failure"], message: "Must be present exactly when state is FAILED" });
    if (!job.jobId.endsWith(job.contentId)) ctx.addIssue({ code: "custom", path: ["jobId"], message: "Must end with contentId" });
  });
export type JobRecord = z.infer<typeof JobRecordSchema>;
