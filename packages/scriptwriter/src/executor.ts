import { promises as fs } from "node:fs";
import path from "node:path";
import { fingerprint, sha256Hex, stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { StepError, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import {
  CanonicalScriptSchema,
  CaptionsFileSchema,
  ResearchEvidencePackSchema,
  SceneManifestSchema,
  StoryboardSchema,
  validateArtifact,
  type ResearchEvidencePack,
} from "@creatorflow/schemas";
import { buildCanonicalCaptions, buildSceneManifest } from "./manifest.ts";
import { scriptProviderFor } from "./provider.ts";
import { buildStoryboard } from "./storyboard.ts";
import { validateScriptAgainstEvidence } from "./validate.ts";

export const SCRIPT_OUTPUTS = {
  script: "script/script.json",
  storyboard: "script/storyboard.json",
  captions: "script/captions.json",
  manifest: "script/scene-manifest.json",
} as const;
export const EVIDENCE_PATH = "research/evidence.json";

/** Item fields the script depends on. Research inputs are separate, so a new hook does not redo research. */
export function scriptStepInputs(ctx: FingerprintContext): unknown {
  const i = ctx.item;
  return {
    contentId: i.contentId,
    topic: i.topic,
    workingTitle: i.workingTitle ?? null,
    audienceProblem: i.audienceProblem ?? null,
    angle: i.angle ?? null,
    hook: i.hook ?? null,
    takeaway: i.takeaway ?? null,
    category: i.category,
    platform: i.platform,
    aspectRatio: i.aspectRatio ?? null,
    language: i.language,
    durationSec: i.durationSec,
    requiredAssets: i.requiredAssets,
  };
}

export function scriptStepConfig(ctx: FingerprintContext): unknown {
  const p = ctx.profile;
  return {
    script: ctx.config.script,
    subtitles: ctx.config.localization.subtitles,
    targetLanguages: ctx.config.localization.targetLanguages === "profile" ? [p.languages.primary, ...p.languages.additional] : ctx.config.localization.targetLanguages,
    brand: p.brand,
    visual: p.visual,
    voice: { mode: p.voice.mode, voiceId: p.voice.voiceId ?? null, speakingRate: p.voice.speakingRate, glossary: p.voice.glossary },
  };
}

const ref = (p: string, body: string) => ({ path: p, sha256: `sha256:${sha256Hex(body)}` });

/** The script workflow step: evidence pack -> canonical script, storyboard, captions, scene manifest. */
export async function scriptStepExecute(ctx: StepContext): Promise<StepResult> {
  const evidenceRaw = await fs.readFile(ctx.outputPath(EVIDENCE_PATH), "utf8").catch(() => undefined);
  const upstreamRec = ctx.upstream.find((u) => u.path === EVIDENCE_PATH);
  if (evidenceRaw === undefined || !upstreamRec) return { status: "blocked", code: "EVIDENCE_MISSING", reason: "research/evidence.json is missing; re-run research for this job" };
  const evidenceRef = ref(EVIDENCE_PATH, evidenceRaw);
  if (evidenceRef.sha256 !== upstreamRec.sha256) return { status: "blocked", code: "EVIDENCE_MODIFIED", reason: "research/evidence.json changed after the research step verified it; run resume again to re-verify research" };
  const parsed = validateArtifact(ResearchEvidencePackSchema, JSON.parse(evidenceRaw));
  if (!parsed.ok) throw new StepError(`Evidence pack is invalid: ${parsed.issues[0]?.path}: ${parsed.issues[0]?.message}`, { kind: "permanent", code: "EVIDENCE_INVALID" });
  const pack: ResearchEvidencePack = parsed.value;
  if (pack.contentId !== ctx.item.contentId || (ctx.item.research && pack.evidenceHash !== ctx.item.research.evidenceHash)) {
    return { status: "blocked", code: "RESEARCH_CHANGED", reason: "the evidence pack does not belong to the approved plan item; re-run research" };
  }

  const provider = scriptProviderFor(ctx.config.script.provider);
  const result = await provider.generate({
    jobId: ctx.jobId,
    item: ctx.item,
    itemHash: fingerprint(ctx.item),
    plan: ctx.plan,
    evidence: pack,
    evidenceFile: evidenceRef,
    profile: ctx.profile,
    config: ctx.config,
  });
  if (!result.ok) {
    const code = result.code === "UNSUPPORTED_LANGUAGE" ? "SCRIPT_LANGUAGE_UNSUPPORTED" : result.code === "INSUFFICIENT_EVIDENCE" ? "NEEDS_MORE_RESEARCH" : "SCRIPT_PROVIDER_UNAVAILABLE";
    const hint = code === "SCRIPT_LANGUAGE_UNSUPPORTED" ? " Plan this item in English and add the language as a localization target, or wait for a provider that writes this language." : "";
    return { status: "blocked", code, reason: `${result.message}.${hint}` };
  }
  const script = result.script;
  const errors = validateScriptAgainstEvidence(script, pack).filter((i) => i.severity === "error");
  if (errors.length) throw new StepError(`Generated script failed evidence validation: ${errors.map((e) => `${e.code} ${e.segmentId ?? ""} ${e.message}`).join("; ")}`, { kind: "permanent", code: "SCRIPT_INVALID" });
  const shortfall = script.editorial.issues.find((i) => i.code === "DURATION_SHORTFALL" && i.severity === "error");
  if (shortfall) return { status: "blocked", code: "SCRIPT_DURATION_SHORTFALL", reason: shortfall.message };

  const scriptBody = stringifyJson(script);
  const scriptRef = ref(SCRIPT_OUTPUTS.script, scriptBody);
  const storyboard = buildStoryboard(script, scriptRef, ctx.item, ctx.profile);
  const sb = validateArtifact(StoryboardSchema, storyboard);
  if (!sb.ok) throw new StepError(`Storyboard is invalid: ${sb.issues[0]?.path}: ${sb.issues[0]?.message}`, { kind: "permanent", code: "STORYBOARD_INVALID" });
  const storyboardBody = stringifyJson(sb.value);
  const storyboardRef = ref(SCRIPT_OUTPUTS.storyboard, storyboardBody);
  const captions = buildCanonicalCaptions(script, scriptRef, sb.value, ctx.config);
  const cv = validateArtifact(CaptionsFileSchema, captions);
  if (!cv.ok) throw new StepError(`Captions are invalid: ${cv.issues[0]?.path}: ${cv.issues[0]?.message}`, { kind: "permanent", code: "CAPTIONS_INVALID" });
  const captionsBody = stringifyJson(cv.value);
  const captionsRef = ref(SCRIPT_OUTPUTS.captions, captionsBody);
  const manifest = buildSceneManifest({ jobId: ctx.jobId, script, scriptRef, storyboard: sb.value, storyboardRef, captions: cv.value, captionsRef, profile: ctx.profile, config: ctx.config });
  const mv = validateArtifact(SceneManifestSchema, manifest);
  if (!mv.ok) throw new StepError(`Scene manifest is invalid: ${mv.issues[0]?.path}: ${mv.issues[0]?.message}`, { kind: "permanent", code: "MANIFEST_INVALID" });
  const sv = validateArtifact(CanonicalScriptSchema, script);
  if (!sv.ok) throw new StepError(`Script is invalid: ${sv.issues[0]?.path}: ${sv.issues[0]?.message}`, { kind: "permanent", code: "SCRIPT_INVALID" });

  if (ctx.signal.aborted) throw ctx.signal.reason;
  await fs.mkdir(path.dirname(ctx.outputPath(SCRIPT_OUTPUTS.script)), { recursive: true });
  await writeFileAtomic(ctx.outputPath(SCRIPT_OUTPUTS.script), scriptBody);
  await writeFileAtomic(ctx.outputPath(SCRIPT_OUTPUTS.storyboard), storyboardBody);
  await writeFileAtomic(ctx.outputPath(SCRIPT_OUTPUTS.captions), captionsBody);
  await writeFileAtomic(ctx.outputPath(SCRIPT_OUTPUTS.manifest), stringifyJson(mv.value));
  const warnings = script.editorial.issues.filter((i) => i.severity === "warning").length;
  return {
    status: "succeeded",
    metadata: {
      format: script.format,
      segments: script.segments.length,
      scenes: sb.value.scenes.length,
      estimatedSec: script.estimatedDurationSec,
      targetSec: script.targetDurationSec,
      editorialStatus: script.editorial.status,
      warnings,
      unregisteredAssets: sb.value.assets.filter((a) => a.status === "required-unregistered").length,
    },
  };
}
