import { z } from "zod";

/** BCP 47 language tag (pragmatic subset: "en", "hi", "pt-BR", "zh-Hans"). */
export const LanguageTag = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/, "Expected a BCP 47 tag such as en, hi or pt-BR");

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a #RRGGBB colour");

export const Slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens");

/** Name of an environment variable holding a secret (never the secret itself). */
export const EnvVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, "Expected an UPPER_SNAKE_CASE environment variable name");

/** Workspace-relative path; absolute paths and traversal are rejected. */
export const RelativePath = z
  .string()
  .min(1)
  .refine((p) => !/^([a-zA-Z]:|[\\/])/.test(p), "Must be a relative path")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "Must not contain '..'");

export const IanaTimezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA time zone");

export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/**
 * Output targets. Adding a platform means adding it here plus a publishing
 * adapter; validation rejects unknown platforms instead of guessing specs.
 */
export const PlatformId = z.enum([
  "youtube-long",
  "youtube-shorts",
  "instagram-reels",
  "tiktok",
  "linkedin-video",
]);
export type PlatformId = z.infer<typeof PlatformId>;

export const DurationRange = z
  .strictObject({
    minSec: z.int().min(5).max(7200),
    maxSec: z.int().min(5).max(7200),
  })
  .refine((r) => r.minSec <= r.maxSec, { message: "minSec must be <= maxSec", path: ["minSec"] });
