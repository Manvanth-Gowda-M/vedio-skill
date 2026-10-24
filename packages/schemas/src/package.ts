import { z } from "zod";
import { LanguageTag, PlatformId, RelativePath, Slug } from "./common.ts";
import { ContentCategory, Fingerprint, IsoDateTime, VideoState, WeekId } from "./workflow.ts";

export const PACKAGE_SCHEMA_VERSION = 1 as const;

export const PackageFileRole = z.enum([
  "video",
  "subtitles",
  "thumbnail",
  "script",
  "storyboard",
  "sceneManifest",
  "attribution",
  "provenance",
  "renderReport",
  "qaReport",
  "reviewRecord",
  "reviewDecision",
  "manifest",
  "other",
]);
export type PackageFileRole = z.infer<typeof PackageFileRole>;

export const PackageFileEntrySchema = z.strictObject({
  path: RelativePath,
  sha256: Fingerprint,
  bytes: z.int().min(0),
  role: PackageFileRole,
  contentType: z.string().min(1),
});
export type PackageFileEntry = z.infer<typeof PackageFileEntrySchema>;

export const PackageOmissionSchema = z.strictObject({
  role: z.string().min(1),
  reason: z.string().min(1).max(1000),
});
export type PackageOmission = z.infer<typeof PackageOmissionSchema>;

export const PackageManifestSchema = z.strictObject({
  schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
  kind: z.literal("package-manifest"),
  jobId: Slug,
  contentId: Slug,
  weekId: WeekId,
  plan: z.strictObject({
    version: z.int().min(1),
    planHash: Fingerprint,
    itemHash: Fingerprint,
  }),
  packagedAt: IsoDateTime,
  delivery: z.strictObject({
    status: z.literal("packaged"),
    notes: z.array(z.string().max(1000)).default([]),
  }),
  metadata: z.strictObject({
    title: z.string().min(1),
    category: ContentCategory,
    primaryLanguage: LanguageTag,
    platform: PlatformId,
    durationSec: z.number().positive(),
    tags: z.array(z.string()).default([]),
  }),
  qa: z.strictObject({
    reportSha256: Fingerprint,
    technicalQa: z.literal("passed"),
  }),
  review: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("approved"),
      by: z.string(),
      at: IsoDateTime,
      note: z.string().optional(),
      decisionSha256: Fingerprint,
    }),
    z.strictObject({
      status: z.literal("not-required"),
      reason: z.string(),
    }),
  ]),
  files: z.array(PackageFileEntrySchema).min(1),
  omissions: z.array(PackageOmissionSchema).default([]),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

// ----------------------------------------------------------------- batch report

export const BatchJobItemSchema = z.strictObject({
  jobId: Slug,
  contentId: Slug,
  title: z.string().min(1),
  category: ContentCategory,
  state: VideoState,
  currentStep: z.string().nullable().optional(),
  lastSuccessfulStep: z.string().nullable().optional(),
  stepsCompleted: z.array(z.string()).default([]),
  stepsReused: z.array(z.string()).default([]),
  blocked: z
    .strictObject({
      step: z.string(),
      code: z.string(),
      reason: z.string(),
    })
    .optional(),
  failure: z
    .strictObject({
      step: z.string(),
      kind: z.string(),
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  qaVerdict: z.enum(["passed", "failed", "blocked", "pending", "none"]).default("none"),
  reviewStatus: z.enum(["approved", "rejected", "not-required", "pending", "none"]).default("none"),
  packageStatus: z.enum(["packaged", "missing", "corrupt", "none"]).default("none"),
  packagePath: RelativePath.optional(),
  packageManifestSha256: Fingerprint.optional(),
  pendingApproval: z
    .strictObject({
      type: z.enum(["plan", "review"]),
      requiredHash: Fingerprint,
      instructions: z.string(),
    })
    .optional(),
});
export type BatchJobItem = z.infer<typeof BatchJobItemSchema>;

export const BatchSummarySchema = z.strictObject({
  total: z.int().min(0),
  planned: z.int().min(0),
  inProgress: z.int().min(0),
  rendered: z.int().min(0),
  qaPassed: z.int().min(0),
  reviewPending: z.int().min(0),
  reviewed: z.int().min(0),
  packaged: z.int().min(0),
  blocked: z.int().min(0),
  failed: z.int().min(0),
});
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

export const BatchReportSchema = z.strictObject({
  schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
  kind: z.literal("batch-report"),
  weekId: WeekId,
  generatedAt: IsoDateTime,
  plan: z.strictObject({
    version: z.int().min(1),
    contentHash: Fingerprint,
    approvedAt: IsoDateTime.optional(),
    approvedBy: z.string().optional(),
  }),
  summary: BatchSummarySchema,
  jobs: z.array(BatchJobItemSchema),
  notes: z.array(z.string()).default([]),
});
export type BatchReport = z.infer<typeof BatchReportSchema>;
