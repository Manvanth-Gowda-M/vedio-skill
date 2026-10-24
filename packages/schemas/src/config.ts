import { z } from "zod";
import { EnvVarName, LanguageTag, RelativePath, Slug } from "./common.ts";

export const CONFIG_SCHEMA_VERSION = 1 as const;

export const ProviderKind = z.enum(["research", "llm", "tts", "image", "video", "storage", "publishing"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

const OptionValue = z.union([z.string(), z.number(), z.boolean()]);

export const ProviderRefSchema = z.strictObject({
  /** Provider adapter id, e.g. "manual-sources", "local-fs", "none". */
  id: Slug,
  enabled: z.boolean().default(true),
  /** Declares the provider may incur charges; requires budget.allowPaidProviders. */
  paid: z.boolean().default(false),
  /** Environment variable that holds the credential. The value is never stored here. */
  apiKeyEnv: EnvVarName.optional(),
  timeoutMs: z.int().min(1000).max(600_000).default(60_000),
  maxRetries: z.int().min(0).max(5).default(2),
  options: z.record(z.string(), OptionValue).default({}),
});
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

/** Free/local defaults. "none" means the capability is intentionally unavailable. */
export const DEFAULT_PROVIDERS: Record<ProviderKind, { id: string }> = {
  research: { id: "manual-sources" },
  llm: { id: "agent-host" },
  tts: { id: "none" },
  image: { id: "none" },
  video: { id: "none" },
  storage: { id: "local-fs" },
  publishing: { id: "package-only" },
};

export const CreatorFlowConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    profilePath: RelativePath.default("creator-profile.json"),
    workspaceDir: RelativePath.default("workspace"),
    hardware: z
      .strictObject({
        maxConcurrentRenders: z.int().min(1).max(8).default(1),
        /** Optional explicit binaries; otherwise PATH / Remotion's managed browser is used. */
        browserExecutable: z.string().optional(),
        ffmpegPath: z.string().optional(),
        ffprobePath: z.string().optional(),
      })
      .default({ maxConcurrentRenders: 1 }),
    providers: z.strictObject({
      research: ProviderRefSchema.prefault(DEFAULT_PROVIDERS.research),
      llm: ProviderRefSchema.prefault(DEFAULT_PROVIDERS.llm),
      tts: ProviderRefSchema.prefault(DEFAULT_PROVIDERS.tts),
      image: ProviderRefSchema.prefault(DEFAULT_PROVIDERS.image),
      video: ProviderRefSchema.prefault(DEFAULT_PROVIDERS.video),
      storage: ProviderRefSchema.prefault(DEFAULT_PROVIDERS.storage),
      publishing: ProviderRefSchema.prefault(DEFAULT_PROVIDERS.publishing),
    }).prefault({}),
    budget: z
      .strictObject({
        currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
        monthlyLimit: z.number().min(0).default(0),
        allowPaidProviders: z.boolean().default(false),
      })
      .default({ currency: "USD", monthlyLimit: 0, allowPaidProviders: false }),
    offline: z
      .strictObject({
        preferOffline: z.boolean().default(true),
        allowNetworkResearch: z.boolean().default(false),
      })
      .default({ preferOffline: true, allowNetworkResearch: false }),
    logging: z
      .strictObject({ level: z.enum(["debug", "info", "warn", "error"]).default("info") })
      .default({ level: "info" }),
    /** Retry and timeout policy for workflow steps (Stage C). Optional; defaults apply. */
    workflow: z
      .strictObject({
        /** Attempts per retry budget, including the first try. */
        maxAttempts: z.int().min(1).max(10).default(3),
        backoffBaseMs: z.int().min(0).max(600_000).default(2_000),
        backoffMaxMs: z.int().min(0).max(3_600_000).default(60_000),
        defaultStepTimeoutMs: z.int().min(100).max(24 * 3_600_000).default(30 * 60_000),
        /** Per-step overrides keyed by step id, e.g. { "render": 3600000 }. */
        stepTimeoutMs: z.record(Slug, z.int().min(100).max(24 * 3_600_000)).default({}),
      })
      .prefault({}),
    /** Topic scoring and eligibility (Stage D). Optional; defaults apply. */
    research: z
      .strictObject({
        weights: z
          .strictObject({
            freshness: z.number().min(0).max(1).default(0.3),
            relevance: z.number().min(0).max(1).default(0.25),
            evidence: z.number().min(0).max(1).default(0.2),
            originality: z.number().min(0).max(1).default(0.15),
            feasibility: z.number().min(0).max(1).default(0.1),
          })
          .prefault({})
          .refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-6, "Weights must sum to 1"),
        /** Minimum number of supported fact claims a candidate needs. */
        minSupportedFacts: z.int().min(1).max(10).default(1),
        /** If true, facts only count when an excerpt was found in a local snapshot. */
        requireSnapshotMatch: z.boolean().default(false),
        /** Terms that make a candidate ineligible (case-insensitive, whole words). */
        blockedTerms: z.array(z.string().min(2).max(100)).max(200).default([]),
        /** Points (0-100 scale) subtracted per already-selected item of the same category. */
        diversityPenalty: z.number().min(0).max(50).default(10),
        /** Topic-token Jaccard similarity at or above which two candidates are duplicates. */
        duplicateSimilarity: z.number().min(0.3).max(1).default(0.6),
      })
      .prefault({}),
    /** Script generation (Stage E). Optional; defaults apply. */
    script: z
      .strictObject({
        provider: Slug.default("template"),
        /** Words per minute by BCP 47 tag or base language; "default" is the fallback. Estimates only. */
        speechRateWpm: z.record(z.string().regex(/^(default|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/), z.number().min(40).max(400)).default({ default: 150 }),
        segmentPauseSec: z.number().min(0).max(5).default(0.4),
        minSegmentSec: z.number().min(0.5).max(10).default(2),
        /** Below this fraction of the target duration the script is a "duration shortfall". */
        minDurationRatio: z.number().min(0).max(1).default(0.6),
        maxDurationRatio: z.number().min(1).max(3).default(1.2),
        onDurationShortfall: z.enum(["warn", "block"]).default("warn"),
        callToAction: z.string().min(3).max(200).optional(),
        maxExplanationSegments: z.int().min(1).max(20).default(6),
        fps: z.int().min(12).max(120).default(30),
      })
      .prefault({}),
    /** Rendering (Stage F). Optional; defaults apply. Timeout: workflow.stepTimeoutMs.render. */
    render: z
      .strictObject({
        codec: z.literal("h264").default("h264"),
        /** x264 constant rate factor: lower is higher quality and larger files. */
        crf: z.int().min(1).max(51).default(18),
        pixelFormat: z.enum(["yuv420p", "yuv444p"]).default("yuv420p"),
        /** Browser tabs rendering frames in parallel. Capped by hardware.maxConcurrentRenders. */
        concurrency: z.int().min(1).max(8).default(1),
        captions: z.enum(["burn-in", "off"]).default("burn-in"),
        /** Never download a browser unless explicitly allowed; use a local Chrome/Edge instead. */
        allowBrowserDownload: z.boolean().default(false),
      })
      .prefault({}),
    /** Technical QA thresholds (Stage H). Optional; defaults apply. */
    qa: z
      .strictObject({
        maxOutputBytes: z.int().min(1024).max(16 * 1024 * 1024 * 1024).default(4 * 1024 * 1024 * 1024),
        /** Allowed difference between measured and expected video duration, in frames. */
        durationToleranceFrames: z.number().min(0).max(10).default(1.5),
        /** Allowed difference between audio and video duration, seconds. */
        audioDurationToleranceSec: z.number().min(0).max(5).default(0.1),
        /** Extra frame samples every N seconds (on top of start/middle/end and per-scene samples). */
        sampleEverySec: z.number().min(1).max(600).default(10),
        maxSamples: z.int().min(3).max(200).default(60),
        /** A frame is "nearly uniform" when its luma std-dev is below this AND uniformFraction is above blankUniformFraction. */
        blankStdDev: z.number().min(0).max(50).default(2.5),
        blankUniformFraction: z.number().min(0.5).max(1).default(0.995),
        /** Fractions of the frame that must stay free of text-like foreground pixels. */
        safeMargins: z
          .strictObject({ top: z.number().min(0).max(0.3).default(0.03), bottom: z.number().min(0).max(0.3).default(0.03), left: z.number().min(0).max(0.3).default(0.04), right: z.number().min(0).max(0.3).default(0.04) })
          .prefault({}),
        minContrast: z.number().min(1).max(21).default(4.5),
        /** Minimum font size as a fraction of the shorter frame side (0.022 = 24 px at 1080). */
        minFontFraction: z.number().min(0.005).max(0.2).default(0.022),
        speechFloorDbfs: z.number().min(-90).max(-10).default(-45),
        silenceFloorDbfs: z.number().min(-90).max(-10).default(-50),
        /** Silence inside a narrated sentence longer than this is a dropout. */
        maxDropoutMs: z.int().min(100).max(10_000).default(1000),
        /** Planned pauses longer than this are flagged for review. */
        maxPauseMs: z.int().min(500).max(60_000).default(3000),
        maxClippedRatio: z.number().min(0).max(0.1).default(0.001),
        maxOutputMbPerMinute: z.number().min(1).max(10_000).default(400),
        timeoutMs: z.int().min(10_000).max(4 * 3_600_000).default(20 * 60_000),
      })
      .prefault({}),
    /** Asset registration and validation limits (Stage G). Optional; defaults apply. */
    assets: z
      .strictObject({
        maxImageBytes: z.int().min(1024).max(200 * 1024 * 1024).default(25 * 1024 * 1024),
        maxVideoBytes: z.int().min(1024).max(8 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
        maxVideoDurationSec: z.number().gt(0).max(4 * 3600).default(600),
        maxVideoWidth: z.int().min(16).max(8192).default(3840),
        maxVideoHeight: z.int().min(16).max(8192).default(2160),
        maxVideoFps: z.number().gt(0).max(240).default(120),
        /** Video codecs accepted for clips. Tested: h264, vp8, vp9. */
        videoCodecs: z.array(z.enum(["h264", "vp8", "vp9", "hevc", "av1"])).min(1).default(["h264", "vp8", "vp9"]),
        /** "full": decode every video frame once to detect corruption; "sample": first and last second only. */
        decodeCheck: z.enum(["full", "sample"]).default("full"),
        /** Upper bound for probing and decoding one video file. */
        probeTimeoutMs: z.int().min(1000).max(3_600_000).default(180_000),
      })
      .prefault({}),
    /**
     * Narration (Stage G). The provider is providers.tts.id: "none" (default),
     * "windows-sapi" (built-in Windows voices) or "piper" (user-installed binary + model).
     * Whether narration is wanted is creator-profile voice.mode.
     */
    voice: z
      .strictObject({
        sampleRate: z.int().min(8000).max(48000).default(22050),
        sentencePauseMs: z.int().min(0).max(3000).default(250),
        segmentPauseMs: z.int().min(0).max(5000).default(450),
        leadInMs: z.int().min(0).max(3000).default(200),
        tailMs: z.int().min(0).max(5000).default(700),
        /** Minimum on-screen time of a scene even when its narration is shorter. */
        minSceneMs: z.int().min(300).max(10_000).default(1500),
        maxSentenceChars: z.int().min(50).max(5000).default(600),
        maxTotalSec: z.number().gt(0).max(7200).default(900),
        /** Peak normalisation target; gain is limited by maxGainDb and never pushes samples past it. */
        targetPeakDbfs: z.number().min(-20).max(-0.1).default(-1),
        maxGainDb: z.number().min(0).max(24).default(12),
        windowsSapi: z.strictObject({ powershell: z.string().optional() }).prefault({}),
        piper: z
          .strictObject({
            /** piper executable (rhasspy/piper C++ CLI: text on stdin, --output_file). Never downloaded. */
            executable: z.string().optional(),
            /** Arguments placed before CreatorFlow's own (e.g. a wrapper script). */
            extraArgs: z.array(z.string().max(500)).max(20).default([]),
            /** Voice model (.onnx); its .onnx.json config must sit next to it. */
            model: z.string().optional(),
            speaker: z.int().min(0).optional(),
          })
          .prefault({}),
      })
      .prefault({}),
    /** Localization and subtitles (Stage E). Optional; defaults apply. */
    localization: z
      .strictObject({
        provider: Slug.default("import-only"),
        /** "profile": primary + additional profile languages. Or an explicit list of BCP 47 tags. */
        targetLanguages: z.union([z.literal("profile"), z.array(LanguageTag).min(1).max(20)]).default("profile"),
        subtitles: z
          .strictObject({
            maxCharsPerLine: z.int().min(10).max(80).default(42),
            maxLines: z.int().min(1).max(3).default(2),
            /** Reading-speed warning threshold, characters (graphemes) per second. */
            maxCps: z.number().min(5).max(40).default(17),
            minCueMs: z.int().min(300).max(5000).default(1000),
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    for (const [kind, ref] of Object.entries(c.providers)) {
      if (ref.enabled && ref.paid && !c.budget.allowPaidProviders) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", kind, "paid"],
          message: `Paid provider "${ref.id}" is enabled but budget.allowPaidProviders is false`,
        });
      }
      if (ref.enabled && ref.paid && c.budget.monthlyLimit <= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["budget", "monthlyLimit"],
          message: `Paid provider "${ref.id}" requires a monthlyLimit greater than 0`,
        });
      }
    }
    if (c.providers.publishing.id !== "package-only") {
      ctx.addIssue({
        code: "custom",
        path: ["providers", "publishing", "id"],
        message: 'Only "package-only" publishing is supported in this release; public publishing is out of scope',
      });
    }
  });

export type CreatorFlowConfig = z.infer<typeof CreatorFlowConfigSchema>;
export type CreatorFlowConfigInput = z.input<typeof CreatorFlowConfigSchema>;
