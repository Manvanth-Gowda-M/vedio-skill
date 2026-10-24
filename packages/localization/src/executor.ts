import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, sha256Hex, stringifyJson, toPosix, writeFileAtomic } from "@creatorflow/core";
import { StepError, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import {
  CanonicalScriptSchema,
  CaptionsFileSchema,
  LocalizationSetSchema,
  StoryboardSchema,
  validateArtifact,
  type CanonicalScript,
  type EditorialIssue,
  type LocalizationVariant,
  type SubtitleTrack,
} from "@creatorflow/schemas";
import { baseLanguage, buildSubtitleTrack, estimateSpeechSec, SCRIPT_OUTPUTS, speechRateFor, targetLanguages, timedSegments } from "@creatorflow/scriptwriter";
import { buildGlossary, checkTranslation, EXPECTED_SCRIPT, readTranslationHash, translationPath } from "./translation.ts";

export const LOCALIZE_OUTPUTS = { variants: "localize/variants.json", subtitles: "localize/subtitles.json" } as const;

// ------------------------------------------------------------------ provider interface

export interface TranslationRequest {
  script: CanonicalScript;
  targetLanguage: string;
}
export type TranslationResult = { ok: true; segments: { segmentId: string; narration: string; onScreenText: string }[] } | { ok: false; code: "UNSUPPORTED"; message: string };

/**
 * Machine-assisted translation providers implement this. None ships in this
 * release: the default "import-only" provider only accepts human translations
 * imported with `creatorflow localize import`.
 */
export interface TranslationProvider {
  readonly id: string;
  readonly capabilities: { translate: boolean };
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

export class ImportOnlyProvider implements TranslationProvider {
  readonly id: string;
  readonly capabilities = { translate: false };
  constructor(id = "import-only") {
    this.id = id;
  }
  async translate(r: TranslationRequest): Promise<TranslationResult> {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: this.id === "import-only" ? `No machine translation provider is configured; import a human translation for ${r.targetLanguage}` : `Localization provider "${this.id}" is not available in this release; import a human translation for ${r.targetLanguage}`,
    };
  }
}

export function translationProviderFor(id: string): TranslationProvider {
  return new ImportOnlyProvider(id);
}

// ------------------------------------------------------------------ step definition helpers

/** Languages that need an imported translation (different base language from the canonical one). */
export function translationTargets(config: FingerprintContext["config"], profile: FingerprintContext["profile"], canonicalLanguage: string): string[] {
  return targetLanguages(config, profile).filter((l) => baseLanguage(l) !== baseLanguage(canonicalLanguage));
}

export function languagesNeedingTranslation(ctx: FingerprintContext): string[] {
  return translationTargets(ctx.config, ctx.profile, ctx.item.language);
}

export function localizeStepInputs(ctx: FingerprintContext): unknown {
  return { contentId: ctx.item.contentId, language: ctx.item.language };
}

export function localizeStepConfig(ctx: FingerprintContext): unknown {
  return {
    targets: targetLanguages(ctx.config, ctx.profile),
    provider: ctx.config.localization.provider,
    subtitles: ctx.config.localization.subtitles,
    speechRateWpm: ctx.config.script.speechRateWpm,
    segmentPauseSec: ctx.config.script.segmentPauseSec,
    glossary: ctx.profile.voice.glossary,
    speakingRate: ctx.profile.voice.speakingRate,
  };
}

/** Hash of each imported translation file, so importing or editing one invalidates this step. */
export async function localizeStepExternalInputs(ctx: FingerprintContext & { workspaceDir: string }): Promise<unknown> {
  const out: Record<string, string | null> = {};
  for (const l of languagesNeedingTranslation(ctx)) out[l] = await readTranslationHash(ctx.workspaceDir, ctx.jobId, l);
  return out;
}

const fileRef = (p: string, body: string) => ({ path: p, sha256: `sha256:${sha256Hex(body)}` });

/**
 * Localize step: builds a variant for every target language and subtitle
 * tracks for each. It never succeeds while a required translation is missing,
 * stale or invalid; it blocks with the exact languages and commands instead.
 */
export async function localizeStepExecute(ctx: StepContext): Promise<StepResult> {
  const scriptRaw = await fs.readFile(ctx.outputPath(SCRIPT_OUTPUTS.script), "utf8").catch(() => undefined);
  const sbRaw = await fs.readFile(ctx.outputPath(SCRIPT_OUTPUTS.storyboard), "utf8").catch(() => undefined);
  if (scriptRaw === undefined || sbRaw === undefined) return { status: "blocked", code: "SCRIPT_MISSING", reason: "script outputs are missing; run resume to regenerate them" };
  const scriptRef = fileRef(SCRIPT_OUTPUTS.script, scriptRaw);
  if (scriptRef.sha256 !== ctx.upstream.find((u) => u.path === SCRIPT_OUTPUTS.script)?.sha256) {
    return { status: "blocked", code: "SCRIPT_MODIFIED", reason: "script/script.json changed after it was verified; run resume to re-verify the script step" };
  }
  const sv = validateArtifact(CanonicalScriptSchema, JSON.parse(scriptRaw));
  const bv = validateArtifact(StoryboardSchema, JSON.parse(sbRaw));
  if (!sv.ok || !bv.ok) throw new StepError("Script or storyboard failed schema validation", { kind: "permanent", code: "SCRIPT_INVALID" });
  const script = sv.value;
  const storyboard = bv.value;
  const glossary = buildGlossary(ctx.profile);
  const opts = { wpm: ctx.config.script.speechRateWpm, speakingRate: ctx.profile.voice.speakingRate };
  const provider = translationProviderFor(ctx.config.localization.provider);

  const variants: LocalizationVariant[] = [];
  const missing: string[] = [];
  const problems: string[] = [];
  const claimIds = new Map(script.segments.map((s) => [s.segmentId, s.claimRefs.map((c) => c.claimId)]));
  const scriptsFor = (lang: string) => (EXPECTED_SCRIPT[baseLanguage(lang)] ? [EXPECTED_SCRIPT[baseLanguage(lang)]!] : []);
  const segEstimate = (text: string, lang: string) => Math.round(estimateSpeechSec(text, lang, speechRateFor(opts.wpm, lang), opts.speakingRate) * 100) / 100;

  for (const lang of targetLanguages(ctx.config, ctx.profile)) {
    if (lang === script.language || baseLanguage(lang) === baseLanguage(script.language)) {
      const same = lang === script.language;
      const issues: EditorialIssue[] = same ? [] : [{ severity: "info", code: "NO_REGIONAL_ADAPTATION", message: `Same language as ${script.language}; text is identical and no regional adaptation was performed` }];
      variants.push({
        language: lang,
        sourceLanguage: script.language,
        canonicalScriptSha256: scriptRef.sha256,
        provider: same ? "canonical" : "same-language",
        status: same ? "source" : "adapted",
        review: same ? "not-applicable" : "unreviewed",
        title: script.title,
        segments: script.segments.map((s) => ({ segmentId: s.segmentId, narration: s.narration, onScreenText: s.onScreenText, claimIds: claimIds.get(s.segmentId)!, estimatedSec: segEstimate(s.narration, lang) })),
        requiredScripts: scriptsFor(lang),
        issues,
      });
      continue;
    }
    const file = translationPath(ctx.workspaceDir, ctx.jobId, lang);
    let data: unknown;
    try {
      data = await readJsonFile(file);
    } catch {
      const t = await provider.translate({ script, targetLanguage: lang });
      if (!t.ok) {
        missing.push(lang);
        continue;
      }
      throw new StepError("Machine translation results are not supported in this release", { kind: "permanent", code: "UNSUPPORTED" });
    }
    const check = checkTranslation(data, { script, sha256: scriptRef.sha256 }, glossary, { ...opts, expectedLanguage: lang });
    if (!check.ok || !check.value) {
      const first = check.issues.find((i) => i.severity === "error");
      problems.push(`${lang}: ${check.stale ? "translation is stale (made from an older script)" : `${first?.code}: ${first?.message}`}`);
      continue;
    }
    const t = check.value;
    const raw = await fs.readFile(file, "utf8");
    variants.push({
      language: lang,
      sourceLanguage: script.language,
      canonicalScriptSha256: scriptRef.sha256,
      provider: "human-import",
      status: "translated",
      review: t.review ? "reviewed-claimed-by-importer" : "unreviewed",
      ...(t.review ? { reviewer: t.review.reviewer } : {}),
      translationFile: { path: toPosix(path.relative(ctx.workspaceDir, file)), sha256: `sha256:${sha256Hex(raw)}` },
      title: t.title || script.title,
      segments: script.segments.map((s) => {
        const tr = t.segments.find((x) => x.segmentId === s.segmentId)!;
        return { segmentId: s.segmentId, narration: tr.narration, onScreenText: tr.onScreenText, claimIds: claimIds.get(s.segmentId)!, estimatedSec: segEstimate(tr.narration, lang) };
      }),
      requiredScripts: scriptsFor(lang),
      issues: check.issues.filter((i) => i.severity !== "error"),
    });
  }

  if (missing.length || problems.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing translation(s): ${missing.join(", ")} (provider "${provider.id}" cannot translate). Create one with: ${missing.map((l) => `creatorflow localize template --job ${ctx.jobId} --lang ${l}`).join(" ; ")}`);
    if (problems.length) parts.push(`invalid translation(s): ${problems.join("; ")}`);
    return { status: "blocked", code: missing.length ? "NEEDS_TRANSLATION" : "TRANSLATION_INVALID", reason: parts.join(". ") };
  }

  const tracks: SubtitleTrack[] = variants.map((v) => {
    const texts = new Map(v.segments.map((s) => [s.segmentId, s.narration]));
    return buildSubtitleTrack(v.language, v.provider === "canonical" ? "canonical" : "localized", timedSegments(storyboard, texts, ctx.config.script.segmentPauseSec), ctx.config.localization.subtitles);
  });
  const set = validateArtifact(LocalizationSetSchema, { schemaVersion: 1, kind: "localization-variants", contentId: script.contentId, script: scriptRef, glossary, variants, fontCoverage: "not-verified" });
  const subs = validateArtifact(CaptionsFileSchema, { schemaVersion: 1, kind: "subtitle-tracks", contentId: script.contentId, script: scriptRef, tracks });
  if (!set.ok) throw new StepError(`Localization set invalid: ${set.issues[0]?.path}: ${set.issues[0]?.message}`, { kind: "permanent", code: "LOCALIZATION_INVALID" });
  if (!subs.ok) throw new StepError(`Subtitle tracks invalid: ${subs.issues[0]?.path}: ${subs.issues[0]?.message}`, { kind: "permanent", code: "SUBTITLES_INVALID" });
  if (ctx.signal.aborted) throw ctx.signal.reason;
  await fs.mkdir(path.dirname(ctx.outputPath(LOCALIZE_OUTPUTS.variants)), { recursive: true });
  await writeFileAtomic(ctx.outputPath(LOCALIZE_OUTPUTS.variants), stringifyJson(set.value));
  await writeFileAtomic(ctx.outputPath(LOCALIZE_OUTPUTS.subtitles), stringifyJson(subs.value));
  return {
    status: "succeeded",
    metadata: {
      variants: variants.length,
      translated: variants.filter((v) => v.status === "translated").length,
      unreviewed: variants.filter((v) => v.review === "unreviewed").length,
      subtitleWarnings: tracks.reduce((n, t) => n + t.warnings.length, 0),
    },
  };
}
