import { z } from "zod";
import { RelativePath, Slug } from "./common.ts";

export const RENDER_SCHEMA_VERSION = 1 as const;

const Fp = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected sha256:<64 hex>");
const AssetId = z.string().regex(/^ast-[a-z0-9-]+$/, "Expected ast-<slug>");
const IsoDT = z.iso.datetime({ offset: true });

// ------------------------------------------------------------------ asset registry

/**
 * Stage F registry (schemaVersion 1): hand-maintained, one entry per job slot.
 * Still accepted on read; `creatorflow assets` commands migrate it to version 2
 * (keeping a backup) the first time they change the registry.
 */
export const AssetRegistryV1Schema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  kind: z.literal("asset-registry"),
  assets: z.array(
    z.strictObject({
      jobId: Slug,
      assetId: AssetId,
      /** Relative to workspace/assets/. */
      path: RelativePath,
      sha256: Fp,
      license: z.string().min(1).max(200),
      attribution: z.string().max(300).optional(),
      source: z.string().max(500).optional(),
    }),
  ),
});
export type AssetRegistryV1 = z.infer<typeof AssetRegistryV1Schema>;

export const ASSET_TYPES = ["diagram", "screenshot", "code-snippet", "logo", "icon", "screen-recording", "b-roll", "other"] as const;
export const AssetType = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof AssetType>;

/**
 * Where a file came from, as stated by the person who registered it.
 * CreatorFlow cannot verify ownership or licences: every field is a claim.
 * `verification` is never "verified"; "user-attested" only records that the
 * user explicitly asserted the rights statement.
 */
export const AssetOrigin = z.enum(["user-created", "user-provided", "public-domain-claim", "open-license-claim", "unknown"]);
export const AssetProvenanceSchema = z.strictObject({
  origin: AssetOrigin,
  creator: z.string().min(1).max(200).optional(),
  /** Recorded as metadata only; never fetched. */
  sourceUrl: z
    .string()
    .max(2000)
    .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), "Must be an http(s) URL")
    .optional(),
  /** Declared licence (SPDX id or name). Absent = unknown. */
  license: z.string().min(1).max(200).optional(),
  attribution: z.string().min(1).max(300).optional(),
  attributionRequired: z.boolean(),
  obtainedAt: z.iso.date().optional(),
  verification: z.enum(["unverified", "user-attested"]),
  notes: z.string().max(1000).optional(),
});
export type AssetProvenance = z.infer<typeof AssetProvenanceSchema>;

export const VideoStreamInfoSchema = z.strictObject({
  container: z.string(),
  codec: z.string(),
  width: z.int().min(1),
  height: z.int().min(1),
  fps: z.number().gt(0),
  durationSec: z.number().gt(0),
  frames: z.int().min(1).optional(),
  pixelFormat: z.string().optional(),
  /** Display rotation in degrees from stream side data (0 when absent). */
  rotation: z.int(),
  audio: z.strictObject({ codec: z.string(), sampleRate: z.int().optional(), channels: z.int().optional() }).nullable(),
});
export type VideoStreamInfo = z.infer<typeof VideoStreamInfoSchema>;

/** Facts measured from the file bytes at registration time (re-measured before every render). */
export const AssetMediaSchema = z.strictObject({
  kind: z.enum(["image", "video", "text"]),
  mediaType: z.string(),
  width: z.int().min(1).optional(),
  height: z.int().min(1).optional(),
  video: VideoStreamInfoSchema.optional(),
});
export type AssetMedia = z.infer<typeof AssetMediaSchema>;

/** How a video asset is played in a scene. Times are in the source clip. */
export const ClipSettingsSchema = z
  .strictObject({
    startSec: z.number().min(0),
    /** Absent = until the end of the source. */
    endSec: z.number().gt(0).optional(),
    /** contain: letterbox inside the frame; cover: fill and crop the centre. */
    fit: z.enum(["contain", "cover"]),
  })
  .refine((c) => c.endSec === undefined || c.endSec > c.startSec, { message: "endSec must be greater than startSec", path: ["endSec"] });
export type ClipSettings = z.infer<typeof ClipSettingsSchema>;

/** A scene-manifest asset slot (jobId + manifest assetId) that this registered file fills. */
export const AssetUseSchema = z.strictObject({
  jobId: Slug,
  assetId: AssetId,
  clip: ClipSettingsSchema.optional(),
});

export const AssetEntrySchema = z.strictObject({
  /** Stable registry id. Never changes once assigned. */
  id: AssetId,
  type: AssetType,
  /** Relative to workspace/assets/. */
  path: RelativePath,
  /** Absent only for entries migrated from a Stage F registry whose file could not be measured yet. */
  bytes: z.int().min(1).optional(),
  sha256: Fp,
  media: AssetMediaSchema.optional(),
  provenance: AssetProvenanceSchema,
  registeredAt: IsoDT,
  updatedAt: IsoDT,
  uses: z.array(AssetUseSchema),
});
export type AssetEntry = z.infer<typeof AssetEntrySchema>;

/** workspace/assets/registry.json (Stage G). Written only by `creatorflow assets` commands. */
export const AssetRegistryV2Schema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(2),
    kind: z.literal("asset-registry"),
    /** Incremented on every write (compare-and-swap). */
    revision: z.int().min(0),
    assets: z.array(AssetEntrySchema),
  })
  .superRefine((r, ctx) => {
    const ids = new Set<string>();
    const paths = new Map<string, string>();
    const slots = new Map<string, string>();
    r.assets.forEach((a, i) => {
      if (ids.has(a.id)) ctx.addIssue({ code: "custom", path: ["assets", i, "id"], message: `Duplicate asset id ${a.id}` });
      ids.add(a.id);
      const p = a.path.replace(/\\/g, "/").toLowerCase();
      if (paths.has(p)) ctx.addIssue({ code: "custom", path: ["assets", i, "path"], message: `Same file as ${paths.get(p)}` });
      paths.set(p, a.id);
      a.uses.forEach((u, j) => {
        const key = `${u.jobId}/${u.assetId}`;
        if (slots.has(key)) ctx.addIssue({ code: "custom", path: ["assets", i, "uses", j], message: `${key} is already filled by ${slots.get(key)}` });
        slots.set(key, a.id);
        if (u.clip && a.media && a.media.kind !== "video") ctx.addIssue({ code: "custom", path: ["assets", i, "uses", j, "clip"], message: "Clip settings only apply to video assets" });
      });
      const video = a.type === "screen-recording" || a.type === "b-roll";
      if (a.media && video !== (a.media.kind === "video")) ctx.addIssue({ code: "custom", path: ["assets", i, "media", "kind"], message: `Type ${a.type} does not match media kind ${a.media.kind}` });
    });
  });
export type AssetRegistryV2 = z.infer<typeof AssetRegistryV2Schema>;

export const AssetRegistrySchema = z.discriminatedUnion("schemaVersion", [AssetRegistryV1Schema, AssetRegistryV2Schema]);
export type AssetRegistry = z.infer<typeof AssetRegistrySchema>;

const FontFaceFile = z.strictObject({
  /** "fontsource" (installed npm package), "project" (local-file in the project) */
  root: z.enum(["fontsource", "project"]),
  /** Relative to the root. */
  path: RelativePath,
  sha256: Fp,
  weight: z.int().min(100).max(900),
  /** CSS unicode-range derived from the file's own cmap table. */
  unicodeRange: z.string().min(1),
});

/** Output of the assets step: how every manifest asset and brand font was resolved. */
export const AssetResolutionSchema = z.strictObject({
  schemaVersion: z.literal(RENDER_SCHEMA_VERSION),
  kind: z.literal("asset-resolution"),
  contentId: Slug,
  manifest: z.strictObject({ path: RelativePath, sha256: Fp }),
  assets: z.array(
    z.strictObject({
      assetId: AssetId,
      kind: z.string(),
      required: z.boolean(),
      /** resolved: a verified file; text-only-fallback: optional asset rendered without media; font: see fonts. */
      status: z.enum(["resolved", "text-only-fallback", "font"]),
      file: z
        .strictObject({
          root: z.enum(["assets", "project"]),
          path: RelativePath,
          sha256: Fp,
          mediaType: z.string(),
          bytes: z.int().min(1).optional(),
          /** Registry id (Stage G registries). */
          registryId: AssetId.optional(),
        })
        .optional(),
      /** Measured from the file now, not copied from the registry (video assets). */
      video: VideoStreamInfoSchema.optional(),
      /** Validated clip window and framing for video assets. */
      clip: z.strictObject({ startSec: z.number().min(0), endSec: z.number().gt(0), fit: z.enum(["contain", "cover"]) }).optional(),
      provenance: z
        .strictObject({ origin: AssetOrigin, verification: z.enum(["unverified", "user-attested"]), license: z.string().optional(), attributionRequired: z.boolean() })
        .optional(),
      license: z.string().optional(),
      attribution: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  fonts: z.array(
    z.strictObject({
      slot: z.enum(["heading", "body", "mono"]),
      family: z.string(),
      source: z.string(),
      license: z.string(),
      files: z.array(FontFaceFile).min(1),
      /** Every character of the text this slot renders is in the font's cmap. */
      coverage: z.literal("verified"),
      checkedCharacters: z.int().min(0),
    }),
  ),
  /** "narration-step": audio, if any, is produced and verified by the narrate step (Stage G). */
  narration: z.strictObject({ mode: z.enum(["tts", "user-recorded", "none"]), audio: z.enum(["none", "narration-step"]) }),
  warnings: z.array(z.string()),
});
export type AssetResolution = z.infer<typeof AssetResolutionSchema>;

// ------------------------------------------------------------------ render request and report

export const RenderSettingsSchema = z.strictObject({
  codec: z.literal("h264"),
  crf: z.int().min(1).max(51),
  pixelFormat: z.enum(["yuv420p", "yuv444p"]),
  concurrency: z.int().min(1).max(8),
  captions: z.enum(["burn-in", "off"]),
  chromeMode: z.enum(["headless-shell", "chrome-for-testing"]),
});
export type RenderSettings = z.infer<typeof RenderSettingsSchema>;

/** Output of the queue-render step: an exact, validated description of what will be rendered. */
export const RenderRequestSchema = z.strictObject({
  schemaVersion: z.literal(RENDER_SCHEMA_VERSION),
  kind: z.literal("render-request"),
  jobId: Slug,
  contentId: Slug,
  plan: z.strictObject({ weekId: z.string(), version: z.int().min(1), contentHash: Fp }),
  inputs: z.strictObject({
    manifest: z.strictObject({ path: RelativePath, sha256: Fp }),
    storyboard: z.strictObject({ path: RelativePath, sha256: Fp }),
    captions: z.strictObject({ path: RelativePath, sha256: Fp }),
    assetResolution: z.strictObject({ path: RelativePath, sha256: Fp }),
    /** Narrate step outputs (Stage G). Optional so Stage F requests stay readable. */
    narration: z.strictObject({ path: RelativePath, sha256: Fp }).optional(),
    subtitles: z.strictObject({ path: RelativePath, sha256: Fp }).optional(),
  }),
  format: z.strictObject({ width: z.int().min(240), height: z.int().min(240), fps: z.int().min(12).max(120), durationInFrames: z.int().min(1) }),
  settings: RenderSettingsSchema,
  renderer: z.strictObject({ id: z.literal("creatorflow-remotion"), version: z.string(), remotion: z.string() }),
  scenes: z.array(z.strictObject({ sceneId: z.string(), type: z.string(), component: z.string(), startFrame: z.int().min(0), durationInFrames: z.int().min(1), fallback: z.enum(["none", "text-only"]) })).min(1),
  /** What the render must contain. "narration": exactly one audio stream from the verified narration file. */
  audio: z
    .strictObject({
      expected: z.enum(["none", "narration"]),
      file: z.strictObject({ path: RelativePath, sha256: Fp, durationMs: z.int().min(1), sampleRate: z.int(), channels: z.int() }).optional(),
    })
    .optional(),
  captionsTiming: z.enum(["estimated", "sentence-aligned", "word-aligned"]).optional(),
  /** Video clips placed in scenes, with the validated trim window. */
  clips: z
    .array(
      z.strictObject({
        sceneId: z.string(),
        assetId: AssetId,
        sha256: Fp,
        startSec: z.number().min(0),
        endSec: z.number().gt(0),
        fit: z.enum(["contain", "cover"]),
        /** Seconds of the clip actually shown (scene length may be shorter than the window). */
        playSec: z.number().gt(0),
        /** Seconds the last frame is held because the clip is shorter than the scene. */
        holdSec: z.number().min(0),
        sourceAudio: z.enum(["none", "muted"]),
      }),
    )
    .optional(),
  warnings: z.array(z.string()),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const MediaInspectionSchema = z.strictObject({
  performed: z.boolean(),
  tool: z.string().optional(),
  /** Why inspection was skipped (e.g. no ffprobe). */
  reason: z.string().optional(),
  container: z.strictObject({ ok: z.boolean(), boxes: z.array(z.string()), problem: z.string().optional() }),
  video: z
    .strictObject({ codec: z.string(), width: z.int(), height: z.int(), fps: z.number(), frames: z.int().optional(), durationSec: z.number(), pixelFormat: z.string().optional() })
    .optional(),
  audioStreams: z.int().min(0).optional(),
  /** First audio stream, when present. */
  audio: z.strictObject({ codec: z.string(), sampleRate: z.int().optional(), channels: z.int().optional(), durationSec: z.number().optional() }).optional(),
  matchesRequest: z.boolean().optional(),
  mismatches: z.array(z.string()),
});
export type MediaInspection = z.infer<typeof MediaInspectionSchema>;

export const RenderReportSchema = z.strictObject({
  schemaVersion: z.literal(RENDER_SCHEMA_VERSION),
  kind: z.literal("render-report"),
  jobId: Slug,
  contentId: Slug,
  plan: z.strictObject({ weekId: z.string(), version: z.int().min(1), contentHash: Fp }),
  sceneManifest: z.strictObject({ path: RelativePath, sha256: Fp }),
  request: z.strictObject({ path: RelativePath, sha256: Fp }),
  renderer: z.strictObject({ id: z.literal("creatorflow-remotion"), version: z.string(), remotion: z.string(), browser: z.string() }),
  output: z.strictObject({ path: RelativePath, sha256: Fp, bytes: z.int().min(1) }),
  expected: z.strictObject({ width: z.int(), height: z.int(), fps: z.int(), durationInFrames: z.int(), durationSec: z.number() }),
  settings: RenderSettingsSchema,
  /** Execution timestamps (real clock), unlike every upstream artifact. */
  startedAt: IsoDT,
  completedAt: IsoDT,
  renderDurationMs: z.int().min(0),
  process: z.strictObject({ exitCode: z.int() }),
  status: z.literal("rendered"),
  mediaInspection: MediaInspectionSchema,
  /**
   * present: an audio stream exists in the MP4. expected/verified (Stage G):
   * whether narration was required, and whether the decoded output audio was
   * checked (stream metadata, duration vs video, speech energy in every
   * narrated sentence window). Never "verified" just because the encoder exited 0.
   */
  audio: z.strictObject({
    present: z.boolean(),
    reason: z.string(),
    expected: z.enum(["none", "narration"]).optional(),
    verified: z.boolean().optional(),
    source: z.strictObject({ path: RelativePath, sha256: Fp, durationMs: z.int(), sampleRate: z.int(), channels: z.int() }).optional(),
    checks: z.array(z.strictObject({ check: z.string(), ok: z.boolean(), detail: z.string() })).optional(),
  }),
  captions: z.strictObject({
    burnedIn: z.boolean(),
    timing: z.enum(["estimated", "sentence-aligned", "word-aligned"]),
    cues: z.int().min(0).optional(),
    validation: z.strictObject({ ok: z.boolean(), problems: z.array(z.string()) }).optional(),
  }),
  /** Narration as requested / configured / generated (Stage G). */
  narration: z
    .strictObject({
      requested: z.enum(["tts", "user-recorded", "none"]),
      configuredProvider: z.string().nullable(),
      generated: z.boolean(),
      provider: z.strictObject({ id: z.string(), version: z.string(), voice: z.string(), language: z.string() }).optional(),
      settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      licenseNotes: z.array(z.string()).optional(),
    })
    .optional(),
  videoClips: RenderRequestSchema.shape.clips,
  assets: z.array(
    z.strictObject({
      assetId: z.string(),
      status: z.string(),
      sha256: Fp.optional(),
      registryId: z.string().optional(),
      license: z.string().optional(),
      origin: z.string().optional(),
      verification: z.string().optional(),
    }),
  ),
  fonts: z.array(z.strictObject({ slot: z.string(), family: z.string(), coverage: z.literal("verified") })),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  /** Stage H checks (editorial, audio, accessibility) have not run. */
  technicalQa: z.literal("pending"),
});
export type RenderReport = z.infer<typeof RenderReportSchema>;
