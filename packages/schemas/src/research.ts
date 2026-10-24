import { z } from "zod";
import { LanguageTag, PlatformId, RelativePath, Slug } from "./common.ts";

export const RESEARCH_SCHEMA_VERSION = 1 as const;

const Fp = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected sha256:<64 hex>");
const IsoDT = z.iso.datetime({ offset: true });
/** A calendar date or a full timestamp, exactly as the source states it. Never inferred. */
export const SourceDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const HttpUrl = z.url({ protocol: /^https?$/ });

export const SOURCE_TYPES = [
  "official-documentation",
  "official-announcement",
  "changelog",
  "repository",
  "paper",
  "reputable-reporting",
  "community",
  "user-notes",
  "other",
] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

/**
 * fact:           a statement presented as true; must be supported by evidence.
 * interpretation: the creator's/analyst's reading of facts; shown as opinion.
 * hypothesis:     a topic idea or prediction to explore; never presented as fact.
 */
export const ClaimKind = z.enum(["fact", "interpretation", "hypothesis"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ContentCategoryEnum = z.enum(["news", "explainer", "tutorial", "comparison", "experiment", "recap"]);

// ------------------------------------------------------------------ user input

export const SourceInputSchema = z
  .strictObject({
    /** Bundle-local reference used by claims. */
    key: Slug.max(60),
    url: HttpUrl.optional(),
    title: z.string().min(1).max(300),
    publisher: z.string().min(1).max(200).optional(),
    sourceType: SourceType,
    otherDescription: z.string().min(3).max(200).optional(),
    publishedAt: SourceDate.optional(),
    modifiedAt: SourceDate.optional(),
    /** When the user retrieved/read the source. Left empty if unknown. */
    retrievedAt: SourceDate.optional(),
    /** Locally saved copy (.html, .htm, .txt, .md) relative to the input file. Used to check excerpts. */
    snapshot: RelativePath.optional(),
    notes: z.string().max(10_000).optional(),
    confidenceNotes: z.string().max(2000).optional(),
    attribution: z.string().max(500).optional(),
    usageRestrictions: z.array(z.string().min(1).max(300)).max(20).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.sourceType === "other" && !s.otherDescription) {
      ctx.addIssue({ code: "custom", path: ["otherDescription"], message: 'Required when sourceType is "other"' });
    }
  });
export type SourceInput = z.infer<typeof SourceInputSchema>;

export const EvidenceInputSchema = z
  .strictObject({
    /** Key of a source in the same import, or of a source already in the session. */
    source: Slug.max(60),
    kind: z.enum(["quote", "paraphrase"]).default("quote"),
    excerpt: z.string().min(3).max(1500).optional(),
    /** Section, heading, line or timestamp inside the source. */
    locator: z.string().min(1).max(200).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === "quote" && !e.excerpt) ctx.addIssue({ code: "custom", path: ["excerpt"], message: "A quote needs the quoted excerpt" });
  });

export const ClaimInputSchema = z.strictObject({
  key: Slug.max(60),
  text: z.string().min(5).max(1000),
  kind: ClaimKind,
  evidence: z.array(EvidenceInputSchema).max(20).default([]),
});
export type ClaimInput = z.infer<typeof ClaimInputSchema>;

export const CandidateInputSchema = z.strictObject({
  /** Becomes the plan contentId; keep it stable when editing. */
  key: Slug.max(60),
  topic: z.string().min(3).max(200),
  category: ContentCategoryEnum,
  workingTitle: z.string().min(3).max(150).optional(),
  audienceProblem: z.string().min(3).max(500).optional(),
  angle: z.string().min(3).max(500).optional(),
  hook: z.string().min(3).max(300).optional(),
  takeaway: z.string().min(3).max(300).optional(),
  /** Claim keys this video would rely on. */
  claims: z.array(Slug.max(60)).min(1).max(30),
  /** Treat as time-sensitive even if the category is not "news". */
  breaking: z.boolean().default(false),
  platform: PlatformId.optional(),
  language: LanguageTag.optional(),
  durationSec: z.int().min(5).max(7200).optional(),
  requiredAssets: z.array(z.string().min(1).max(200)).max(20).default([]),
});
export type CandidateInput = z.infer<typeof CandidateInputSchema>;

/** File format accepted by the manual-sources provider. Records are validated one by one. */
export const ResearchInputSchema = z.strictObject({
  $schema: z.string().optional(),
  sessionTopic: z.string().min(3).max(300).optional(),
  sources: z.array(z.unknown()).default([]),
  claims: z.array(z.unknown()).default([]),
  candidates: z.array(z.unknown()).default([]),
});

/** Documentation-only typed view of the input (for JSON Schema export and editors). */
export const ResearchInputDocSchema = z.strictObject({
  $schema: z.string().optional(),
  sessionTopic: z.string().min(3).max(300).optional(),
  sources: z.array(SourceInputSchema).default([]),
  claims: z.array(ClaimInputSchema).default([]),
  candidates: z.array(CandidateInputSchema).default([]),
});

// ------------------------------------------------------------------ stored records

export const EvidenceCheck = z.enum(["found-in-snapshot", "not-found-in-snapshot", "not-checked"]);
export type EvidenceCheck = z.infer<typeof EvidenceCheck>;

/**
 * supported:            fact backed by primary/secondary evidence whose excerpt was found in a local snapshot
 * supported-unchecked:  fact backed by primary/secondary evidence that could not be checked (no snapshot)
 * weak:                 fact backed only by community/user-notes/other sources
 * unsupported:          fact with no usable evidence
 * interpretation / hypothesis: not facts; never presented as verified
 */
export const ClaimSupport = z.enum(["supported", "supported-unchecked", "weak", "unsupported", "interpretation", "hypothesis"]);
export type ClaimSupport = z.infer<typeof ClaimSupport>;

export const SnapshotRecordSchema = z.strictObject({
  originalName: z.string().max(260),
  mediaType: z.enum(["text/html", "text/plain", "text/markdown"]),
  sha256: Fp,
  bytes: z.int().min(0),
  /** Extracted plain text, workspace-relative and content-addressed. */
  textPath: RelativePath,
  textSha256: Fp,
});

export const SourceRecordSchema = z.strictObject({
  sourceId: z.string().regex(/^src-[a-z0-9-]{3,80}$/),
  key: Slug,
  /** fingerprint of the user-provided fields + snapshot hash (no timestamps, no file names). */
  contentHash: Fp,
  url: HttpUrl.optional(),
  canonicalUrl: HttpUrl.optional(),
  title: z.string(),
  publisher: z.string().optional(),
  sourceType: SourceType,
  otherDescription: z.string().optional(),
  publishedAt: SourceDate.optional(),
  modifiedAt: SourceDate.optional(),
  retrievedAt: SourceDate.optional(),
  notes: z.string().optional(),
  confidenceNotes: z.string().optional(),
  attribution: z.string().optional(),
  usageRestrictions: z.array(z.string()),
  provenance: z.strictObject({
    origin: z.literal("user-supplied"),
    provider: z.string(),
    /** Input file name (display only). */
    importedFrom: z.string().max(260),
    snapshot: SnapshotRecordSchema.optional(),
  }),
  verification: z.strictObject({
    status: z.enum(["excerpts-found-in-snapshot", "excerpt-mismatch", "snapshot-without-excerpts", "no-snapshot"]),
    notes: z.array(z.string()),
  }),
  /** Fields the user did not provide (never filled in by CreatorFlow). */
  missingMetadata: z.array(z.string()),
  /** Text in notes/snapshot that looks like instructions to an AI. Treated as data only. */
  untrustedContentWarnings: z.array(z.string()),
  firstImportedAt: IsoDT,
  lastChangedAt: IsoDT,
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const EvidenceRecordSchema = z.strictObject({
  sourceId: z.string(),
  kind: z.enum(["quote", "paraphrase"]),
  excerpt: z.string().optional(),
  locator: z.string().optional(),
  check: EvidenceCheck,
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const ClaimRecordSchema = z.strictObject({
  claimId: z.string().regex(/^clm-[a-z0-9-]+$/),
  key: Slug,
  contentHash: Fp,
  text: z.string(),
  kind: ClaimKind,
  evidence: z.array(EvidenceRecordSchema),
  /** Support as of import (no date cut-off). Scoring re-assesses against the planning date. */
  support: ClaimSupport,
  firstImportedAt: IsoDT,
  lastChangedAt: IsoDT,
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

export const CandidateRecordSchema = z.strictObject({
  candidateId: z.string().regex(/^cand-[a-z0-9-]+$/),
  contentId: Slug.max(60),
  contentHash: Fp,
  topic: z.string(),
  category: ContentCategoryEnum,
  workingTitle: z.string().optional(),
  audienceProblem: z.string().optional(),
  angle: z.string().optional(),
  hook: z.string().optional(),
  takeaway: z.string().optional(),
  claimIds: z.array(z.string()),
  breaking: z.boolean(),
  platform: PlatformId.optional(),
  language: LanguageTag.optional(),
  durationSec: z.int().optional(),
  requiredAssets: z.array(z.string()),
  firstImportedAt: IsoDT,
  lastChangedAt: IsoDT,
});
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

export const ImportIssueSchema = z.strictObject({
  severity: z.enum(["error", "warning"]),
  record: z.string(),
  path: z.string(),
  message: z.string().max(2000),
});
export type ImportIssue = z.infer<typeof ImportIssueSchema>;

export const ResearchSessionSchema = z.strictObject({
  schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION),
  kind: z.literal("research-session"),
  sessionId: Slug,
  revision: z.int().min(0),
  createdAt: IsoDT,
  updatedAt: IsoDT,
  topic: z.string().optional(),
  sources: z.record(z.string(), SourceRecordSchema),
  claims: z.record(z.string(), ClaimRecordSchema),
  candidates: z.record(z.string(), CandidateRecordSchema),
  imports: z.array(
    z.strictObject({
      at: IsoDT,
      provider: z.string(),
      inputs: z.array(z.string()),
      inputHash: Fp,
      mode: z.enum(["merge", "replace"]),
      counts: z.strictObject({ added: z.int(), changed: z.int(), unchanged: z.int(), removed: z.int(), rejected: z.int(), duplicates: z.int() }),
    }),
  ),
  /** Issues from the most recent import that changed the session. */
  lastImportIssues: z.array(ImportIssueSchema),
});
export type ResearchSession = z.infer<typeof ResearchSessionSchema>;

// ------------------------------------------------------------------ scoring and planning

const FactorSchema = z.strictObject({
  /** 0..1, or null when the information needed is missing (counted as 0). */
  score: z.number().min(0).max(1).nullable(),
  detail: z.string(),
});

export const CandidateScoreSchema = z.strictObject({
  candidateId: z.string(),
  contentId: Slug,
  topic: z.string(),
  category: ContentCategoryEnum,
  factors: z.strictObject({ freshness: FactorSchema, relevance: FactorSchema, evidence: FactorSchema, originality: FactorSchema, feasibility: FactorSchema }),
  missingFactors: z.array(z.string()),
  /** Weighted sum on a 0-100 scale, one decimal. A heuristic, not a prediction. */
  score: z.number().min(0).max(100),
  eligible: z.boolean(),
  rejections: z.array(z.strictObject({ code: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
  rationale: z.string(),
  effort: z.enum(["low", "medium", "high"]),
  platform: PlatformId,
  language: LanguageTag,
  durationSec: z.int(),
  newestEvidenceDate: z.string().optional(),
});
export type CandidateScore = z.infer<typeof CandidateScoreSchema>;

export const PlanningRunSchema = z.strictObject({
  schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION),
  kind: z.literal("planning-run"),
  sessionId: Slug,
  sessionRevision: z.int(),
  sessionFingerprint: Fp,
  weekId: z.string(),
  asOf: z.iso.date(),
  createdAt: IsoDT,
  scoringModel: z.string(),
  weights: z.record(z.string(), z.number()),
  profileFingerprint: Fp,
  configFingerprint: Fp,
  historyWeeks: z.array(z.string()),
  target: z.int(),
  ranking: z.array(CandidateScoreSchema),
  selected: z.array(z.strictObject({ contentId: Slug, candidateId: z.string(), reason: z.string() })),
  notSelected: z.array(z.strictObject({ candidateId: z.string(), reason: z.string() })),
  shortfall: z.strictObject({ target: z.int(), selected: z.int(), eligible: z.int(), message: z.string() }).optional(),
  plan: z.strictObject({ version: z.int(), contentHash: Fp, status: z.enum(["created", "unchanged"]) }),
});
export type PlanningRun = z.infer<typeof PlanningRunSchema>;

/** Output of the research workflow step: everything a script writer may cite, nothing more. */
export const ResearchEvidencePackSchema = z.strictObject({
  schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION),
  kind: z.literal("research-evidence"),
  contentId: Slug,
  sessionId: Slug,
  candidateId: z.string(),
  evidenceHash: Fp,
  asOf: z.iso.date(),
  topic: z.string(),
  claims: z.array(
    z.strictObject({
      claimId: z.string(),
      kind: ClaimKind,
      text: z.string(),
      support: ClaimSupport,
      /** How a script may use it. */
      usage: z.enum(["state-as-fact-with-citation", "state-as-fact-cite-and-verify", "present-as-opinion", "present-as-question"]),
      evidence: z.array(EvidenceRecordSchema),
    }),
  ),
  sources: z.array(
    SourceRecordSchema.pick({
      sourceId: true,
      contentHash: true,
      url: true,
      title: true,
      publisher: true,
      sourceType: true,
      publishedAt: true,
      modifiedAt: true,
      retrievedAt: true,
      attribution: true,
      usageRestrictions: true,
      verification: true,
      missingMetadata: true,
      untrustedContentWarnings: true,
    }),
  ),
  caveats: z.array(z.string()),
});
export type ResearchEvidencePack = z.infer<typeof ResearchEvidencePackSchema>;
