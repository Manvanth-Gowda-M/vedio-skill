import { z } from "zod";
import { LanguageTag, RelativePath, Slug } from "./common.ts";

export const VOICE_SCHEMA_VERSION = 1 as const;

const Fp = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected sha256:<64 hex>");
const SegId = z.string().regex(/^seg-\d{2}-[a-z]+$/);
const SceneId = z.string().regex(/^scn-\d{2}$/);

export const TimingMethod = z.enum(["estimated", "sentence-aligned", "word-aligned"]);
export type TimingMethod = z.infer<typeof TimingMethod>;

/**
 * Output of the narrate step: narration/narration.json.
 *
 * - status "silent": the profile asked for no narration (voice.mode "none").
 *   The scene timeline is the script's estimate and no audio exists.
 * - status "generated": narration/voice.wav was synthesised by a local provider
 *   from the verified script text, measured, and the scene timeline and
 *   captions were derived from the measured speech of each sentence.
 */
export const NarrationRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(VOICE_SCHEMA_VERSION),
    kind: z.literal("narration"),
    jobId: Slug,
    contentId: Slug,
    script: z.strictObject({ path: RelativePath, sha256: Fp }),
    manifest: z.strictObject({ path: RelativePath, sha256: Fp }),
    status: z.enum(["silent", "generated"]),
    requested: z.strictObject({
      mode: z.enum(["tts", "user-recorded", "none"]),
      provider: z.string().nullable(),
      voiceId: z.string().nullable(),
      speakingRate: z.number(),
      language: LanguageTag,
    }),
    provider: z
      .strictObject({
        id: z.string(),
        version: z.string(),
        engine: z.string(),
        offline: z.literal(true),
        voice: z.strictObject({ id: z.string(), name: z.string(), language: z.string(), gender: z.string().optional() }),
        license: z.strictObject({ engine: z.string(), voice: z.string(), notes: z.array(z.string()) }),
      })
      .optional(),
    /** What was requested and what the provider actually applied (never claimed if unsupported). */
    settings: z
      .strictObject({
        speakingRate: z.strictObject({ requested: z.number(), applied: z.string() }),
        sampleRate: z.int(),
        channels: z.literal(1),
        bitsPerSample: z.literal(16),
        sentencePauseMs: z.int(),
        segmentPauseMs: z.int(),
        leadInMs: z.int(),
        tailMs: z.int(),
        gainDb: z.number(),
      })
      .optional(),
    audio: z
      .strictObject({
        path: RelativePath,
        sha256: Fp,
        bytes: z.int().min(45),
        format: z.literal("wav-pcm-s16le"),
        sampleRate: z.int(),
        channels: z.literal(1),
        durationMs: z.int().min(1),
        peakDbfs: z.number(),
        rmsDbfs: z.number(),
        clippedSamples: z.int().min(0),
      })
      .optional(),
    timing: z.strictObject({
      method: TimingMethod,
      fps: z.int().min(12).max(120),
      durationInFrames: z.int().min(1),
      durationMs: z.int().min(1),
      scenes: z.array(z.strictObject({ sceneId: SceneId, startFrame: z.int().min(0), durationInFrames: z.int().min(1) })).min(1),
      note: z.string(),
    }),
    segments: z.array(
      z.strictObject({
        segmentId: SegId,
        sceneId: SceneId,
        startMs: z.int().min(0),
        endMs: z.int().min(1),
        sentences: z
          .array(
            z.strictObject({
              index: z.int().min(0),
              /** Exact script text (captions use this). */
              text: z.string().min(1),
              /** Text sent to the engine when a glossary pronunciation was substituted. */
              spoken: z.string().optional(),
              startMs: z.int().min(0),
              endMs: z.int().min(1),
              /** Measured speech boundaries inside [startMs, endMs). */
              speechStartMs: z.int().min(0),
              speechEndMs: z.int().min(1),
            }),
          )
          .min(1),
      }),
    ),
    pronunciations: z.array(z.strictObject({ term: z.string(), pronunciation: z.string(), occurrences: z.int().min(0) })),
    subtitles: z.strictObject({ path: RelativePath, sha256: Fp }),
    warnings: z.array(z.string()),
  })
  .superRefine((n, ctx) => {
    if ((n.status === "generated") !== Boolean(n.audio && n.provider && n.settings)) ctx.addIssue({ code: "custom", path: ["status"], message: "generated narration needs audio, provider and settings; silent narration has none" });
    if (n.status === "silent" && n.timing.method !== "estimated") ctx.addIssue({ code: "custom", path: ["timing", "method"], message: "silent narration has estimated timing" });
    let f = 0;
    n.timing.scenes.forEach((s, i) => {
      if (s.startFrame !== f) ctx.addIssue({ code: "custom", path: ["timing", "scenes", i, "startFrame"], message: `Expected ${f}` });
      f += s.durationInFrames;
    });
    if (f !== n.timing.durationInFrames) ctx.addIssue({ code: "custom", path: ["timing", "durationInFrames"], message: "Does not equal the sum of scene frames" });
    let last = 0;
    n.segments.forEach((seg, i) =>
      seg.sentences.forEach((s, j) => {
        const p = ["segments", i, "sentences", j];
        if (s.startMs < last) ctx.addIssue({ code: "custom", path: [...p, "startMs"], message: "Sentences must be ordered and must not overlap" });
        if (!(s.startMs <= s.speechStartMs && s.speechStartMs < s.speechEndMs && s.speechEndMs <= s.endMs)) ctx.addIssue({ code: "custom", path: p, message: "Speech must lie inside the sentence window" });
        if (s.endMs > n.timing.durationMs) ctx.addIssue({ code: "custom", path: [...p, "endMs"], message: "Sentence ends after the audio" });
        last = s.endMs;
      }),
    );
    if (n.audio && Math.abs(n.audio.durationMs - n.timing.durationMs) > 1) ctx.addIssue({ code: "custom", path: ["audio", "durationMs"], message: "Audio duration must equal the timeline duration" });
  });
export type NarrationRecord = z.infer<typeof NarrationRecordSchema>;
