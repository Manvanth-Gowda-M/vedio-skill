import type {
  CanonicalScript,
  CreatorFlowConfig,
  CreatorProfile,
  EditorialIssue,
  FactualClaimReference,
  PlanItem,
  ResearchEvidencePack,
  ScriptFormat,
  ScriptSegment,
  SceneType,
} from "@creatorflow/schemas";
import { assertionFlags, baseLanguage, clickbaitFlag, estimateSpeechSec, speechRateFor, wordCount } from "./text.ts";

export interface ScriptRequest {
  jobId: string;
  item: PlanItem;
  itemHash: string;
  plan: { weekId: string; version: number; contentHash: string };
  evidence: ResearchEvidencePack;
  evidenceFile: { path: string; sha256: string };
  profile: CreatorProfile;
  config: CreatorFlowConfig;
}

export type ScriptProviderResult =
  | { ok: true; script: CanonicalScript }
  | { ok: false; code: "UNSUPPORTED_LANGUAGE" | "UNSUPPORTED" | "INSUFFICIENT_EVIDENCE"; message: string };

/**
 * Script provider interface. A future model-assisted provider implements the
 * same contract; its output must pass `validateScriptAgainstEvidence`, and
 * because free-form prose can assert things a claim ID does not support, it
 * will additionally need a factual review step before it can be trusted.
 */
export interface ScriptProvider {
  readonly id: string;
  readonly version: string;
  readonly deterministic: boolean;
  supportsLanguage(tag: string): boolean;
  generate(request: ScriptRequest): Promise<ScriptProviderResult>;
}

export class UnavailableScriptProvider implements ScriptProvider {
  readonly id: string;
  readonly version = "0";
  readonly deterministic = false;
  constructor(id: string) {
    this.id = id;
  }
  supportsLanguage(): boolean {
    return false;
  }
  async generate(): Promise<ScriptProviderResult> {
    return { ok: false, code: "UNSUPPORTED", message: `Script provider "${this.id}" is not available in this release (available: template)` };
  }
}

export const SHORT_PLATFORMS = new Set(["youtube-shorts", "instagram-reels", "tiktok"]);

export function chooseFormat(item: PlanItem): ScriptFormat {
  const short = item.aspectRatio ? item.aspectRatio === "9:16" : SHORT_PLATFORMS.has(item.platform);
  switch (item.category) {
    case "news":
      return "news-update";
    case "tutorial":
      return "tutorial";
    case "comparison":
      return "comparison";
    case "explainer":
      return short ? "short-explainer" : "long-explainer";
    default:
      return "evergreen-explainer";
  }
}

interface FormatSpec {
  hookTail: string;
  explanationScene: (i: number, styles: readonly string[]) => SceneType;
  demonstrate: boolean;
  quotes: boolean;
}

const FORMAT_SPECS: Record<ScriptFormat, FormatSpec> = {
  "short-explainer": { hookTail: "Here is what it means and why it matters.", explanationScene: (i, st) => (st.includes("technical-diagrams") && i % 2 === 1 ? "technical-diagram" : "concept-explanation"), demonstrate: false, quotes: false },
  "long-explainer": { hookTail: "Here is what it means and why it matters.", explanationScene: (i, st) => (st.includes("technical-diagrams") && i % 2 === 1 ? "technical-diagram" : "concept-explanation"), demonstrate: false, quotes: true },
  "evergreen-explainer": { hookTail: "Here is the short version.", explanationScene: () => "concept-explanation", demonstrate: false, quotes: true },
  "news-update": { hookTail: "Here is what the sources say.", explanationScene: () => "concept-explanation", demonstrate: false, quotes: false },
  tutorial: { hookTail: "Here is how it works, step by step.", explanationScene: (_i, st) => (st.includes("code-demos") ? "code-terminal-demo" : "screen-capture"), demonstrate: true, quotes: false },
  comparison: { hookTail: "Here is how they compare, according to the sources.", explanationScene: () => "comparison-layout", demonstrate: false, quotes: true },
};

const QUOTE_MAX_WORDS = 30;

function sourceName(pack: ResearchEvidencePack, sourceId: string): string {
  const s = pack.sources.find((x) => x.sourceId === sourceId);
  return s ? (s.publisher ?? s.title) : sourceId;
}

function claimRef(c: ResearchEvidencePack["claims"][number]): FactualClaimReference {
  return { claimId: c.claimId, kind: c.kind, support: c.support, usage: c.usage, sourceIds: [...new Set(c.evidence.map((e) => e.sourceId))].sort() };
}

const ensureStop = (s: string) => (/[.!?…।]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * "template" provider (deterministic, offline, English only). Every sentence
 * is either fixed wording, the creator's own text from the approved plan, a
 * source name with the date it states, or the exact text of a claim from the
 * evidence pack. It does not paraphrase, embellish or add facts; it does not
 * write demonstrations, results or personal experience.
 */
export class TemplateScriptProvider implements ScriptProvider {
  readonly id = "template";
  readonly version = "1";
  readonly deterministic = true;

  supportsLanguage(tag: string): boolean {
    return baseLanguage(tag) === "en";
  }

  async generate(r: ScriptRequest): Promise<ScriptProviderResult> {
    const { item, evidence: pack, profile, config } = r;
    const lang = item.language;
    if (!this.supportsLanguage(lang)) {
      return { ok: false, code: "UNSUPPORTED_LANGUAGE", message: `The template provider writes English only; this item's canonical language is ${lang}` };
    }
    const facts = pack.claims.filter((c) => c.kind === "fact" && (c.support === "supported" || c.support === "supported-unchecked"));
    if (facts.length === 0) return { ok: false, code: "INSUFFICIENT_EVIDENCE", message: "The evidence pack has no supported fact claims" };

    const format = chooseFormat(item);
    const spec = FORMAT_SPECS[format];
    const sc = config.script;
    const wpm = speechRateFor(sc.speechRateWpm, lang);
    const rate = profile.voice.speakingRate;
    const styles = profile.visual.styles;
    const title = item.workingTitle ?? item.topic;
    const issues: EditorialIssue[] = [];
    type Draft = Omit<ScriptSegment, "segmentId" | "timing" | "language" | "editorialNotes"> & { notes: string[] };
    const drafts: Draft[] = [];
    const add = (d: Omit<Draft, "notes" | "claimRefs" | "sourceRefs" | "transition" | "optional"> & Partial<Draft>) =>
      drafts.push({ claimRefs: [], sourceRefs: [], transition: "cut", optional: false, notes: [], ...d });

    // 1. Hook
    if (item.hook) {
      add({ purpose: "hook", narration: ensureStop(item.hook), onScreenText: title, textOrigin: ["plan"], visual: { sceneType: "hook-typography", description: "Bold kinetic typography of the hook on a brand-colour background", emphasis: [] }, notes: ["Hook is creator-authored text from the approved plan; it is not checked against the evidence."] });
    } else {
      add({ purpose: "hook", narration: `${ensureStop(title)} ${spec.hookTail}`, onScreenText: title, textOrigin: ["template", "plan"], visual: { sceneType: "hook-typography", description: "Bold typography of the title", emphasis: [] }, notes: ["No hook in the plan; a neutral title-based opening was used."] });
    }

    // 2. Context (only from real material; never filler)
    const ctxParts: string[] = [];
    const ctxOrigin: ("plan" | "source")[] = [];
    const ctxSources: string[] = [];
    if (item.audienceProblem) {
      ctxParts.push(`Why it matters: ${ensureStop(item.audienceProblem)}`);
      ctxOrigin.push("plan");
    } else if (item.angle) {
      ctxParts.push(ensureStop(item.angle));
      ctxOrigin.push("plan");
    }
    if (format === "news-update") {
      const newest = [...pack.sources].filter((s) => s.publishedAt ?? s.modifiedAt).sort((a, b) => ((b.publishedAt ?? b.modifiedAt)! < (a.publishedAt ?? a.modifiedAt)! ? -1 : 1))[0];
      if (newest) {
        ctxParts.push(`The source is ${newest.publisher ?? newest.title}, dated ${(newest.publishedAt ?? newest.modifiedAt)!.slice(0, 10)}.`);
        ctxOrigin.push("source");
        ctxSources.push(newest.sourceId);
      }
    }
    if (ctxParts.length) {
      add({ purpose: "context", narration: ctxParts.join(" "), onScreenText: format === "news-update" && ctxSources.length ? `Source: ${sourceName(pack, ctxSources[0]!)}` : title, textOrigin: [...new Set(ctxOrigin)], sourceRefs: ctxSources, visual: { sceneType: "title-intro", description: "Topic title with a source card where a source is named", emphasis: [] }, transition: "fade", optional: true });
    } else {
      issues.push({ severity: "info", code: "NO_CONTEXT", message: "The plan has no audience problem or angle, so no context segment was written. Add one to the plan if the video needs it." });
    }

    // 3. Explanations / demonstrations: one segment per claim, verbatim claim text.
    const claims = pack.claims.slice(0, sc.maxExplanationSegments);
    if (pack.claims.length > claims.length) issues.push({ severity: "info", code: "CLAIMS_LIMITED", message: `Only the first ${claims.length} of ${pack.claims.length} claims are used (script.maxExplanationSegments)` });
    let factIndex = 0;
    claims.forEach((c, i) => {
      const ref = claimRef(c);
      const first = ref.sourceIds[0];
      const name = first ? sourceName(pack, first) : undefined;
      let narration: string;
      let onScreen: string;
      const notes: string[] = [];
      let purpose: ScriptSegment["purpose"] = "explanation";
      let scene: SceneType = spec.explanationScene(i, styles);
      if (c.kind === "fact") {
        narration = name ? `According to ${name}: ${ensureStop(c.text)}` : ensureStop(c.text);
        onScreen = c.text;
        if (spec.demonstrate) {
          purpose = "demonstration";
          notes.push("Show a real recording of this step. The script does not invent steps, commands or results.");
        }
        if (c.support === "supported-unchecked") notes.push("Evidence was not checked against a saved copy of the source; verify before publishing.");
        factIndex++;
      } else if (c.kind === "interpretation") {
        narration = `One interpretation: ${ensureStop(c.text)}`;
        onScreen = c.text;
        scene = "concept-explanation";
        notes.push("Opinion: keep the 'interpretation' framing.");
      } else {
        narration = `An open question: ${ensureStop(c.text)}`;
        onScreen = `Open question: ${c.text}`;
        scene = "concept-explanation";
        notes.push("Hypothesis: present as a question, not a result.");
      }
      add({ purpose, narration, onScreenText: onScreen, textOrigin: ["claim", "template"], claimRefs: [ref], sourceRefs: ref.sourceIds, visual: { sceneType: scene, description: scene === "technical-diagram" ? "Diagram of the concept stated in the claim" : scene === "comparison-layout" ? "Side-by-side layout; label each side with its source" : scene === "code-terminal-demo" ? "Real code or terminal capture of the step" : scene === "screen-capture" ? "Real screen recording of the step" : "Animated typography of the claim with its source label", emphasis: [] }, transition: "slide", optional: c.kind !== "fact" || factIndex > 1, notes });

      // Long formats: add a source quotation when a short excerpt was found verbatim in a saved copy.
      if (spec.quotes && c.kind === "fact") {
        const q = c.evidence.find((e) => e.kind === "quote" && e.excerpt && e.check === "found-in-snapshot" && wordCount(e.excerpt, lang) <= QUOTE_MAX_WORDS);
        if (q) {
          const src = pack.sources.find((s) => s.sourceId === q.sourceId);
          const restrictions = src?.usageRestrictions ?? [];
          add({ purpose: "explanation", narration: `In the source's own words: "${ensureStop(q.excerpt!)}"`, onScreenText: `"${q.excerpt!}"`, textOrigin: ["source", "template"], claimRefs: [ref], sourceRefs: [q.sourceId], visual: { sceneType: "source-quote", description: "Quotation card with the source name", emphasis: [] }, transition: "fade", optional: true, notes: restrictions.length ? [`Usage restrictions: ${restrictions.join("; ")}`] : [] });
        }
      }
    });

    // 4. Takeaway
    if (item.takeaway) {
      add({ purpose: "takeaway", narration: ensureStop(item.takeaway), onScreenText: item.takeaway, textOrigin: ["plan"], visual: { sceneType: "summary", description: "Summary card", emphasis: [] }, transition: "fade", notes: ["Takeaway is creator-authored text from the approved plan."] });
    } else {
      const f = facts[0]!;
      add({ purpose: "takeaway", narration: `The key point: ${ensureStop(f.text)}`, onScreenText: f.text, textOrigin: ["claim", "template"], claimRefs: [claimRef(f)], sourceRefs: claimRef(f).sourceIds, visual: { sceneType: "summary", description: "Summary card restating the key supported claim", emphasis: [] }, transition: "fade" });
    }

    // 5. Outro
    const cta = sc.callToAction;
    add({ purpose: "outro", narration: `The sources for each claim are listed with this video.${cta ? ` ${ensureStop(cta)}` : ""}`, onScreenText: cta ?? profile.brand.name, textOrigin: cta ? ["template", "plan"] : ["template"], visual: { sceneType: "outro", description: "Brand outro with logo and source note", emphasis: [] }, transition: "fade", optional: true });

    // ---- timing and duration fitting (never pads)
    // IDs are assigned before trimming, so dropped segments keep traceable IDs.
    const timed = drafts.map((d, i) => {
      const speech = estimateSpeechSec(d.narration, lang, wpm, rate);
      const est = Math.max(sc.minSegmentSec, speech) + sc.segmentPauseSec;
      return { d, id: `seg-${String(i + 1).padStart(2, "0")}-${d.purpose}`, words: wordCount(d.narration, lang), est: Math.round(est * 100) / 100 };
    });
    const total = () => Math.round(timed.reduce((a, t) => a + t.est, 0) * 100) / 100;
    const dropped: { segmentId: string; reason: string }[] = [];
    const target = item.durationSec;
    while (total() > target * sc.maxDurationRatio) {
      // Drop optional segments from the end, quotes first, then extra explanations, then the outro.
      const order = ["source-quote", "explanation", "outro", "context"];
      let idx = -1;
      for (const kind of order) {
        for (let i = timed.length - 1; i >= 0; i--) {
          const t = timed[i]!;
          const match = kind === "source-quote" ? t.d.visual.sceneType === "source-quote" : kind === "explanation" ? t.d.purpose === "explanation" || t.d.purpose === "demonstration" : t.d.purpose === kind;
          if (t.d.optional && match) {
            idx = i;
            break;
          }
        }
        if (idx >= 0) break;
      }
      if (idx < 0) break;
      const [removed] = timed.splice(idx, 1);
      dropped.push({ segmentId: removed!.id, reason: `optional ${removed!.d.purpose} segment dropped to fit the ${target}s target` });
    }
    let status: CanonicalScript["editorial"]["status"] = "ok";
    const est = total();
    if (est > target * sc.maxDurationRatio) {
      status = "over-duration";
      issues.push({ severity: "warning", code: "OVER_DURATION", message: `Estimated ${est}s exceeds the ${target}s target by more than ${Math.round((sc.maxDurationRatio - 1) * 100)}% even after dropping optional segments` });
    } else if (est < target * sc.minDurationRatio) {
      status = "duration-shortfall";
      issues.push({ severity: sc.onDurationShortfall === "block" ? "error" : "warning", code: "DURATION_SHORTFALL", message: `The evidence supports about ${est}s of narration; the target is ${target}s. CreatorFlow does not pad: add supported claims or lower durationSec.` });
    }

    const segments: ScriptSegment[] = timed.map((t) => {
      const { notes, ...rest } = t.d;
      return { ...rest, segmentId: t.id, language: lang, timing: { words: t.words, estimatedSec: t.est, minSec: sc.minSegmentSec }, editorialNotes: notes };
    });

    // ---- editorial heuristics on text that is not verbatim claim text
    const seen = new Map<string, string>();
    for (const s of segments) {
      const nonClaim = s.textOrigin.includes("plan");
      if (nonClaim) {
        for (const flag of assertionFlags(s.narration)) issues.push({ severity: "warning", code: "POSSIBLE_UNSUPPORTED_ASSERTION", message: `Creator-authored text ${flag}; confirm it is supported or rephrase`, segmentId: s.segmentId });
      }
      if (clickbaitFlag(s.narration)) issues.push({ severity: "warning", code: "CLICKBAIT_WORDING", message: "Wording reads as hype or fake urgency", segmentId: s.segmentId });
      const key = s.narration.toLowerCase();
      if (seen.has(key)) issues.push({ severity: "warning", code: "REPEATED_TEXT", message: `Same narration as ${seen.get(key)}`, segmentId: s.segmentId });
      seen.set(key, s.segmentId);
    }

    // ---- attributions: every source cited by a segment
    const bySource = new Map<string, Set<string>>();
    for (const s of segments) for (const id of [...s.sourceRefs, ...s.claimRefs.flatMap((c) => c.sourceIds)]) (bySource.get(id) ?? bySource.set(id, new Set()).get(id)!).add(s.segmentId);
    const attributions = [...bySource.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([sourceId, segs]) => {
        const s = pack.sources.find((x) => x.sourceId === sourceId)!;
        return {
          sourceId,
          title: s.title,
          ...(s.publisher ? { publisher: s.publisher } : {}),
          ...(s.url ? { url: s.url } : {}),
          ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
          ...(s.attribution ? { requiredText: s.attribution } : {}),
          usageRestrictions: s.usageRestrictions,
          segmentIds: [...segs].sort(),
        };
      });

    const script: CanonicalScript = {
      schemaVersion: 1,
      kind: "canonical-script",
      contentId: item.contentId,
      jobId: r.jobId,
      language: lang,
      format,
      provider: { id: this.id, version: this.version, deterministic: true },
      plan: { ...r.plan, itemHash: r.itemHash },
      evidence: { path: r.evidenceFile.path, sha256: r.evidenceFile.sha256, evidenceHash: pack.evidenceHash },
      evidenceAsOf: pack.asOf,
      title,
      platform: item.platform,
      aspectRatio: item.aspectRatio ?? (SHORT_PLATFORMS.has(item.platform) ? "9:16" : "16:9"),
      targetDurationSec: target,
      estimatedDurationSec: est,
      timingStatus: "estimated",
      speechRateWpm: wpm,
      segments,
      attributions,
      droppedSegments: dropped,
      editorial: { status, issues },
    };
    return { ok: true, script };
  }
}

export const SCRIPT_PROVIDERS: Record<string, () => ScriptProvider> = { template: () => new TemplateScriptProvider() };

export function scriptProviderFor(id: string): ScriptProvider {
  return SCRIPT_PROVIDERS[id]?.() ?? new UnavailableScriptProvider(id);
}
