// Script provider, evidence validation, storyboard, manifest and subtitles. FICTIONAL evidence; no network.
import { describe, expect, it } from "vitest";
import { sha256Hex, stringifyJson } from "@creatorflow/core";
import {
  CanonicalScriptSchema,
  SceneManifestSchema,
  StoryboardSchema,
  SubtitleTrackSchema,
  validateArtifact,
  type CanonicalScript,
} from "@creatorflow/schemas";
import {
  buildCanonicalCaptions,
  buildSceneManifest,
  buildStoryboard,
  buildSubtitleTrack,
  chooseFormat,
  estimateSpeechSec,
  graphemeLength,
  scriptProviderFor,
  speechRateFor,
  SubtitleExportError,
  TemplateScriptProvider,
  toSrt,
  toVtt,
  validateScriptAgainstEvidence,
  wordCount,
  wrapText,
} from "@creatorflow/scriptwriter";
import { makeConfig, makeItem, makePack, makeProfile, makeRequest } from "../fixtures/script-fixture.ts";

const provider = new TemplateScriptProvider();
async function gen(req = makeRequest()): Promise<CanonicalScript> {
  const r = await provider.generate(req);
  if (!r.ok) throw new Error(r.message);
  return r.script;
}
const ref = (p: string, v: unknown) => ({ path: p, sha256: `sha256:${sha256Hex(stringifyJson(v))}` });
const codes = (issues: { code: string; severity: string }[], sev = "error") => issues.filter((i) => i.severity === sev).map((i) => i.code);

describe("text and timing (Unicode-aware)", () => {
  it("counts graphemes, not code units, and never separates a mark from its base (Indic scripts)", () => {
    // Exact cluster counts depend on the ICU Unicode version (conjunct rules changed in Unicode 15.1),
    // so test invariants instead of pinned numbers.
    for (const w of ["क्षत्रिय", "ಕನ್ನಡ", "தமிழ்", "తెలుగు", "മലയാളം", "ਪੰਜਾਬੀ", "বাংলা"]) {
      expect(graphemeLength(w)).toBeLessThan(w.length);
      for (const g of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(w)) expect(g.segment).not.toMatch(/^\p{M}/u);
    }
    expect(graphemeLength("👩🏽‍💻")).toBe(1);
    expect(graphemeLength("abc")).toBe(3);
  });

  it("wraps at word boundaries without dropping text, in any script", () => {
    for (const [text, lang] of [
      ["Hooks run before and after each tool call, every single time.", "en"],
      ["हुक्स हर टूल कॉल से पहले और बाद में चलते हैं।", "hi"],
      ["ಹುಕ್‌ಗಳು ಪ್ರತಿಯೊಂದು ಟೂಲ್ ಕರೆಯ ಮೊದಲು ಮತ್ತು ನಂತರ ಚಲಿಸುತ್ತವೆ.", "kn"],
      ["ஹூக்குகள் ஒவ்வொரு கருவி அழைப்புக்கும் முன்னும் பின்னும் இயங்கும்.", "ta"],
    ] as const) {
      const w = wrapText(text, lang, 16);
      expect(w.lines.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
      for (const l of w.lines) if (!w.overlong) expect(graphemeLength(l)).toBeLessThanOrEqual(16);
    }
    const long = wrapText("supercalifragilisticexpialidocious ok", "en", 10);
    expect(long).toEqual({ lines: ["supercalifragilisticexpialidocious", "ok"], overlong: true });
  });

  it("estimates speech duration with configurable per-language rates", () => {
    const rates = { default: 150, hi: 120, "kn-IN": 110 };
    expect(speechRateFor(rates, "en-IN")).toBe(150);
    expect(speechRateFor(rates, "hi-IN")).toBe(120);
    expect(speechRateFor(rates, "kn-IN")).toBe(110);
    expect(wordCount("Hooks run before and after each tool call.", "en")).toBe(8);
    expect(estimateSpeechSec("one two three four five six seven eight nine ten", "en", 150)).toBeCloseTo(4);
    expect(estimateSpeechSec("one two three four five six seven eight nine ten", "en", 150, 2)).toBeCloseTo(2);
    expect(wordCount("हुक्स हर टूल कॉल से पहले चलते हैं", "hi")).toBe(8);
  });
});

describe("template script provider", () => {
  it("is deterministic", async () => {
    expect(stringifyJson(await gen())).toBe(stringifyJson(await gen()));
  });

  it("produces a valid, evidence-consistent short explainer", async () => {
    const s = await gen();
    expect(CanonicalScriptSchema.safeParse(s).success).toBe(true);
    expect(s).toMatchObject({ format: "short-explainer", timingStatus: "estimated", evidenceAsOf: "2026-10-28", language: "en" });
    expect(s.segments.map((x) => x.purpose)).toEqual(["hook", "explanation", "explanation", "explanation", "explanation", "takeaway", "outro"]);
    expect(validateScriptAgainstEvidence(s, makePack())).toEqual([]);
    const hooks = s.segments.find((x) => x.claimRefs[0]?.claimId === "clm-c-hooks")!;
    expect(hooks.narration).toBe("According to Example Tools: Hooks run before and after each tool call.");
    expect(s.segments.find((x) => x.claimRefs[0]?.claimId === "clm-c-opinion")!.narration).toBe("One interpretation: Hooks are the most underrated agent feature.");
    expect(s.segments.find((x) => x.claimRefs[0]?.claimId === "clm-c-hypo")!.narration).toBe("An open question: Hooks may replace some CI checks.");
    expect(s.segments.find((x) => x.claimRefs[0]?.claimId === "clm-c-config")!.editorialNotes.join(" ")).toContain("verify before publishing");
    expect(s.attributions.find((a) => a.sourceId === "src-docs")).toMatchObject({ requiredText: "Example Tools documentation", usageRestrictions: ["Quote at most two sentences"] });
    expect(s.segments[0]!.textOrigin).toEqual(["plan"]);
  });

  it.each([
    [{ category: "news" }, "news-update", "title-intro"],
    [{ category: "tutorial" }, "tutorial", "code-terminal-demo"],
    [{ category: "comparison", platform: "youtube-long", aspectRatio: "16:9", durationSec: 300 }, "comparison", "comparison-layout"],
    [{ category: "explainer", platform: "youtube-long", aspectRatio: "16:9", durationSec: 300 }, "long-explainer", "source-quote"],
    [{ category: "recap" }, "evergreen-explainer", "concept-explanation"],
  ])("chooses structure for %o", async (over, format, sceneType) => {
    const item = makeItem({ ...over, audienceProblem: "You cannot see what your agent runs" });
    expect(chooseFormat(item)).toBe(format);
    const s = await gen(makeRequest({ item }));
    expect(s.format).toBe(format);
    expect(s.segments.some((x) => x.visual.sceneType === sceneType)).toBe(true);
    expect(validateScriptAgainstEvidence(s, makePack())).toEqual([]);
    if (format === "tutorial") expect(s.segments.filter((x) => x.purpose === "demonstration")).toHaveLength(2);
    if (format === "news-update") expect(s.segments[1]!.narration).toContain("The source is Example Tools, dated 2026-10-22.");
    if (format === "long-explainer") expect(s.segments.find((x) => x.visual.sceneType === "source-quote")!.narration).toBe('In the source\'s own words: "Hooks run before and after each tool call."');
  });

  it("never pads: a short evidence base gives a duration shortfall, configurable to block", async () => {
    const item = makeItem({ durationSec: 60 });
    const pack = makePack({ claims: [makePack().claims[0]!] });
    const s = await gen(makeRequest({ item, pack }));
    expect(s.editorial.status).toBe("duration-shortfall");
    expect(codes(s.editorial.issues, "warning")).toContain("DURATION_SHORTFALL");
    expect(s.estimatedDurationSec).toBeLessThan(36);
    const blocked = await gen(makeRequest({ item, pack, config: makeConfig({ script: { onDurationShortfall: "block" } }) }));
    expect(codes(blocked.editorial.issues)).toEqual(["DURATION_SHORTFALL"]);
  });

  it("drops optional segments (never facts it needs) to fit, and records which", async () => {
    const s = await gen(makeRequest({ item: makeItem({ durationSec: 15 }) }));
    expect(s.droppedSegments.length).toBeGreaterThan(0);
    expect(s.droppedSegments.every((d) => /^seg-\d{2}-/.test(d.segmentId))).toBe(true);
    expect(s.segments.some((x) => x.claimRefs.some((r) => r.claimId === "clm-c-hooks"))).toBe(true);
    expect(s.segments.map((x) => x.purpose)).toContain("takeaway");
    expect(validateScriptAgainstEvidence(s, makePack())).toEqual([]);
  });

  it("omits context rather than inventing it, and flags risky creator wording", async () => {
    const plain = await gen();
    expect(plain.editorial.issues.find((i) => i.code === "NO_CONTEXT")).toBeDefined();
    const risky = await gen(makeRequest({ item: makeItem({ hook: "The fastest agent of 2026 — you won't believe it!!", takeaway: "Studies show hooks save 50% of time." }) }));
    const w = risky.editorial.issues.filter((i) => i.severity === "warning").map((i) => `${i.code}:${i.segmentId}`);
    expect(w).toEqual(expect.arrayContaining(["POSSIBLE_UNSUPPORTED_ASSERTION:seg-01-hook", "CLICKBAIT_WORDING:seg-01-hook", "POSSIBLE_UNSUPPORTED_ASSERTION:" + risky.segments.find((s) => s.purpose === "takeaway")!.segmentId]));
    // Template-only wording triggers no heuristics.
    const tmpl = await gen(makeRequest({ item: makeItem({ hook: undefined }) }));
    expect(tmpl.editorial.issues.filter((i) => i.code === "POSSIBLE_UNSUPPORTED_ASSERTION" || i.code === "CLICKBAIT_WORDING")).toEqual([]);
  });

  it("refuses unsupported languages and evidence without supported facts; unknown providers are unavailable", async () => {
    expect(await provider.generate(makeRequest({ item: makeItem({ language: "hi" }) }))).toMatchObject({ ok: false, code: "UNSUPPORTED_LANGUAGE" });
    const weak = makePack({ claims: [makePack().claims[2]!] });
    expect(await provider.generate(makeRequest({ pack: weak }))).toMatchObject({ ok: false, code: "INSUFFICIENT_EVIDENCE" });
    expect(await scriptProviderFor("gpt-writer").generate(makeRequest())).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  });
});

describe("evidence validation of scripts (provider-independent)", () => {
  it.each([
    ["UNKNOWN_CLAIM", (s: CanonicalScript) => void (s.segments[1]!.claimRefs[0]!.claimId = "clm-invented")],
    ["CLAIM_TEXT_ALTERED", (s: CanonicalScript) => void (s.segments[1]!.narration = "According to Example Tools: Hooks run before every tool call and are 10x faster.")],
    ["CLAIM_STATUS_MISMATCH", (s: CanonicalScript) => void (s.segments[1]!.claimRefs[0]!.support = "supported-unchecked")],
    ["CLAIM_USAGE_MISMATCH", (s: CanonicalScript) => void (s.segments[1]!.claimRefs[0]!.usage = "present-as-question")],
    ["OPINION_AS_FACT", (s: CanonicalScript) => void (s.segments.find((x) => x.claimRefs[0]?.claimId === "clm-c-opinion")!.narration = "According to Example Tools: Hooks are the most underrated agent feature.")],
    ["UNKNOWN_SOURCE", (s: CanonicalScript) => void s.segments[1]!.sourceRefs.push("src-made-up")],
    ["ATTRIBUTION_ALTERED", (s: CanonicalScript) => void (s.attributions.find((a) => a.sourceId === "src-docs")!.requiredText = "Docs")],
    ["ATTRIBUTION_ALTERED", (s: CanonicalScript) => void (s.attributions.find((a) => a.sourceId === "src-changelog")!.requiredText = "Invented attribution")],
    ["RESTRICTIONS_DROPPED", (s: CanonicalScript) => void (s.attributions.find((a) => a.sourceId === "src-docs")!.usageRestrictions = [])],
    ["EVIDENCE_MISMATCH", (s: CanonicalScript) => void (s.evidence.evidenceHash = `sha256:${"9".repeat(64)}`)],
    ["FACT_WITHOUT_CLAIM", (s: CanonicalScript) => void (s.segments[1]!.claimRefs = [])],
  ])("detects %s", async (code, mutate) => {
    const s = structuredClone(await gen());
    mutate(s);
    expect(codes(validateScriptAgainstEvidence(s, makePack()))).toContain(code);
  });

  it("rejects facts the evidence no longer supports, and unverified quotes", async () => {
    const s = await gen(makeRequest({ item: makeItem({ platform: "youtube-long", aspectRatio: "16:9", durationSec: 300 }) }));
    const weaker = makePack();
    weaker.claims[0]!.support = "weak";
    weaker.claims[0]!.evidence[0]!.check = "not-found-in-snapshot";
    const c = codes(validateScriptAgainstEvidence(s, weaker));
    expect(c).toEqual(expect.arrayContaining(["CLAIM_NOT_SUPPORTED", "QUOTE_NOT_VERIFIED", "CLAIM_STATUS_MISMATCH"]));
  });

  it("schemas reject markup and template syntax in script text", async () => {
    const s = structuredClone(await gen());
    s.segments[0]!.onScreenText = "<script>alert(1)</script>";
    expect(CanonicalScriptSchema.safeParse(s).success).toBe(false);
    s.segments[0]!.onScreenText = "Hello ${process.env.KEY}";
    expect(CanonicalScriptSchema.safeParse(s).success).toBe(false);
  });
});

describe("storyboard and scene manifest", () => {
  async function build(itemOver: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}) {
    const item = makeItem(itemOver);
    const profile = makeProfile(profileOver);
    const config = makeConfig();
    const script = await gen(makeRequest({ item, profile, config }));
    const scriptRef = ref("script/script.json", script);
    const sb = buildStoryboard(script, scriptRef, item, profile);
    const captions = buildCanonicalCaptions(script, scriptRef, sb, config);
    const manifest = buildSceneManifest({ jobId: "2026-w44-hooks-explained", script, scriptRef, storyboard: sb, storyboardRef: ref("script/storyboard.json", sb), captions, captionsRef: ref("script/captions.json", captions), profile, config });
    return { item, script, sb, captions, manifest };
  }

  it("maps segments to ordered, contiguous scenes with safe areas and layout checks", async () => {
    const { script, sb } = await build();
    expect(StoryboardSchema.safeParse(sb).success).toBe(true);
    expect(sb.scenes.map((s) => s.segmentIds[0])).toEqual(script.segments.map((s) => s.segmentId));
    let t = 0;
    for (const s of sb.scenes) {
      expect(s.startSec).toBeCloseTo(t, 2);
      t += s.durationSec;
    }
    expect(sb.estimatedDurationSec).toBeCloseTo(script.estimatedDurationSec, 1);
    expect(sb.scenes[0]!.safeArea).toEqual({ top: 0.1, bottom: 0.2, left: 0.06, right: 0.06 });
    expect(sb.style.faceless).toBe(true);
    expect(sb.scenes.find((s) => s.attributionSourceIds.includes("src-docs"))!.text.secondary).toBe("Source: Example Tools");
  });

  it("declares missing assets instead of inventing them", async () => {
    const { sb } = await build({ category: "tutorial", requiredAssets: ["terminal capture of the hook config", "logo of the tool"] }, { brand: { ...makeProfile().brand, logoPath: "brand/logo.png" } });
    const kinds = sb.assets.map((a) => `${a.kind}:${a.status}:${a.origin}`);
    expect(kinds).toEqual(expect.arrayContaining(["code-snippet:required-unregistered:storyboard", "code-snippet:required-unregistered:plan", "logo:required-unregistered:plan", "logo:declared-unverified:brand", "font:declared-unverified:brand"]));
    expect(sb.assets.some((a) => (a.status as string) === "available")).toBe(false);
    const plan = sb.assets.find((a) => a.assetId.startsWith("ast-plan-1"))!;
    expect(sb.scenes.filter((s) => s.assetIds.includes(plan.assetId)).every((s) => s.type === "code-terminal-demo")).toBe(true);
    expect(sb.scenes.find((s) => s.type === "code-terminal-demo")!.notes.join(" ")).toContain("not registered yet");
  });

  it("flags on-screen text that does not fit instead of truncating it", async () => {
    const long = "This working title is far too long to fit on a vertical video screen in three lines of text";
    const { sb } = await build({ workingTitle: long });
    expect(sb.scenes[0]!.text).toMatchObject({ primary: long, fits: false });
    expect(sb.scenes[0]!.notes[0]).toContain("not truncated automatically");
  });

  it("builds a declarative, validated manifest with contiguous frames and cross-references", async () => {
    const { manifest, captions, sb } = await build();
    expect(validateArtifact(SceneManifestSchema, manifest).ok).toBe(true);
    expect(manifest.format).toEqual({ platform: "youtube-shorts", aspectRatio: "9:16", width: 1080, height: 1920, fps: 30 });
    expect(manifest.durationInFrames).toBe(manifest.scenes.reduce((n, s) => n + s.durationInFrames, 0));
    expect(manifest.subtitles.localized).toEqual({ path: "localize/subtitles.json", languages: ["hi"], status: "pending-localization" });
    expect(manifest.narration.status).toBe("not-generated");
    const cueIds = new Set(captions.tracks[0]!.cues.map((c) => c.cueId));
    expect(manifest.scenes.flatMap((s) => s.captionCueIds).every((id) => cueIds.has(id))).toBe(true);
    expect(manifest.attributions.find((a) => a.sourceId === "src-docs")).toMatchObject({ text: "Example Tools documentation", required: true });
    expect(JSON.stringify(manifest)).not.toMatch(/function|=>|<script|require\(/);
    expect(sb.scenes).toHaveLength(manifest.scenes.length);
  });

  it.each([
    ["out-of-order frames", (m: any) => void (m.scenes[1].startFrame += 5)],
    ["unknown asset", (m: any) => void m.scenes[0].assetIds.push("ast-ghost")],
    ["zero-length scene", (m: any) => void (m.scenes[0].durationInFrames = 0)],
    ["unsupported scene type", (m: any) => void (m.scenes[0].type = "react-component")],
    ["missing field", (m: any) => void delete m.format],
    ["code in text", (m: any) => void (m.scenes[0].text.primary = "<img src=x onerror=alert(1)>")],
  ])("manifest validation rejects %s", async (_l, mutate) => {
    const { manifest } = await build();
    const m = structuredClone(manifest);
    mutate(m);
    expect(SceneManifestSchema.safeParse(m).success).toBe(false);
  });
});

describe("subtitles", () => {
  const opts = { maxCharsPerLine: 20, maxLines: 2, maxCps: 17, minCueMs: 1000 };
  const items = [
    { segmentId: "seg-01-hook", sceneId: "scn-01", text: "Your agent runs code you never see. Here is why.", startMs: 0, endMs: 3000 },
    { segmentId: "seg-02-explanation", sceneId: "scn-02", text: "According to Example Tools: Hooks run before and after each tool call.", startMs: 3400, endMs: 8000 },
  ];

  it("builds ordered, non-overlapping, positive cues that keep every character", () => {
    const t = buildSubtitleTrack("en", "canonical", items, opts);
    expect(SubtitleTrackSchema.safeParse(t).success).toBe(true);
    t.cues.forEach((c, i) => {
      expect(c.index).toBe(i + 1);
      expect(c.endMs).toBeGreaterThan(c.startMs);
      if (i) expect(c.startMs).toBeGreaterThanOrEqual(t.cues[i - 1]!.endMs);
      expect(c.lines.length).toBeLessThanOrEqual(2);
    });
    for (const it of items) {
      const joined = t.cues.filter((c) => c.segmentId === it.segmentId).flatMap((c) => c.lines).join(" ");
      expect(joined.replace(/\s/g, "")).toBe(it.text.replace(/\s/g, ""));
    }
    expect(t.cues.at(-1)!.endMs).toBe(8000);
    expect(buildSubtitleTrack("en", "canonical", items, opts)).toEqual(t); // deterministic
  });

  it("warns on reading speed and short cues", () => {
    const t = buildSubtitleTrack("en", "canonical", [{ segmentId: "seg-01-hook", text: "This sentence is spoken far too quickly for anyone to read comfortably.", startMs: 0, endMs: 1500 }], opts);
    expect(t.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["READING_SPEED", "CUE_TOO_SHORT"]));
  });

  it("exports SRT and WebVTT (UTF-8, estimated timing noted in VTT)", () => {
    const t = buildSubtitleTrack("hi-IN", "localized", [{ segmentId: "seg-01-hook", text: "आपका एजेंट ऐसा कोड चलाता है जो आप कभी नहीं देखते। <यह> & वह", startMs: 0, endMs: 4000 }], opts);
    const srt = toSrt(t);
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n/);
    expect(srt).toContain("आपका एजेंट");
    expect(Buffer.from(srt, "utf8").toString("utf8")).toBe(srt);
    const vtt = toVtt(t);
    expect(vtt.startsWith("WEBVTT\n\nNOTE\nLanguage: hi-IN\nTiming: estimated")).toBe(true);
    expect(vtt).toMatch(/cue-hi-in-0001\n00:00:00\.000 --> /);
    expect(vtt).toContain("&lt;यह&gt; &amp; वह");
  });

  it("refuses to export text that would break the format instead of silently changing it", () => {
    const t = buildSubtitleTrack("en", "canonical", [{ segmentId: "seg-01-hook", text: "a --> b", startMs: 0, endMs: 2000 }], opts);
    expect(() => toSrt(t)).toThrow(SubtitleExportError);
    expect(() => toVtt(t)).toThrow(/-->/);
  });
});
