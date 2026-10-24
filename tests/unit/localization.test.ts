// Translation import validation and provider behaviour. Translations below are short
// FIXTURE sentences written for tests; they are not production-quality translations.
import { describe, expect, it } from "vitest";
import { sha256Hex, stringifyJson } from "@creatorflow/core";
import { buildGlossary, checkTranslation, ImportOnlyProvider, scriptShare, translationProviderFor, translationTemplate, translationTargets } from "@creatorflow/localization";
import { TemplateScriptProvider } from "@creatorflow/scriptwriter";
import { TranslationImportSchema, type CanonicalScript } from "@creatorflow/schemas";
import { makeConfig, makeProfile, makeRequest } from "../fixtures/script-fixture.ts";

const profile = makeProfile({
  voice: {
    mode: "none",
    glossary: [
      { term: "Example Tools", category: "product", doNotTranslate: true },
      { term: "tool call", category: "technical", doNotTranslate: false, preferred: { "hi-IN": "टूल कॉल" } },
    ],
  },
});
const glossary = buildGlossary(profile);
const opts = { wpm: { default: 150 }, speakingRate: 1 };

async function canonical(): Promise<{ script: CanonicalScript; sha256: string }> {
  const r = await new TemplateScriptProvider().generate(makeRequest({ profile }));
  if (!r.ok) throw new Error(r.message);
  return { script: r.script, sha256: `sha256:${sha256Hex(stringifyJson(r.script))}` };
}

const SAMPLE: Record<string, (i: number) => string> = {
  "hi-IN": (i) => `Example Tools के अनुसार यह खंड ${i} का परीक्षण अनुवाद है, टूल कॉल सहित।`,
  "kn-IN": (i) => `Example Tools ಪ್ರಕಾರ ಇದು ವಿಭಾಗ ${i} ರ ಪರೀಕ್ಷಾ ಅನುವಾದ.`,
  "ta-IN": (i) => `Example Tools படி இது பகுதி ${i} இன் சோதனை மொழிபெயர்ப்பு.`,
  "te-IN": (i) => `Example Tools ప్రకారం ఇది విభాగం ${i} యొక్క పరీక్ష అనువాదం.`,
  "ml-IN": (i) => `Example Tools പ്രകാരം ഇത് ഭാഗം ${i} ന്റെ പരീക്ഷണ വിവർത്തനം.`,
};

function translation(c: { script: CanonicalScript; sha256: string }, language: string, edit?: (t: any) => void) {
  const t: any = translationTemplate(c.script, c.sha256, language);
  t.translator.name = "Fixture translator";
  t.title = SAMPLE[language]!(0);
  t.segments = t.segments.map((s: any, i: number) => ({ ...s, narration: SAMPLE[language]!(i + 1), onScreenText: SAMPLE[language]!(i + 1) }));
  edit?.(t);
  return t;
}

describe("translation import validation", () => {
  it.each(Object.keys(SAMPLE))("accepts a complete, aligned %s translation and keeps it unreviewed", async (lang) => {
    const c = await canonical();
    const r = checkTranslation(translation(c, lang), c, glossary, { ...opts, expectedLanguage: lang });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.value!.review).toBeUndefined();
    expect(r.issues.some((i) => i.code === "SCRIPT_MISMATCH")).toBe(false);
  });

  it("the template itself cannot be imported unfilled, and its reference fields are optional", async () => {
    const c = await canonical();
    const t = translationTemplate(c.script, c.sha256, "hi-IN");
    expect(TranslationImportSchema.safeParse(t).success).toBe(false);
    expect(checkTranslation(t, c, glossary, opts).issues.map((i) => i.code)).toContain("TRANSLATION_SCHEMA");
  });

  it.each([
    ["TRANSLATION_MISSING_SEGMENT", (t: any) => t.segments.pop()],
    ["TRANSLATION_UNKNOWN_SEGMENT", (t: any) => t.segments.push({ segmentId: "seg-99-outro", narration: "अतिरिक्त", onScreenText: "अतिरिक्त" })],
    ["TRANSLATION_DUPLICATE_SEGMENT", (t: any) => t.segments.push({ ...t.segments[0] })],
    ["TRANSLATION_STALE", (t: any) => (t.canonicalScriptSha256 = `sha256:${"0".repeat(64)}`)],
    ["TRANSLATION_WRONG_CONTENT", (t: any) => (t.contentId = "other-video")],
    ["GLOSSARY_TERM_MISSING", (t: any) => (t.segments[1].narration = "उदाहरण टूल्स के अनुसार हुक्स हर टूल कॉल से पहले और बाद में चलते हैं।")],
    ["TRANSLATION_PLACEHOLDER", (t: any) => (t.segments[2].narration = "TODO")],
    ["UNSAFE_CHARACTERS", (t: any) => (t.segments[0].narration = `Example Tools \u202E परीक्षण`)],
    ["TEXT_ENCODING_DAMAGED", (t: any) => (t.segments[0].narration = "Example Tools ???? ??? ????")],
  ])("rejects %s", async (code, edit) => {
    const c = await canonical();
    const r = checkTranslation(translation(c, "hi-IN", edit), c, glossary, { ...opts, expectedLanguage: "hi-IN" });
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.severity === "error").map((i) => i.code)).toContain(code);
  });

  it("copying the English text is not accepted as translation", async () => {
    const c = await canonical();
    const copied = translation(c, "hi-IN", (t) => (t.segments = c.script.segments.map((s) => ({ segmentId: s.segmentId, narration: s.narration, onScreenText: s.onScreenText }))));
    const r = checkTranslation(copied, c, glossary, { ...opts, expectedLanguage: "hi-IN" });
    expect(r.issues.filter((i) => i.code === "UNTRANSLATED_SEGMENT")).toHaveLength(c.script.segments.length);
  });

  it("warns (not errors) on wrong script, unused preferred term and long localized narration", async () => {
    const c = await canonical();
    const r = checkTranslation(
      translation(c, "hi-IN", (t) => {
        t.segments[1].narration = "Example Tools ke anusaar hooks har tool call se pehle aur baad mein chalte hain aur yeh vaakya bahut lamba hai taaki samay seema se adhik ho jaaye.";
      }),
      c,
      glossary,
      { ...opts, expectedLanguage: "hi-IN" },
    );
    const w = r.issues.filter((i) => i.severity === "warning" && i.segmentId === c.script.segments[1]!.segmentId).map((i) => i.code);
    expect(w).toEqual(expect.arrayContaining(["SCRIPT_MISMATCH", "GLOSSARY_PREFERRED_NOT_USED", "LOCALIZED_TOO_LONG"]));
    expect(r.ok).toBe(true);
  });

  it("normalises to NFC and records an importer-stated review without treating it as verified", async () => {
    const c = await canonical();
    const decomposed = "Example Tools परीक्षण".normalize("NFD") + " क़";
    const r = checkTranslation(translation(c, "hi-IN", (t) => {
      t.segments[0].narration = decomposed;
      t.review = { reviewer: "A. Reviewer", reviewedAt: "2026-10-23" };
    }), c, glossary, opts);
    expect(r.value!.segments[0]!.narration).toBe(decomposed.normalize("NFC"));
    expect(r.value!.review!.reviewer).toBe("A. Reviewer");
  });

  it("measures script share per letter", () => {
    expect(scriptShare("हुक्स हर टूल", "Devanagari")).toBe(1);
    expect(scriptShare("ಕನ್ನಡ abc", "Kannada")).toBeCloseTo(4 / 7, 3); // 4 Kannada letters (virama is a mark), 3 Latin
    expect(scriptShare("12345", "Tamil")).toBe(0);
  });
});

describe("localization targets and providers", () => {
  it("derives targets from the profile or explicit config; same base language needs no translation", () => {
    const p = makeProfile({ languages: { primary: "en", additional: ["en-IN", "hi-IN", "kn-IN"] } });
    expect(translationTargets(makeConfig(), p, "en")).toEqual(["hi-IN", "kn-IN"]);
    expect(translationTargets(makeConfig({ localization: { targetLanguages: ["ta-IN", "te-IN", "ml-IN", "en-IN"] } }), p, "en")).toEqual(["ta-IN", "te-IN", "ml-IN"]);
  });

  it("no machine translation is available: providers return a typed UNSUPPORTED result", async () => {
    const c = await canonical();
    expect(new ImportOnlyProvider().capabilities.translate).toBe(false);
    expect(await translationProviderFor("import-only").translate({ script: c.script, targetLanguage: "kn-IN" })).toMatchObject({ ok: false, code: "UNSUPPORTED", message: expect.stringContaining("import a human translation for kn-IN") });
    expect(await translationProviderFor("cloud-mt").translate({ script: c.script, targetLanguage: "hi-IN" })).toMatchObject({ ok: false, code: "UNSUPPORTED", message: expect.stringContaining('"cloud-mt" is not available') });
  });
});
