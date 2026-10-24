import { z } from "zod";
import {
  DurationRange,
  HexColor,
  IanaTimezone,
  LanguageTag,
  PlatformId,
  RelativePath,
  Weekday,
} from "./common.ts";

export const PROFILE_SCHEMA_VERSION = 1 as const;

const FontSpec = z.strictObject({
  family: z.string().min(1),
  /** Where the font comes from; drives licensing checks and deterministic rendering. */
  source: z.enum(["bundled", "local-file", "system", "google-fonts"]),
  /** SPDX id or short licence name, e.g. "OFL-1.1". "unknown" is flagged by doctor. */
  license: z.string().min(1).default("unknown"),
  path: RelativePath.optional(),
});

const GlossaryEntry = z.strictObject({
  term: z.string().min(1),
  /** How TTS should say it (plain respelling or IPA). */
  pronunciation: z.string().min(1).optional(),
  /** Never translate this term (product names, CLI flags). */
  doNotTranslate: z.boolean().default(true),
  languages: z.array(LanguageTag).optional(),
  notes: z.string().optional(),
  /** Stage E (optional, no default): what kind of term this is. */
  category: z.enum(["product", "technical", "brand", "other"]).optional(),
  /** Stage E (optional, no default): preferred rendering per language, e.g. { "hi-IN": "..." }. */
  preferred: z.record(LanguageTag, z.string().min(1).max(200)).optional(),
});

export const VisualStyle = z.enum([
  "motion-typography",
  "technical-diagrams",
  "code-demos",
  "screen-recordings",
  "licensed-b-roll",
  "comparison-layouts",
]);

export const CreatorProfileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
    creator: z.strictObject({
      displayName: z.string().min(1).max(80),
      niche: z.string().min(3).max(200),
      topics: z.array(z.string().min(2)).min(1).max(30),
      audience: z.strictObject({
        description: z.string().min(3).max(500),
        expertise: z.enum(["beginner", "intermediate", "advanced", "mixed"]).default("mixed"),
      }),
    }),
    languages: z.strictObject({
      primary: LanguageTag,
      additional: z.array(LanguageTag).max(10).default([]),
    }),
    platforms: z.strictObject({
      primary: PlatformId,
      secondary: z.array(PlatformId).default([]),
    }),
    brand: z.strictObject({
      name: z.string().min(1).max(80),
      colors: z.strictObject({
        primary: HexColor,
        secondary: HexColor,
        accent: HexColor,
        background: HexColor,
        text: HexColor,
      }),
      fonts: z.strictObject({ heading: FontSpec, body: FontSpec, mono: FontSpec }),
      logoPath: RelativePath.optional(),
    }),
    visual: z.strictObject({
      styles: z.array(VisualStyle).min(1),
      animationIntensity: z.enum(["low", "medium", "high"]).default("medium"),
    }),
    voice: z.strictObject({
      /** "tts" uses the configured TTS provider; "none" renders captions/music only. */
      mode: z.enum(["tts", "user-recorded", "none"]),
      voiceId: z.string().optional(),
      speakingRate: z.number().min(0.5).max(2).default(1),
      glossary: z.array(GlossaryEntry).default([]),
    }),
    schedule: z.strictObject({
      weeklyTarget: z.int().min(1).max(14).default(7),
      timezone: IanaTimezone,
      publishDays: z.array(Weekday).max(7).optional(),
      durations: z.strictObject({ shortForm: DurationRange, longForm: DurationRange }),
    }),
    content: z.strictObject({
      restrictions: z.array(z.string().min(1)).default([]),
      avoidTopics: z.array(z.string().min(1)).default([]),
      /** Max age of a source for "news" items before it is flagged stale. */
      newsFreshnessDays: z.int().min(1).max(90).default(14),
      requireSourcesForClaims: z.literal(true).default(true),
    }),
    approval: z.strictObject({
      requirePlanApproval: z.boolean().default(true),
      requireFinalReview: z.boolean().default(true),
      /** v1 never publishes. Kept explicit so the boundary is visible in config. */
      publishing: z.literal("manual-only").default("manual-only"),
    }),
  })
  .superRefine((p, ctx) => {
    if (p.languages.additional.includes(p.languages.primary)) {
      ctx.addIssue({ code: "custom", path: ["languages", "additional"], message: "Must not repeat the primary language" });
    }
    if (new Set(p.languages.additional).size !== p.languages.additional.length) {
      ctx.addIssue({ code: "custom", path: ["languages", "additional"], message: "Contains duplicates" });
    }
    if (p.platforms.secondary.includes(p.platforms.primary)) {
      ctx.addIssue({ code: "custom", path: ["platforms", "secondary"], message: "Must not repeat the primary platform" });
    }
    const days = p.schedule.publishDays;
    if (days && new Set(days).size !== days.length) {
      ctx.addIssue({ code: "custom", path: ["schedule", "publishDays"], message: "Contains duplicate days" });
    }
  });

export type CreatorProfile = z.infer<typeof CreatorProfileSchema>;
export type CreatorProfileInput = z.input<typeof CreatorProfileSchema>;
