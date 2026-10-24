import { z } from "zod";
import { LanguageTag, PlatformId, RelativePath, Slug } from "./common.ts";
import { ClaimKind, ClaimSupport } from "./research.ts";

export const SCRIPT_SCHEMA_VERSION = 1 as const;

const Fp = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected sha256:<64 hex>");
const SegId = z.string().regex(/^seg-\d{2}-[a-z]+$/, "Expected seg-NN-<purpose>");
const SceneId = z.string().regex(/^scn-\d{2}$/, "Expected scn-NN");
const AssetId = z.string().regex(/^ast-[a-z0-9-]+$/, "Expected ast-<slug>");
const CueId = z.string().regex(/^cue-[a-z0-9-]+-\d{4}$/, "Expected cue-<lang>-NNNN");
const AspectRatioEnum = z.enum(["9:16", "16:9", "1:1", "4:5"]);

/** Plain text only. Rejects markup/script-like content so manifests stay declarative. */
const PlainText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/<\s*\/?\s*[a-z][^>]*>|javascript:|\{\{|\$\{/i.test(s), "Must be plain text (no HTML, template or script syntax)");

// ------------------------------------------------------------------ script

export const SCRIPT_FORMATS = ["short-explainer", "tutorial", "news-update", "comparison", "evergreen-explainer", "long-explainer"] as const;
export const ScriptFormat = z.enum(SCRIPT_FORMATS);
export type ScriptFormat = z.infer<typeof ScriptFormat>;

export const SegmentPurpose = z.enum(["hook", "context", "explanation", "demonstration", "takeaway", "outro"]);
export type SegmentPurpose = z.infer<typeof SegmentPurpose>;

/**
 * Where the words of a segment come from:
 * - claim:    contains the exact text of the referenced claims (plus fixed attribution wording)
 * - template: fixed CreatorFlow wording with only titles/names inserted; asserts no facts
 * - plan:     creator-authored text from the approved plan (hook, angle, takeaway); not checked against evidence
 * - source:   names a source and the date it states (attribution), nothing else
 */
export const TextOrigin = z.enum(["claim", "template", "plan", "source"]);

export const FactualClaimReferenceSchema = z.strictObject({
  claimId: z.string().regex(/^clm-[a-z0-9-]+$/),
  kind: ClaimKind,
  support: ClaimSupport,
  usage: z.enum(["state-as-fact-with-citation", "state-as-fact-cite-and-verify", "present-as-opinion", "present-as-question"]),
  sourceIds: z.array(z.string()).min(0),
});
export type FactualClaimReference = z.infer<typeof FactualClaimReferenceSchema>;

export const VisualDirectionSchema = z.strictObject({
  sceneType: z.enum([
    "hook-typography",
    "title-intro",
    "concept-explanation",
    "technical-diagram",
    "code-terminal-demo",
    "comparison-layout",
    "screen-capture",
    "source-quote",
    "summary",
    "outro",
  ]),
  description: PlainText(500),
  emphasis: z.array(PlainText(80)).max(6).default([]),
});
export type VisualDirection = z.infer<typeof VisualDirectionSchema>;
export const SceneType = VisualDirectionSchema.shape.sceneType;
export type SceneType = z.infer<typeof SceneType>;

export const EditorialIssueSchema = z.strictObject({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  message: z.string().max(1000),
  segmentId: SegId.optional(),
});
export type EditorialIssue = z.infer<typeof EditorialIssueSchema>;

export const ScriptSegmentSchema = z.strictObject({
  segmentId: SegId,
  purpose: SegmentPurpose,
  language: LanguageTag,
  narration: PlainText(2000).pipe(z.string().min(1)),
  onScreenText: PlainText(200).pipe(z.string().min(1)),
  textOrigin: z.array(TextOrigin).min(1),
  claimRefs: z.array(FactualClaimReferenceSchema),
  sourceRefs: z.array(z.string()),
  timing: z.strictObject({
    words: z.int().min(0),
    estimatedSec: z.number().min(0),
    minSec: z.number().min(0),
  }),
  visual: VisualDirectionSchema,
  transition: z.enum(["cut", "fade", "slide", "none"]),
  editorialNotes: z.array(z.string().max(500)).max(10).default([]),
  /** Optional segments may be dropped to fit the target duration. */
  optional: z.boolean(),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const AttributionSchema = z.strictObject({
  sourceId: z.string(),
  title: z.string(),
  publisher: z.string().optional(),
  url: z.string().optional(),
  publishedAt: z.string().optional(),
  /** Attribution text required by the source, if any. */
  requiredText: z.string().optional(),
  usageRestrictions: z.array(z.string()),
  segmentIds: z.array(SegId),
});
export type Attribution = z.infer<typeof AttributionSchema>;

export const CanonicalScriptSchema = z
  .strictObject({
    schemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
    kind: z.literal("canonical-script"),
    contentId: Slug,
    jobId: Slug,
    language: LanguageTag,
    format: ScriptFormat,
    provider: z.strictObject({ id: z.string(), version: z.string(), deterministic: z.boolean() }),
    /** Plan the script was generated under (the item hash is what the script depends on). */
    plan: z.strictObject({ weekId: z.string(), version: z.int().min(1), contentHash: Fp, itemHash: Fp }),
    evidence: z.strictObject({ path: RelativePath, sha256: Fp, evidenceHash: Fp }),
    /** Scheduled publish date used to judge evidence validity. Not an execution timestamp. */
    evidenceAsOf: z.iso.date(),
    title: PlainText(150),
    platform: PlatformId,
    aspectRatio: AspectRatioEnum,
    targetDurationSec: z.int().min(5),
    estimatedDurationSec: z.number().min(0),
    timingStatus: z.literal("estimated"),
    speechRateWpm: z.number().min(40).max(400),
    segments: z.array(ScriptSegmentSchema).min(1),
    attributions: z.array(AttributionSchema),
    droppedSegments: z.array(z.strictObject({ segmentId: SegId, reason: z.string() })),
    editorial: z.strictObject({
      status: z.enum(["ok", "duration-shortfall", "over-duration"]),
      issues: z.array(EditorialIssueSchema),
    }),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.segments.forEach((seg, i) => {
      if (ids.has(seg.segmentId)) ctx.addIssue({ code: "custom", path: ["segments", i, "segmentId"], message: "Duplicate segment id" });
      ids.add(seg.segmentId);
      if (seg.language !== s.language) ctx.addIssue({ code: "custom", path: ["segments", i, "language"], message: "Segment language differs from script language" });
      if ((seg.purpose === "explanation" || seg.purpose === "demonstration") && seg.claimRefs.length === 0) {
        ctx.addIssue({ code: "custom", path: ["segments", i, "claimRefs"], message: `${seg.purpose} segments must reference at least one claim` });
      }
    });
    s.attributions.forEach((a, i) =>
      a.segmentIds.forEach((id, j) => {
        if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["attributions", i, "segmentIds", j], message: `Unknown segment ${id}` });
      }),
    );
  });
export type CanonicalScript = z.infer<typeof CanonicalScriptSchema>;

// ------------------------------------------------------------------ storyboard

export const AssetRequirementSchema = z.strictObject({
  assetId: AssetId,
  kind: z.enum(["screen-recording", "screenshot", "diagram", "code-snippet", "logo", "font", "b-roll", "icon", "other"]),
  description: z.string().max(500),
  /** Never "available" before the asset registry (a later stage) verifies a file. */
  status: z.enum(["required-unregistered", "declared-unverified"]),
  required: z.boolean(),
  sceneIds: z.array(SceneId),
  licenseNotes: z.string().max(500).optional(),
  origin: z.enum(["plan", "storyboard", "brand"]),
});
export type AssetRequirement = z.infer<typeof AssetRequirementSchema>;

export const SafeAreaSchema = z.strictObject({
  /** Fractions of the frame reserved on each side. */
  top: z.number().min(0).max(0.5),
  bottom: z.number().min(0).max(0.5),
  left: z.number().min(0).max(0.5),
  right: z.number().min(0).max(0.5),
});

export const TextLayoutSchema = z.strictObject({
  primary: PlainText(200),
  secondary: PlainText(200).optional(),
  maxLines: z.int().min(1).max(6),
  maxCharsPerLine: z.int().min(8).max(80),
  /** Graphemes in the longest line of `primary` after wrapping. */
  fits: z.boolean(),
});

export const StoryboardSceneSchema = z.strictObject({
  sceneId: SceneId,
  type: SceneType,
  purpose: SegmentPurpose,
  segmentIds: z.array(SegId).min(1),
  startSec: z.number().min(0),
  durationSec: z.number().gt(0),
  narration: z.literal("voiceover-of-segments"),
  hierarchy: z.array(z.enum(["headline", "body", "source-label", "code", "diagram", "media", "brand"])).min(1),
  motion: z.strictObject({ intent: z.enum(["reveal", "build", "emphasise", "compare", "demonstrate", "summarise", "close"]), intensity: z.enum(["low", "medium", "high"]), transitionIn: z.enum(["cut", "fade", "slide", "none"]) }),
  text: TextLayoutSchema,
  assetIds: z.array(AssetId),
  attributionSourceIds: z.array(z.string()),
  safeArea: SafeAreaSchema,
  notes: z.array(z.string().max(500)).max(10),
});
export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;

export const StoryboardSchema = z
  .strictObject({
    schemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
    kind: z.literal("storyboard"),
    contentId: Slug,
    script: z.strictObject({ path: RelativePath, sha256: Fp }),
    aspectRatio: AspectRatioEnum,
    style: z.strictObject({ faceless: z.literal(true), styles: z.array(z.string()), animationIntensity: z.enum(["low", "medium", "high"]) }),
    estimatedDurationSec: z.number().gt(0),
    timingStatus: z.literal("estimated"),
    scenes: z.array(StoryboardSceneSchema).min(1),
    assets: z.array(AssetRequirementSchema),
  })
  .superRefine((b, ctx) => {
    let t = 0;
    const sceneIds = new Set<string>();
    b.scenes.forEach((s, i) => {
      if (sceneIds.has(s.sceneId)) ctx.addIssue({ code: "custom", path: ["scenes", i, "sceneId"], message: "Duplicate scene id" });
      sceneIds.add(s.sceneId);
      if (Math.abs(s.startSec - t) > 0.011) ctx.addIssue({ code: "custom", path: ["scenes", i, "startSec"], message: `Expected ${t.toFixed(2)} (scenes must be contiguous and ordered)` });
      t = s.startSec + s.durationSec;
    });
    if (Math.abs(t - b.estimatedDurationSec) > 0.05) ctx.addIssue({ code: "custom", path: ["estimatedDurationSec"], message: "Does not equal the sum of scene durations" });
    const assetIds = new Set(b.assets.map((a) => a.assetId));
    b.scenes.forEach((s, i) => s.assetIds.forEach((a, j) => assetIds.has(a) || ctx.addIssue({ code: "custom", path: ["scenes", i, "assetIds", j], message: `Unknown asset ${a}` })));
    b.assets.forEach((a, i) => a.sceneIds.forEach((s, j) => sceneIds.has(s) || ctx.addIssue({ code: "custom", path: ["assets", i, "sceneIds", j], message: `Unknown scene ${s}` })));
  });
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ------------------------------------------------------------------ subtitles

export const SubtitleCueSchema = z
  .strictObject({
    cueId: CueId,
    index: z.int().min(1),
    startMs: z.int().min(0),
    endMs: z.int().min(1),
    lines: z.array(z.string().min(1).max(300)).min(1).max(4),
    segmentId: SegId,
    sceneId: SceneId.optional(),
  })
  .refine((c) => c.endMs > c.startMs, { message: "Cue duration must be positive", path: ["endMs"] });
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;

export const SubtitleTrackSchema = z
  .strictObject({
    language: LanguageTag,
    /**
     * How cue times were obtained. "estimated": from text length (no audio).
     * "sentence-aligned": each sentence's cues span the measured speech of that
     * sentence in the narration audio (multi-cue sentences are split by text
     * length inside the sentence). "word-aligned" is reserved; no provider produces it.
     */
    timing: z.enum(["estimated", "sentence-aligned", "word-aligned"]),
    source: z.enum(["canonical", "localized"]),
    cues: z.array(SubtitleCueSchema).min(1),
    warnings: z.array(z.strictObject({ cueId: CueId, code: z.string(), message: z.string() })),
  })
  .superRefine((t, ctx) => {
    t.cues.forEach((c, i) => {
      if (c.index !== i + 1) ctx.addIssue({ code: "custom", path: ["cues", i, "index"], message: "Cue indices must be 1..n in order" });
      const prev = t.cues[i - 1];
      if (prev && c.startMs < prev.endMs) ctx.addIssue({ code: "custom", path: ["cues", i, "startMs"], message: "Cue overlaps the previous cue" });
    });
  });
export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;

export const CaptionsFileSchema = z.strictObject({
  schemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
  kind: z.literal("subtitle-tracks"),
  contentId: Slug,
  script: z.strictObject({ path: RelativePath, sha256: Fp }),
  tracks: z.array(SubtitleTrackSchema).min(1),
});
export type CaptionsFile = z.infer<typeof CaptionsFileSchema>;

// ------------------------------------------------------------------ scene manifest

export const SceneManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
    kind: z.literal("scene-manifest"),
    contentId: Slug,
    jobId: Slug,
    plan: z.strictObject({ weekId: z.string(), version: z.int().min(1), contentHash: Fp, itemHash: Fp }),
    script: z.strictObject({ path: RelativePath, sha256: Fp }),
    storyboard: z.strictObject({ path: RelativePath, sha256: Fp }),
    format: z.strictObject({
      platform: PlatformId,
      aspectRatio: AspectRatioEnum,
      width: z.int().min(240),
      height: z.int().min(240),
      fps: z.int().min(12).max(120),
    }),
    estimatedDurationSec: z.number().gt(0),
    durationInFrames: z.int().min(1),
    timingStatus: z.literal("estimated"),
    scenes: z
      .array(
        z.strictObject({
          sceneId: SceneId,
          type: SceneType,
          startFrame: z.int().min(0),
          durationInFrames: z.int().min(1),
          segmentIds: z.array(SegId).min(1),
          text: z.strictObject({ primary: PlainText(200), secondary: PlainText(200).optional() }),
          captionCueIds: z.array(CueId),
          assetIds: z.array(AssetId),
          attributionSourceIds: z.array(z.string()),
          motion: z.strictObject({ intent: z.string(), intensity: z.enum(["low", "medium", "high"]), transitionIn: z.enum(["cut", "fade", "slide", "none"]) }),
          safeArea: SafeAreaSchema,
        }),
      )
      .min(1),
    narration: z.strictObject({
      mode: z.enum(["tts", "user-recorded", "none"]),
      language: LanguageTag,
      voiceId: z.string().optional(),
      speakingRate: z.number(),
      status: z.literal("not-generated"),
      pronunciations: z.array(z.strictObject({ term: z.string(), pronunciation: z.string() })),
    }),
    subtitles: z.strictObject({
      canonical: z.strictObject({ language: LanguageTag, path: RelativePath, sha256: Fp }),
      /** Produced by the localize step; listed here so renderers know where to look. */
      localized: z.strictObject({ path: RelativePath, languages: z.array(LanguageTag), status: z.literal("pending-localization") }),
    }),
    assets: z.array(z.strictObject({ assetId: AssetId, kind: z.string(), status: z.string(), required: z.boolean() })),
    brand: z.strictObject({
      name: z.string(),
      colors: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/)),
      fonts: z.record(z.string(), z.strictObject({ family: z.string(), source: z.string(), license: z.string() })),
      logoAssetId: AssetId.optional(),
    }),
    attributions: z.array(z.strictObject({ sourceId: z.string(), text: z.string(), required: z.boolean(), sceneIds: z.array(SceneId) })),
  })
  .superRefine((m, ctx) => {
    let f = 0;
    m.scenes.forEach((s, i) => {
      if (s.startFrame !== f) ctx.addIssue({ code: "custom", path: ["scenes", i, "startFrame"], message: `Expected ${f} (scenes must be contiguous and ordered)` });
      f = s.startFrame + s.durationInFrames;
    });
    if (f !== m.durationInFrames) ctx.addIssue({ code: "custom", path: ["durationInFrames"], message: "Does not equal the sum of scene frames" });
    const assetIds = new Set(m.assets.map((a) => a.assetId));
    m.scenes.forEach((s, i) => s.assetIds.forEach((a, j) => assetIds.has(a) || ctx.addIssue({ code: "custom", path: ["scenes", i, "assetIds", j], message: `Unknown asset ${a}` })));
    if (m.brand.logoAssetId && !assetIds.has(m.brand.logoAssetId)) ctx.addIssue({ code: "custom", path: ["brand", "logoAssetId"], message: "Unknown asset" });
  });
export type SceneManifest = z.infer<typeof SceneManifestSchema>;

// ------------------------------------------------------------------ localization

export const GlossaryTermSchema = z.strictObject({
  term: z.string().min(1),
  category: z.enum(["product", "technical", "brand", "other"]),
  doNotTranslate: z.boolean(),
  pronunciation: z.string().optional(),
  preferred: z.record(LanguageTag, z.string()),
  languages: z.array(LanguageTag).optional(),
  notes: z.string().optional(),
});
export const TerminologyGlossarySchema = z.strictObject({
  schemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
  kind: z.literal("terminology-glossary"),
  terms: z.array(GlossaryTermSchema),
});
export type TerminologyGlossary = z.infer<typeof TerminologyGlossarySchema>;

/** File a human translator fills in and imports with `creatorflow localize import`. */
export const TranslationImportSchema = z.strictObject({
  $schema: z.string().optional(),
  kind: z.literal("translation"),
  contentId: Slug,
  language: LanguageTag,
  /** sha256 of the canonical script.json the translation was made from. */
  canonicalScriptSha256: Fp,
  translator: z.strictObject({ name: z.string().min(1).max(120), method: z.enum(["human", "machine-assisted-human-edited"]) }),
  /** Optional statement that someone reviewed it. Recorded as claimed; CreatorFlow cannot verify quality. */
  review: z.strictObject({ reviewer: z.string().min(1).max(120), reviewedAt: z.iso.date(), notes: z.string().max(1000).optional() }).optional(),
  title: PlainText(150).optional(),
  /** Informational only (written by `localize template`); ignored on import. */
  instructions: z.string().max(2000).optional(),
  segments: z
    .array(
      z.strictObject({
        segmentId: SegId,
        narration: PlainText(3000).pipe(z.string().min(1)),
        onScreenText: PlainText(300).pipe(z.string().min(1)),
        /** Informational copy of the canonical text (written by `localize template`); ignored on import. */
        source: z.strictObject({ narration: z.string(), onScreenText: z.string() }).optional(),
      }),
    )
    .min(1),
});
export type TranslationImport = z.infer<typeof TranslationImportSchema>;

export const LocalizationVariantSchema = z.strictObject({
  language: LanguageTag,
  sourceLanguage: LanguageTag,
  canonicalScriptSha256: Fp,
  provider: z.enum(["canonical", "same-language", "human-import"]),
  status: z.enum(["source", "adapted", "translated"]),
  review: z.enum(["not-applicable", "unreviewed", "reviewed-claimed-by-importer"]),
  reviewer: z.string().optional(),
  translationFile: z.strictObject({ path: RelativePath, sha256: Fp }).optional(),
  title: z.string(),
  segments: z.array(
    z.strictObject({
      segmentId: SegId,
      narration: z.string().min(1),
      onScreenText: z.string().min(1),
      claimIds: z.array(z.string()),
      estimatedSec: z.number().min(0),
    }),
  ),
  requiredScripts: z.array(z.string()),
  issues: z.array(EditorialIssueSchema),
});
export type LocalizationVariant = z.infer<typeof LocalizationVariantSchema>;

export const LocalizationSetSchema = z.strictObject({
  schemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
  kind: z.literal("localization-variants"),
  contentId: Slug,
  script: z.strictObject({ path: RelativePath, sha256: Fp }),
  glossary: TerminologyGlossarySchema,
  variants: z.array(LocalizationVariantSchema).min(1),
  /** Font coverage cannot be checked from config alone. */
  fontCoverage: z.literal("not-verified"),
});
export type LocalizationSet = z.infer<typeof LocalizationSetSchema>;
