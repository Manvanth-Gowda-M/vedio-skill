import { z } from "zod";
import { CreatorFlowConfigSchema } from "./config.ts";
import { CreatorProfileSchema } from "./profile.ts";
import { PlanningRunSchema, ResearchEvidencePackSchema, ResearchInputDocSchema, ResearchSessionSchema } from "./research.ts";
import { CanonicalScriptSchema, CaptionsFileSchema, LocalizationSetSchema, SceneManifestSchema, StoryboardSchema, TerminologyGlossarySchema, TranslationImportSchema } from "./script.ts";
import { AssetRegistrySchema, AssetResolutionSchema, RenderReportSchema, RenderRequestSchema } from "./render.ts";
import { NarrationRecordSchema } from "./voice.ts";
import { QaReportSchema, ReviewDecisionSchema, ReviewManifestSchema, ReviewRecordSchema } from "./qa.ts";
import { PackageManifestSchema, BatchReportSchema } from "./package.ts";
import { JobRecordSchema, PlanIndexSchema, PlanVersionSchema, WeeklyPlanContentSchema } from "./workflow.ts";

export * from "./common.ts";
export * from "./profile.ts";
export * from "./config.ts";
export * from "./research.ts";
export * from "./script.ts";
export * from "./render.ts";
export * from "./voice.ts";
export * from "./qa.ts";
export * from "./package.ts";
export * from "./workflow.ts";
export * from "./validate.ts";

/** Schemas exported to packages/schemas/json for editors and non-TS tooling. */
export const JSON_SCHEMA_EXPORTS = {
  "creator-profile.schema.json": CreatorProfileSchema,
  "creatorflow.config.schema.json": CreatorFlowConfigSchema,
  "weekly-plan.schema.json": WeeklyPlanContentSchema,
  "plan-version.schema.json": PlanVersionSchema,
  "plan-index.schema.json": PlanIndexSchema,
  "job-record.schema.json": JobRecordSchema,
  "research-input.schema.json": ResearchInputDocSchema,
  "research-session.schema.json": ResearchSessionSchema,
  "planning-run.schema.json": PlanningRunSchema,
  "research-evidence.schema.json": ResearchEvidencePackSchema,
  "canonical-script.schema.json": CanonicalScriptSchema,
  "storyboard.schema.json": StoryboardSchema,
  "scene-manifest.schema.json": SceneManifestSchema,
  "subtitle-tracks.schema.json": CaptionsFileSchema,
  "terminology-glossary.schema.json": TerminologyGlossarySchema,
  "translation-import.schema.json": TranslationImportSchema,
  "localization-variants.schema.json": LocalizationSetSchema,
  "asset-registry.schema.json": AssetRegistrySchema,
  "asset-resolution.schema.json": AssetResolutionSchema,
  "render-request.schema.json": RenderRequestSchema,
  "render-report.schema.json": RenderReportSchema,
  "narration.schema.json": NarrationRecordSchema,
  "qa-report.schema.json": QaReportSchema,
  "qa-review-manifest.schema.json": ReviewManifestSchema,
  "review-decision.schema.json": ReviewDecisionSchema,
  "review-record.schema.json": ReviewRecordSchema,
  "package-manifest.schema.json": PackageManifestSchema,
  "batch-report.schema.json": BatchReportSchema,
} as const;

/** JSON Schema (draft 2020-12) describing the *input* shape (defaults optional). */
export function toJsonSchema(schema: z.ZodType, id: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
  return { $id: `https://creatorflow.local/schemas/${id}`, ...json };
}
