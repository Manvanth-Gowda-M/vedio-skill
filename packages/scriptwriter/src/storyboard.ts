import type { AssetRequirement, CanonicalScript, CreatorProfile, PlanItem, SceneType, Storyboard, StoryboardScene } from "@creatorflow/schemas";
import { graphemeLength, wrapText } from "./text.ts";

export const SAFE_AREAS: Record<Storyboard["aspectRatio"], StoryboardScene["safeArea"]> = {
  // Bottom margins leave room for captions and platform UI.
  "9:16": { top: 0.1, bottom: 0.2, left: 0.06, right: 0.06 },
  "16:9": { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 },
  "1:1": { top: 0.06, bottom: 0.12, left: 0.06, right: 0.06 },
  "4:5": { top: 0.06, bottom: 0.15, left: 0.06, right: 0.06 },
};
const LINE_CHARS: Record<Storyboard["aspectRatio"], number> = { "9:16": 24, "16:9": 42, "1:1": 30, "4:5": 28 };

const HIERARCHY: Record<SceneType, StoryboardScene["hierarchy"]> = {
  "hook-typography": ["headline"],
  "title-intro": ["headline", "source-label"],
  "concept-explanation": ["headline", "body", "source-label"],
  "technical-diagram": ["diagram", "headline", "source-label"],
  "code-terminal-demo": ["code", "headline", "source-label"],
  "comparison-layout": ["headline", "body", "source-label"],
  "screen-capture": ["media", "headline", "source-label"],
  "source-quote": ["body", "source-label"],
  summary: ["headline", "body"],
  outro: ["brand", "headline"],
};
const INTENT: Record<SceneType, StoryboardScene["motion"]["intent"]> = {
  "hook-typography": "emphasise",
  "title-intro": "reveal",
  "concept-explanation": "build",
  "technical-diagram": "build",
  "code-terminal-demo": "demonstrate",
  "comparison-layout": "compare",
  "screen-capture": "demonstrate",
  "source-quote": "reveal",
  summary: "summarise",
  outro: "close",
};

function inferKind(text: string): AssetRequirement["kind"] {
  const t = text.toLowerCase();
  if (/screen ?record|recording|screencast/.test(t)) return "screen-recording";
  if (/screenshot|screen grab/.test(t)) return "screenshot";
  if (/diagram|chart|illustration/.test(t)) return "diagram";
  if (/code|terminal|cli|snippet/.test(t)) return "code-snippet";
  if (/logo/.test(t)) return "logo";
  if (/b-?roll|footage|stock/.test(t)) return "b-roll";
  if (/icon/.test(t)) return "icon";
  return "other";
}
const KIND_SCENES: Partial<Record<AssetRequirement["kind"], SceneType[]>> = {
  "screen-recording": ["screen-capture", "code-terminal-demo"],
  "code-snippet": ["code-terminal-demo"],
  diagram: ["technical-diagram"],
  screenshot: ["source-quote", "screen-capture"],
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";

/**
 * Deterministic storyboard: one scene per script segment, in order, with
 * contiguous estimated timing. Assets are declared as requirements only; no
 * asset is ever marked as existing (the registry arrives in a later stage).
 */
export function buildStoryboard(script: CanonicalScript, scriptRef: { path: string; sha256: string }, item: PlanItem, profile: CreatorProfile): Storyboard {
  const ar = script.aspectRatio;
  const maxChars = LINE_CHARS[ar];
  const assets: AssetRequirement[] = [];
  const scenes: StoryboardScene[] = [];
  let tCs = 0; // centiseconds, to avoid float drift
  script.segments.forEach((seg, i) => {
    const sceneId = `scn-${String(i + 1).padStart(2, "0")}`;
    const type = seg.visual.sceneType;
    const maxLines = type === "hook-typography" ? 3 : 4;
    const wrapped = wrapText(seg.onScreenText, script.language, maxChars);
    const fits = wrapped.lines.length <= maxLines && !wrapped.overlong;
    const notes: string[] = [];
    if (!fits) notes.push(`On-screen text needs ${wrapped.lines.length} line(s) at ${maxChars} characters; the layout allows ${maxLines}. Shorten it before rendering (not truncated automatically).`);
    const assetIds: string[] = [];
    const sceneAsset = (kind: AssetRequirement["kind"], description: string, required: boolean) => {
      const assetId = `ast-${sceneId}-${kind}`;
      assets.push({ assetId, kind, description, status: "required-unregistered", required, sceneIds: [sceneId], origin: "storyboard" });
      assetIds.push(assetId);
      notes.push(`Needs ${kind} (${required ? "required" : "optional"}; not registered yet)`);
    };
    if (type === "code-terminal-demo") sceneAsset("code-snippet", `Real code or terminal capture showing: ${seg.onScreenText}`, true);
    if (type === "screen-capture") sceneAsset("screen-recording", `Real screen recording showing: ${seg.onScreenText}`, true);
    if (type === "technical-diagram") sceneAsset("diagram", `Diagram explaining: ${seg.onScreenText}`, true);
    if (type === "source-quote") sceneAsset("screenshot", `Screenshot of the quoted source (respect its usage restrictions)`, false);
    const startCs = tCs;
    const durCs = Math.max(1, Math.round(seg.timing.estimatedSec * 100));
    tCs += durCs;
    const attributionSourceIds = [...new Set([...seg.sourceRefs, ...seg.claimRefs.flatMap((c) => c.sourceIds)])].sort();
    scenes.push({
      sceneId,
      type,
      purpose: seg.purpose,
      segmentIds: [seg.segmentId],
      startSec: startCs / 100,
      durationSec: durCs / 100,
      narration: "voiceover-of-segments",
      hierarchy: HIERARCHY[type],
      motion: { intent: INTENT[type], intensity: profile.visual.animationIntensity, transitionIn: i === 0 ? "none" : seg.transition },
      text: {
        primary: seg.onScreenText,
        ...(attributionSourceIds.length ? { secondary: `Source: ${script.attributions.filter((a) => attributionSourceIds.includes(a.sourceId)).map((a) => a.publisher ?? a.title).join(", ")}`.slice(0, 200) } : {}),
        maxLines,
        maxCharsPerLine: maxChars,
        fits,
      },
      assetIds,
      attributionSourceIds,
      safeArea: SAFE_AREAS[ar],
      notes,
    });
  });

  // Plan-declared assets: attach to scenes of a matching type, else the first explanation scene.
  item.requiredAssets.forEach((desc, i) => {
    const kind = inferKind(desc);
    const wanted = KIND_SCENES[kind];
    let targets = scenes.filter((s) => wanted?.includes(s.type));
    if (targets.length === 0) targets = scenes.filter((s) => s.purpose === "explanation" || s.purpose === "demonstration").slice(0, 1);
    if (targets.length === 0) targets = scenes.slice(0, 1);
    const assetId = `ast-plan-${i + 1}-${slug(desc)}`;
    assets.push({ assetId, kind, description: desc, status: "required-unregistered", required: true, sceneIds: targets.map((s) => s.sceneId), origin: "plan" });
    for (const s of targets) s.assetIds.push(assetId);
  });

  // Brand assets declared in the profile (presence and licences are verified in a later stage).
  if (profile.brand.logoPath) {
    const outro = scenes.find((s) => s.type === "outro") ?? scenes.at(-1)!;
    assets.push({ assetId: "ast-brand-logo", kind: "logo", description: `Brand logo (${profile.brand.logoPath})`, status: "declared-unverified", required: true, sceneIds: [outro.sceneId], origin: "brand" });
    outro.assetIds.push("ast-brand-logo");
  }
  const fonts = new Map<string, { license: string; source: string }>();
  for (const f of Object.values(profile.brand.fonts)) fonts.set(f.family, { license: f.license, source: f.source });
  for (const [family, f] of [...fonts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    assets.push({ assetId: `ast-font-${slug(family)}`, kind: "font", description: `${family} (${f.source})`, status: "declared-unverified", required: true, sceneIds: [], licenseNotes: `Licence recorded in profile: ${f.license}`, origin: "brand" });
  }

  for (const s of scenes) if (graphemeLength(s.text.primary) === 0) s.notes.push("Empty on-screen text");
  return {
    schemaVersion: 1,
    kind: "storyboard",
    contentId: script.contentId,
    script: scriptRef,
    aspectRatio: ar,
    style: { faceless: true, styles: [...profile.visual.styles], animationIntensity: profile.visual.animationIntensity },
    estimatedDurationSec: tCs / 100,
    timingStatus: "estimated",
    scenes,
    assets,
  };
}
