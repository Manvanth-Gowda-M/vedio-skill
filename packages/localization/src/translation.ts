import { promises as fs } from "node:fs";
import { assertSafeId, resolveWithin, sha256Hex } from "@creatorflow/core";
import {
  TranslationImportSchema,
  validateArtifact,
  type CanonicalScript,
  type CreatorProfile,
  type EditorialIssue,
  type TerminologyGlossary,
  type TranslationImport,
} from "@creatorflow/schemas";
import { baseLanguage, estimateSpeechSec, speechRateFor } from "@creatorflow/scriptwriter";

/** Expected writing system by base language (extend as needed). Used for warnings only. */
export const EXPECTED_SCRIPT: Record<string, string> = {
  hi: "Devanagari",
  mr: "Devanagari",
  ne: "Devanagari",
  sa: "Devanagari",
  kn: "Kannada",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  bn: "Bengali",
  as: "Bengali",
  gu: "Gujarati",
  pa: "Gurmukhi",
  or: "Oriya",
  ur: "Arabic",
  ar: "Arabic",
  en: "Latin",
  es: "Latin",
  fr: "Latin",
  de: "Latin",
  pt: "Latin",
};

/** Share of letters (\p{L}) in a given Unicode script. Combining marks are ignored. */
export function scriptShare(text: string, script: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const re = new RegExp(`\\p{Script=${script}}`, "u");
  return letters.filter((l) => re.test(l)).length / letters.length;
}

// Bidi overrides/isolates and other invisible format characters, but NOT ZWJ/ZWNJ,
// which Indic scripts legitimately need.
const UNSAFE_CHARS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u2060-\u2064\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

export function buildGlossary(profile: CreatorProfile): TerminologyGlossary {
  return {
    schemaVersion: 1,
    kind: "terminology-glossary",
    terms: profile.voice.glossary.map((g) => ({
      term: g.term,
      category: g.category ?? "other",
      doNotTranslate: g.doNotTranslate,
      ...(g.pronunciation ? { pronunciation: g.pronunciation } : {}),
      preferred: { ...(g.preferred ?? {}) },
      ...(g.languages ? { languages: g.languages } : {}),
      ...(g.notes ? { notes: g.notes } : {}),
    })),
  };
}

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

export interface TranslationCheck {
  ok: boolean;
  stale: boolean;
  issues: EditorialIssue[];
  /** NFC-normalised import, present when the file parsed. */
  value?: TranslationImport;
}

/**
 * Validates a human translation against the current canonical script.
 * It checks structure and consistency, never quality: a translation that
 * passes is still "unreviewed" unless the importer states a review.
 */
export function checkTranslation(
  data: unknown,
  canonical: { script: CanonicalScript; sha256: string },
  glossary: TerminologyGlossary,
  opts: { wpm: Readonly<Record<string, number>>; speakingRate: number; expectedLanguage?: string },
): TranslationCheck {
  const script = canonical.script;
  const issues: EditorialIssue[] = [];
  const err = (code: string, message: string, segmentId?: string) => issues.push({ severity: "error", code, message, ...(segmentId ? { segmentId } : {}) });
  const warn = (code: string, message: string, segmentId?: string) => issues.push({ severity: "warning", code, message, ...(segmentId ? { segmentId } : {}) });
  const v = validateArtifact(TranslationImportSchema, data);
  if (!v.ok) {
    for (const i of v.issues) err("TRANSLATION_SCHEMA", `${i.path}: ${i.message}`);
    return { ok: false, stale: false, issues };
  }
  const t: TranslationImport = {
    ...v.value,
    ...(v.value.title ? { title: v.value.title.normalize("NFC") } : {}),
    segments: v.value.segments.map((s) => ({ segmentId: s.segmentId, narration: s.narration.normalize("NFC"), onScreenText: s.onScreenText.normalize("NFC") })),
  };
  delete t.instructions;
  if (!t.title) warn("TITLE_NOT_TRANSLATED", "No translated title; the canonical title will be used");
  if (t.contentId !== script.contentId) err("TRANSLATION_WRONG_CONTENT", `Translation is for ${t.contentId}, not ${script.contentId}`);
  if (opts.expectedLanguage && t.language !== opts.expectedLanguage) err("TRANSLATION_WRONG_LANGUAGE", `Translation is ${t.language}, expected ${opts.expectedLanguage}`);
  if (t.language === script.language) err("TRANSLATION_SAME_LANGUAGE", `Translation language equals the canonical language ${script.language}`);
  try {
    assertSafeId(t.language.toLowerCase(), "language");
  } catch {
    err("TRANSLATION_SCHEMA", "language tag is not usable as a file name");
  }
  const stale = t.canonicalScriptSha256 !== canonical.sha256;
  if (stale) err("TRANSLATION_STALE", "Translation was made from a different version of the canonical script; regenerate the template and update changed segments");

  const bySegment = new Map(script.segments.map((s) => [s.segmentId, s]));
  const seen = new Set<string>();
  const sameBase = baseLanguage(t.language) === baseLanguage(script.language);
  const expected = EXPECTED_SCRIPT[baseLanguage(t.language)];
  const wpm = speechRateFor(opts.wpm, t.language);
  for (const s of t.segments) {
    const c = bySegment.get(s.segmentId);
    if (seen.has(s.segmentId)) err("TRANSLATION_DUPLICATE_SEGMENT", `${s.segmentId} appears more than once`, s.segmentId);
    seen.add(s.segmentId);
    if (!c) {
      err("TRANSLATION_UNKNOWN_SEGMENT", `${s.segmentId} is not in the canonical script`, s.segmentId);
      continue;
    }
    for (const [field, text] of [["narration", s.narration], ["onScreenText", s.onScreenText]] as const) {
      if (UNSAFE_CHARS.test(text)) err("UNSAFE_CHARACTERS", `${field} contains invisible control or bidi-override characters`, s.segmentId);
      if (/\bTODO\b|\bTRANSLATE ME\b/i.test(text)) err("TRANSLATION_PLACEHOLDER", `${field} still contains a placeholder`, s.segmentId);
    }
    if (!sameBase && norm(s.narration) === norm(c.narration)) err("UNTRANSLATED_SEGMENT", "Narration is identical to the canonical text; copying is not translation", s.segmentId);
    for (const g of glossary.terms) {
      if (g.languages && !g.languages.includes(t.language)) continue;
      const inSource = c.narration.includes(g.term) || c.onScreenText.includes(g.term);
      if (!inSource) continue;
      const preferred = g.preferred[t.language];
      if (g.doNotTranslate && !s.narration.includes(g.term) && !(preferred && s.narration.includes(preferred))) err("GLOSSARY_TERM_MISSING", `"${g.term}" must stay untranslated`, s.segmentId);
      else if (!g.doNotTranslate && preferred && !s.narration.includes(preferred)) warn("GLOSSARY_PREFERRED_NOT_USED", `Preferred ${t.language} term for "${g.term}" is "${preferred}"`, s.segmentId);
    }
    if (expected && expected !== "Latin") {
      // Text with no letters but "?"/U+FFFD is what a wrong-encoding save produces.
      if (/\uFFFD/.test(s.narration) || (/\?{3,}/.test(s.narration) && scriptShare(s.narration, expected) === 0)) {
        err("TEXT_ENCODING_DAMAGED", `Narration contains '???' or replacement characters and no ${expected} letters; the file was probably saved in a non-UTF-8 encoding`, s.segmentId);
      } else if (scriptShare(s.narration, expected) < 0.3) warn("SCRIPT_MISMATCH", `Narration is mostly not in ${expected} script`, s.segmentId);
    }
    const est = estimateSpeechSec(s.narration, t.language, wpm, opts.speakingRate);
    if (est > c.timing.estimatedSec * 1.25) warn("LOCALIZED_TOO_LONG", `Estimated ${est.toFixed(1)}s of speech for a ${c.timing.estimatedSec}s scene; the scene may need retiming`, s.segmentId);
  }
  for (const id of bySegment.keys()) if (!seen.has(id)) err("TRANSLATION_MISSING_SEGMENT", `${id} is not translated`, id);
  return { ok: !issues.some((i) => i.severity === "error"), stale, issues, value: t };
}

export function translationPath(workspaceDir: string, jobId: string, language: string): string {
  return resolveWithin(resolveWithin(resolveWithin(workspaceDir, "localization"), assertSafeId(jobId, "job id")), `${assertSafeId(language.toLowerCase(), "language")}.json`);
}

export async function readTranslationHash(workspaceDir: string, jobId: string, language: string): Promise<string | null> {
  try {
    return `sha256:${sha256Hex(await fs.readFile(translationPath(workspaceDir, jobId, language)))}`;
  } catch {
    return null;
  }
}

/** Template a translator fills in. Narration is blank on purpose so an unfilled template cannot be imported. */
export function translationTemplate(script: CanonicalScript, scriptSha256: string, language: string): Record<string, unknown> {
  return {
    $schema: "translation-import.schema.json",
    kind: "translation",
    contentId: script.contentId,
    language,
    canonicalScriptSha256: scriptSha256,
    translator: { name: "", method: "human" },
    title: "",
    instructions:
      "Fill in translator.name, title, and narration + onScreenText for every segment in the target language. Keep glossary product names untranslated. The source fields are for reference and are ignored on import. Do not change segment IDs or canonicalScriptSha256.",
    segments: script.segments.map((s) => ({ segmentId: s.segmentId, narration: "", onScreenText: "", source: { narration: s.narration, onScreenText: s.onScreenText } })),
  };
}
