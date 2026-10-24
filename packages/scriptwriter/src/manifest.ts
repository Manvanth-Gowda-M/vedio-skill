import type { CanonicalScript, CaptionsFile, CreatorFlowConfig, CreatorProfile, SceneManifest, Storyboard, SubtitleTrack } from "@creatorflow/schemas";
import { buildSubtitleTrack, type TimedText } from "./subtitles.ts";

export const RESOLUTION: Record<SceneManifest["format"]["aspectRatio"], { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/** Segment windows from storyboard scenes; the trailing pause is left without a cue. */
export function timedSegments(storyboard: Storyboard, texts: ReadonlyMap<string, string>, pauseSec: number): TimedText[] {
  const out: TimedText[] = [];
  for (const scene of storyboard.scenes) {
    const startMs = Math.round(scene.startSec * 1000);
    const durMs = Math.round(scene.durationSec * 1000);
    const endMs = startMs + Math.max(Math.round(durMs * 0.8), durMs - Math.round(pauseSec * 1000));
    for (const segmentId of scene.segmentIds) {
      const text = texts.get(segmentId);
      if (text) out.push({ segmentId, sceneId: scene.sceneId, text, startMs, endMs });
    }
  }
  return out;
}

export function buildCanonicalCaptions(script: CanonicalScript, scriptRef: { path: string; sha256: string }, storyboard: Storyboard, config: CreatorFlowConfig): CaptionsFile {
  const texts = new Map(script.segments.map((s) => [s.segmentId, s.narration]));
  const track: SubtitleTrack = buildSubtitleTrack(script.language, "canonical", timedSegments(storyboard, texts, config.script.segmentPauseSec), config.localization.subtitles);
  return { schemaVersion: 1, kind: "subtitle-tracks", contentId: script.contentId, script: scriptRef, tracks: [track] };
}

export function targetLanguages(config: CreatorFlowConfig, profile: CreatorProfile): string[] {
  const t = config.localization.targetLanguages;
  const list = t === "profile" ? [profile.languages.primary, ...profile.languages.additional] : t;
  return [...new Set(list)];
}

export function buildSceneManifest(input: {
  jobId: string;
  script: CanonicalScript;
  scriptRef: { path: string; sha256: string };
  storyboard: Storyboard;
  storyboardRef: { path: string; sha256: string };
  captions: CaptionsFile;
  captionsRef: { path: string; sha256: string };
  profile: CreatorProfile;
  config: CreatorFlowConfig;
}): SceneManifest {
  const { script, storyboard, profile, config } = input;
  const fps = config.script.fps;
  const frame = (sec: number) => Math.round(sec * fps);
  const track = input.captions.tracks[0]!;
  const scenes = storyboard.scenes.map((s) => {
    const startFrame = frame(s.startSec);
    const durationInFrames = Math.max(1, frame(s.startSec + s.durationSec) - startFrame);
    return {
      sceneId: s.sceneId,
      type: s.type,
      startFrame,
      durationInFrames,
      segmentIds: s.segmentIds,
      text: { primary: s.text.primary, ...(s.text.secondary ? { secondary: s.text.secondary } : {}) },
      captionCueIds: track.cues.filter((c) => s.segmentIds.includes(c.segmentId)).map((c) => c.cueId),
      assetIds: s.assetIds,
      attributionSourceIds: s.attributionSourceIds,
      motion: s.motion,
      safeArea: s.safeArea,
    };
  });
  // Keep frames contiguous even if rounding made a scene 1 frame longer.
  let f = 0;
  for (const s of scenes) {
    s.startFrame = f;
    f += s.durationInFrames;
  }
  const allText = script.segments.map((s) => `${s.narration} ${s.onScreenText}`).join(" ");
  const sceneOf = new Map(storyboard.scenes.flatMap((s) => s.segmentIds.map((id) => [id, s.sceneId] as const)));
  const logo = storyboard.assets.find((a) => a.assetId === "ast-brand-logo");
  return {
    schemaVersion: 1,
    kind: "scene-manifest",
    contentId: script.contentId,
    jobId: input.jobId,
    plan: script.plan,
    script: input.scriptRef,
    storyboard: input.storyboardRef,
    format: { platform: script.platform, aspectRatio: script.aspectRatio, ...RESOLUTION[script.aspectRatio], fps },
    estimatedDurationSec: storyboard.estimatedDurationSec,
    durationInFrames: f,
    timingStatus: "estimated",
    scenes,
    narration: {
      mode: profile.voice.mode,
      language: script.language,
      ...(profile.voice.voiceId ? { voiceId: profile.voice.voiceId } : {}),
      speakingRate: profile.voice.speakingRate,
      status: "not-generated",
      pronunciations: profile.voice.glossary.filter((g) => g.pronunciation && allText.includes(g.term)).map((g) => ({ term: g.term, pronunciation: g.pronunciation! })),
    },
    subtitles: {
      canonical: { language: script.language, path: input.captionsRef.path, sha256: input.captionsRef.sha256 },
      localized: { path: "localize/subtitles.json", languages: targetLanguages(config, profile).filter((l) => l !== script.language), status: "pending-localization" },
    },
    assets: storyboard.assets.map((a) => ({ assetId: a.assetId, kind: a.kind, status: a.status, required: a.required })),
    brand: {
      name: profile.brand.name,
      colors: { ...profile.brand.colors },
      fonts: Object.fromEntries(Object.entries(profile.brand.fonts).map(([k, v]) => [k, { family: v.family, source: v.source, license: v.license }])),
      ...(logo ? { logoAssetId: logo.assetId } : {}),
    },
    attributions: script.attributions.map((a) => ({
      sourceId: a.sourceId,
      text: a.requiredText ?? `${a.publisher ?? a.title}${a.publishedAt ? `, ${a.publishedAt.slice(0, 10)}` : ""}`,
      required: true,
      sceneIds: [...new Set(a.segmentIds.map((id) => sceneOf.get(id)).filter((x): x is string => Boolean(x)))].sort(),
    })),
  };
}
