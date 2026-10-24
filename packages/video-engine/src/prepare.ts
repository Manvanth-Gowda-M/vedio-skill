import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWithin, sha256Hex, stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { readVerifiedOutput, StepError, verifiedBinaryOutput, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import { contrastRatio, FRAMED_VIDEO_COMPONENTS, RENDERER_VERSION, SCENE_COMPONENTS, UNSUPPORTED_SCENES, type RenderProps, type SceneProp, type VideoProp } from "@creatorflow/remotion-studio";
import {
  AssetResolutionSchema,
  CaptionsFileSchema,
  NarrationRecordSchema,
  RenderRequestSchema,
  SceneManifestSchema,
  validateArtifact,
  type AssetResolution,
  type CaptionsFile,
  type CreatorFlowConfig,
  type NarrationRecord,
  type RenderRequest,
  type SceneManifest,
} from "@creatorflow/schemas";
import { SCRIPT_OUTPUTS } from "@creatorflow/scriptwriter";
import { NARRATION_OUTPUTS } from "@creatorflow/voice";
import { ASSET_OUTPUT } from "./assets.ts";
import { chooseBrowser, remotionVersion } from "./environment.ts";

export const REQUEST_OUTPUT = "render/request.json";

export interface LoadedInputs {
  manifest: SceneManifest;
  captions: CaptionsFile;
  resolution: AssetResolution;
  /** Narrate step outputs (always present in the production pipeline). */
  narration?: NarrationRecord;
  /** Final subtitle tracks for the render timeline (aligned when narrated). */
  subtitles?: CaptionsFile;
  /** Verified narration audio, when generated. */
  audio?: { abs: string; path: string; sha256: string; durationMs: number; sampleRate: number; channels: number };
  refs: RenderRequest["inputs"];
}

type Read = { ok: true; file: { raw: string; sha256: string } } | { ok: false; code: string; reason: string };

/** Loads and cross-checks the manifest, storyboard, captions, asset resolution and narration by hash. */
export async function loadRenderInputs(ctx: Pick<StepContext, "verified" | "jobDir">): Promise<{ ok: true; inputs: LoadedInputs } | { ok: false; code: string; reason: string }> {
  const reads: Record<string, Read> = {
    manifest: await readVerifiedOutput(ctx, "script", SCRIPT_OUTPUTS.manifest),
    storyboard: await readVerifiedOutput(ctx, "script", SCRIPT_OUTPUTS.storyboard),
    captions: await readVerifiedOutput(ctx, "script", SCRIPT_OUTPUTS.captions),
    script: await readVerifiedOutput(ctx, "script", SCRIPT_OUTPUTS.script),
    resolution: await readVerifiedOutput(ctx, "assets", ASSET_OUTPUT),
    narration: await readVerifiedOutput(ctx, "narrate", NARRATION_OUTPUTS.record),
    subtitles: await readVerifiedOutput(ctx, "narrate", NARRATION_OUTPUTS.subtitles),
  };
  for (const r of Object.values(reads)) if (!r.ok) return r;
  const f = Object.fromEntries(Object.entries(reads).map(([k, r]) => [k, (r as Extract<Read, { ok: true }>).file])) as Record<string, { raw: string; sha256: string }>;
  const mv = validateArtifact(SceneManifestSchema, JSON.parse(f["manifest"]!.raw));
  const cv = validateArtifact(CaptionsFileSchema, JSON.parse(f["captions"]!.raw));
  const av = validateArtifact(AssetResolutionSchema, JSON.parse(f["resolution"]!.raw));
  const nv = validateArtifact(NarrationRecordSchema, JSON.parse(f["narration"]!.raw));
  const sv = validateArtifact(CaptionsFileSchema, JSON.parse(f["subtitles"]!.raw));
  if (!mv.ok) return { ok: false, code: "MANIFEST_INVALID", reason: `scene-manifest.json: ${mv.issues[0]?.path}: ${mv.issues[0]?.message}` };
  if (!cv.ok) return { ok: false, code: "CAPTIONS_INVALID", reason: `captions.json: ${cv.issues[0]?.path}: ${cv.issues[0]?.message}` };
  if (!av.ok) return { ok: false, code: "ASSET_RESOLUTION_INVALID", reason: `resolution.json: ${av.issues[0]?.path}: ${av.issues[0]?.message}` };
  if (!nv.ok) return { ok: false, code: "NARRATION_INVALID", reason: `narration.json: ${nv.issues[0]?.path}: ${nv.issues[0]?.message}` };
  if (!sv.ok) return { ok: false, code: "SUBTITLES_INVALID", reason: `narration/subtitles.json: ${sv.issues[0]?.path}: ${sv.issues[0]?.message}` };
  const m = mv.value;
  const n = nv.value;
  const mismatch: string[] = [];
  if (m.script.sha256 !== f["script"]!.sha256) mismatch.push("manifest references a different script.json");
  if (m.storyboard.sha256 !== f["storyboard"]!.sha256) mismatch.push("manifest references a different storyboard.json");
  if (m.subtitles.canonical.sha256 !== f["captions"]!.sha256) mismatch.push("manifest references a different captions.json");
  if (av.value.manifest.sha256 !== f["manifest"]!.sha256) mismatch.push("asset resolution was made for a different scene manifest");
  if (n.manifest.sha256 !== f["manifest"]!.sha256 || n.script.sha256 !== f["script"]!.sha256) mismatch.push("narration was made for a different script or scene manifest");
  if (n.subtitles.sha256 !== f["subtitles"]!.sha256) mismatch.push("narration record references different subtitles");
  if (n.timing.scenes.map((s) => s.sceneId).join() !== m.scenes.map((s) => s.sceneId).join()) mismatch.push("narration timeline scenes differ from the manifest scenes");
  if (n.timing.fps !== m.format.fps) mismatch.push("narration timeline fps differs from the manifest");
  const cueIds = new Set(cv.value.tracks.flatMap((t) => t.cues.map((c) => c.cueId)));
  for (const s of m.scenes) for (const id of s.captionCueIds) if (!cueIds.has(id)) mismatch.push(`scene ${s.sceneId} references unknown caption cue ${id}`);
  const canon = cv.value.tracks.find((t) => t.language === m.narration.language) ?? cv.value.tracks[0]!;
  const finalCanon = sv.value.tracks.find((t) => t.language === canon.language);
  if (!finalCanon || finalCanon.cues.map((c) => c.cueId).join() !== canon.cues.map((c) => c.cueId).join()) mismatch.push("narration subtitles do not contain the script's caption cues");
  const known = new Map(av.value.assets.map((a) => [a.assetId, a]));
  for (const s of m.scenes) for (const id of s.assetIds) if (!known.has(id)) mismatch.push(`scene ${s.sceneId} asset ${id} is not in the asset resolution`);
  if (mismatch.length) return { ok: false, code: "RENDER_INPUTS_INCONSISTENT", reason: mismatch.join("; ") };
  let audio: LoadedInputs["audio"];
  if (n.status === "generated") {
    const a = await verifiedBinaryOutput(ctx, "narrate", NARRATION_OUTPUTS.audio);
    if (!a.ok) return { ok: false, code: a.code === "UPSTREAM_MISSING" ? "NARRATION_AUDIO_MISSING" : "NARRATION_AUDIO_CHANGED", reason: a.reason };
    if (a.sha256 !== n.audio!.sha256) return { ok: false, code: "NARRATION_AUDIO_CHANGED", reason: `${NARRATION_OUTPUTS.audio} does not match the narration record; run resume` };
    audio = { abs: a.abs, path: NARRATION_OUTPUTS.audio, sha256: a.sha256, durationMs: n.audio!.durationMs, sampleRate: n.audio!.sampleRate, channels: n.audio!.channels };
  }
  return {
    ok: true,
    inputs: {
      manifest: m,
      captions: cv.value,
      resolution: av.value,
      narration: n,
      subtitles: sv.value,
      ...(audio ? { audio } : {}),
      refs: {
        manifest: { path: SCRIPT_OUTPUTS.manifest, sha256: f["manifest"]!.sha256 },
        storyboard: { path: SCRIPT_OUTPUTS.storyboard, sha256: f["storyboard"]!.sha256 },
        captions: { path: SCRIPT_OUTPUTS.captions, sha256: f["captions"]!.sha256 },
        assetResolution: { path: ASSET_OUTPUT, sha256: f["resolution"]!.sha256 },
        narration: { path: NARRATION_OUTPUTS.record, sha256: f["narration"]!.sha256 },
        subtitles: { path: NARRATION_OUTPUTS.subtitles, sha256: f["subtitles"]!.sha256 },
      },
    },
  };
}

export function renderSettings(config: CreatorFlowConfig, chromeMode: "chrome-for-testing" | "headless-shell"): RenderRequest["settings"] {
  return {
    codec: config.render.codec,
    crf: config.render.crf,
    pixelFormat: config.render.pixelFormat,
    concurrency: Math.min(config.render.concurrency, config.hardware.maxConcurrentRenders),
    captions: config.render.captions,
    chromeMode,
  };
}

export interface SceneCheck {
  ok: boolean;
  problems: string[];
  scenes: RenderRequest["scenes"];
}

/**
 * Maps manifest scenes to components; any unsupported type or missing required
 * media is a problem. With `timing`, scene frames come from the narration
 * timeline instead of the script's estimate.
 */
export function mapScenes(manifest: SceneManifest, resolution: AssetResolution, timing?: NarrationRecord["timing"]): SceneCheck {
  const problems: string[] = [];
  const assets = new Map(resolution.assets.map((a) => [a.assetId, a]));
  const scenes = manifest.scenes.map((s) => {
    const component = SCENE_COMPONENTS[s.type];
    if (!component) problems.push(`scene ${s.sceneId}: type "${s.type}" is not supported — ${UNSUPPORTED_SCENES[s.type] ?? "no component exists for it"}`);
    const media = s.assetIds.map((id) => assets.get(id)!).filter((a) => a.status !== "font");
    for (const a of media) if (a.required && a.status !== "resolved") problems.push(`scene ${s.sceneId}: required asset ${a.assetId} is not resolved`);
    if (s.type === "screen-capture" && !media.some((a) => a.status === "resolved" && a.video)) problems.push(`scene ${s.sceneId}: screen-capture needs a registered, validated video; it is never replaced by a blank or unrelated image`);
    const fallback: "none" | "text-only" = media.some((a) => a.status === "text-only-fallback") ? "text-only" : "none";
    const t = timing?.scenes.find((x) => x.sceneId === s.sceneId);
    return { sceneId: s.sceneId, type: s.type, component: component ?? "unsupported", startFrame: t?.startFrame ?? s.startFrame, durationInFrames: t?.durationInFrames ?? s.durationInFrames, fallback };
  });
  return { ok: problems.length === 0, problems, scenes };
}

type Clip = NonNullable<RenderRequest["clips"]>[number];

/** Clip placement per scene: what part of the validated window is shown and whether the last frame is held. */
export function planClips(manifest: SceneManifest, resolution: AssetResolution, scenes: RenderRequest["scenes"], fps: number): { clips: Clip[]; warnings: string[] } {
  const assets = new Map(resolution.assets.map((a) => [a.assetId, a]));
  const clips: Clip[] = [];
  const warnings: string[] = [];
  for (const s of manifest.scenes) {
    const videos = s.assetIds.map((id) => assets.get(id)!).filter((a) => a.status === "resolved" && a.video && a.clip);
    if (!videos.length) continue;
    if (videos.length > 1) warnings.push(`scene ${s.sceneId}: ${videos.length} videos are attached; only ${videos[0]!.assetId} is shown`);
    const a = videos[0]!;
    const sceneSec = scenes.find((x) => x.sceneId === s.sceneId)!.durationInFrames / fps;
    const window = a.clip!.endSec - a.clip!.startSec;
    const playSec = Math.round(Math.min(window, sceneSec) * 1000) / 1000;
    const holdSec = Math.round(Math.max(0, sceneSec - window) * 1000) / 1000;
    if (window > sceneSec + 1 / fps) warnings.push(`scene ${s.sceneId}: clip ${a.assetId} window is ${window.toFixed(2)} s but the scene lasts ${sceneSec.toFixed(2)} s; the last ${(window - sceneSec).toFixed(2)} s of the window are not shown`);
    if (holdSec > 1 / fps) warnings.push(`scene ${s.sceneId}: clip ${a.assetId} is ${window.toFixed(2)} s, shorter than the ${sceneSec.toFixed(2)} s scene; its last frame is held for ${holdSec.toFixed(2)} s`);
    clips.push({ sceneId: s.sceneId, assetId: a.assetId, sha256: a.file!.sha256, startSec: a.clip!.startSec, endSec: a.clip!.endSec, fit: a.clip!.fit, playSec, holdSec, sourceAudio: a.video!.audio ? "muted" : "none" });
  }
  return { clips, warnings };
}

// ------------------------------------------------------------------ queue-render step

export function queueStepConfig(ctx: FingerprintContext): unknown {
  return { render: ctx.config.render, maxConcurrentRenders: ctx.config.hardware.maxConcurrentRenders, browser: ctx.config.hardware.browserExecutable ?? null };
}

export const queueStepInputs = (ctx: FingerprintContext): unknown => ({ contentId: ctx.item.contentId });

/** Validates everything the render needs (cheaply) and records an exact render request. */
export async function queueRenderStepExecute(ctx: StepContext): Promise<StepResult> {
  const loaded = await loadRenderInputs(ctx);
  if (!loaded.ok) return { status: "blocked", code: loaded.code, reason: loaded.reason };
  const { manifest, resolution, refs, narration, subtitles, audio } = loaded.inputs;
  const map = mapScenes(manifest, resolution, narration?.timing);
  if (!map.ok) return { status: "blocked", code: map.problems.some((p) => p.includes("not supported")) ? "UNSUPPORTED_SCENE_TYPE" : "ASSETS_MISSING", reason: map.problems.join("; ") };
  const { width, height, fps } = manifest.format;
  if (width % 2 || height % 2) throw new StepError(`H.264 needs even dimensions; the manifest asks for ${width}x${height}`, { kind: "permanent", code: "RENDER_FORMAT_INVALID" });
  if (ctx.profile.voice.mode !== "none" && narration?.status !== "generated") return { status: "blocked", code: "NARRATION_MISSING", reason: `voice.mode is "${ctx.profile.voice.mode}" but no generated narration is verified; run resume` };
  const browser = await chooseBrowser(ctx.config);
  if (!browser.ok) return { status: "blocked", code: "BROWSER_UNAVAILABLE", reason: browser.message };
  const warnings = [...resolution.warnings, ...(narration?.warnings ?? [])];
  const c = manifest.brand.colors;
  if (c["text"] && c["background"]) {
    const ratio = contrastRatio(c["text"], c["background"]);
    if (ratio < 4.5) warnings.push(`brand text/background contrast is ${ratio.toFixed(2)}:1 (WCAG AA needs 4.5:1)`);
  }
  if (!audio) warnings.push('silent video (voice.mode "none"): burned-in captions with estimated timing, no audio track');
  const clipPlan = planClips(manifest, resolution, map.scenes, fps);
  warnings.push(...clipPlan.warnings);
  const durationInFrames = narration?.timing.durationInFrames ?? manifest.durationInFrames;
  const canonical = subtitles?.tracks.find((t) => t.language === manifest.narration.language) ?? subtitles?.tracks[0];
  const request: RenderRequest = {
    schemaVersion: 1,
    kind: "render-request",
    jobId: ctx.jobId,
    contentId: manifest.contentId,
    plan: { weekId: ctx.plan.weekId, version: ctx.plan.version, contentHash: ctx.plan.contentHash },
    inputs: refs,
    format: { width, height, fps, durationInFrames },
    settings: renderSettings(ctx.config, browser.chromeMode),
    renderer: { id: "creatorflow-remotion", version: RENDERER_VERSION, remotion: remotionVersion() },
    scenes: map.scenes,
    audio: audio ? { expected: "narration", file: { path: audio.path, sha256: audio.sha256, durationMs: audio.durationMs, sampleRate: audio.sampleRate, channels: audio.channels } } : { expected: "none" },
    captionsTiming: canonical?.timing ?? "estimated",
    clips: clipPlan.clips,
    warnings,
  };
  const v = validateArtifact(RenderRequestSchema, request);
  if (!v.ok) throw new StepError(`Render request invalid: ${v.issues[0]?.path}: ${v.issues[0]?.message}`, { kind: "permanent", code: "RENDER_REQUEST_INVALID" });
  await fs.mkdir(path.dirname(ctx.outputPath(REQUEST_OUTPUT)), { recursive: true });
  await writeFileAtomic(ctx.outputPath(REQUEST_OUTPUT), stringifyJson(v.value));
  return { status: "succeeded", metadata: { scenes: map.scenes.length, frames: durationInFrames, fallbacks: map.scenes.filter((s) => s.fallback !== "none").length, clips: clipPlan.clips.length, audio: audio ? "narration" : "none" } };
}

// ------------------------------------------------------------------ props

export interface StagedFile {
  /** Path inside the bundle public dir ("fonts/…", "assets/…", "audio/…"); also the staticFile() name. */
  name: string;
  abs: string;
  sha256: string;
}

const VIDEO_EXT: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv" };

/**
 * Builds Remotion props from the validated inputs. Captions are converted from
 * milliseconds to frames; text is passed verbatim (never re-wrapped or
 * truncated). Scene frames come from the request (narration timeline when
 * narrated). Returns the files that must be staged in the public dir.
 */
export function buildRenderProps(
  inputs: LoadedInputs,
  request: RenderRequest,
  resolveRoot: (root: string, family?: string) => string,
  codeText: (assetId: string) => string | undefined,
): { props: RenderProps; files: StagedFile[] } {
  const { manifest, resolution } = inputs;
  const fps = request.format.fps;
  const files: StagedFile[] = [];
  const assets = new Map(resolution.assets.map((a) => [a.assetId, a]));
  const stage = (dir: "fonts" | "assets" | "audio", prefix: string, root: string, rel: string, sha256: string, ext: string, family?: string) => {
    const name = `${dir}/${prefix}-${sha256.slice(7, 23)}${ext}`;
    if (!files.some((f) => f.name === name)) files.push({ name, abs: root === "abs" ? rel : resolveWithin(resolveRoot(root, family), rel), sha256 });
    return name;
  };
  const fonts = {} as RenderProps["brand"]["fonts"];
  for (const slot of ["heading", "body", "mono"] as const) {
    const f = resolution.fonts.find((x) => x.slot === slot)!;
    fonts[slot] = { family: f.family, faces: f.files.map((file) => ({ file: stage("fonts", `${slot}-${file.weight}`, file.root, file.path, file.sha256, ".woff", f.family), weight: file.weight, unicodeRange: file.unicodeRange })) };
  }
  const total = manifest.scenes.length;
  const clips = new Map((request.clips ?? []).map((c) => [c.sceneId, c]));
  const scenes: SceneProp[] = manifest.scenes.map((s, index) => {
    const req = request.scenes.find((x) => x.sceneId === s.sceneId)!;
    const media = s.assetIds.map((id) => assets.get(id)!).filter((a) => a.status === "resolved" && a.file);
    const img = media.find((a) => a.file!.mediaType.startsWith("image/"));
    const code = media.find((a) => a.file!.mediaType === "text/plain");
    const ext = (t: string) => ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" })[t] ?? "";
    const clip = clips.get(s.sceneId);
    const va = clip ? media.find((a) => a.assetId === clip.assetId) : undefined;
    let video: VideoProp | undefined;
    if (clip && va?.video) {
      const playFrames = Math.max(1, Math.min(req.durationInFrames, Math.round(clip.playSec * fps)));
      video = {
        file: stage("assets", va.assetId, va.file!.root, va.file!.path, va.file!.sha256, VIDEO_EXT[va.file!.mediaType] ?? ".mp4"),
        trimBefore: Math.round(clip.startSec * fps),
        playFrames,
        holdFrames: Math.max(0, req.durationInFrames - playFrames),
        fit: clip.fit,
        layout: FRAMED_VIDEO_COMPONENTS.has(req.component as SceneProp["component"]) ? "frame" : "backdrop",
        width: va.video.width,
        height: va.video.height,
      };
    }
    const attribution = media.find((a) => a.provenance?.attributionRequired && a.attribution)?.attribution;
    return {
      sceneId: s.sceneId,
      type: s.type,
      component: req.component as SceneProp["component"],
      startFrame: req.startFrame ?? s.startFrame,
      durationInFrames: req.durationInFrames ?? s.durationInFrames,
      index,
      total,
      primary: s.text.primary,
      ...(s.text.secondary ? { secondary: s.text.secondary } : {}),
      motion: { intent: s.motion.intent, intensity: s.motion.intensity, transitionIn: s.motion.transitionIn },
      safeArea: s.safeArea,
      ...(img && !video ? { image: { file: stage("assets", img.assetId, img.file!.root, img.file!.path, img.file!.sha256, ext(img.file!.mediaType)), alt: s.text.primary } } : {}),
      ...(code ? { code: codeText(code.assetId) ?? "" } : {}),
      ...(video ? { video } : {}),
      ...(attribution ? { attribution } : {}),
      textOnlyFallback: req.fallback === "text-only",
    };
  });
  const source = inputs.subtitles ?? inputs.captions;
  const track = source.tracks.find((t) => t.language === manifest.narration.language) ?? source.tracks[0]!;
  const toFrame = (ms: number) => Math.round((ms * fps) / 1000);
  const caps =
    request.settings.captions === "off"
      ? []
      : track.cues.map((c) => {
          const startFrame = toFrame(c.startMs);
          return { startFrame, endFrame: Math.min(request.format.durationInFrames, Math.max(startFrame + 1, toFrame(c.endMs))), lines: c.lines };
        });
  for (let i = 1; i < caps.length; i++) if (caps[i]!.startFrame < caps[i - 1]!.endFrame) caps[i - 1]!.endFrame = caps[i]!.startFrame;
  const colors = manifest.brand.colors;
  const audio = request.audio?.expected === "narration" && inputs.audio ? { file: stage("audio", "voice", "abs", inputs.audio.abs, inputs.audio.sha256, ".wav") } : undefined;
  return {
    props: {
      format: request.format,
      brand: {
        name: manifest.brand.name,
        colors: { primary: colors["primary"]!, secondary: colors["secondary"]!, accent: colors["accent"]!, background: colors["background"]!, text: colors["text"]! },
        fonts,
      },
      scenes,
      captions: caps.filter((c) => c.endFrame > c.startFrame),
      captionsTiming: track.timing ?? "estimated",
      ...(audio ? { audio } : {}),
    },
    files,
  };
}

/** sha256 of a file on disk (for re-verifying staged inputs). */
export async function fileSha(abs: string): Promise<string> {
  return `sha256:${sha256Hex(await fs.readFile(abs))}`;
}
