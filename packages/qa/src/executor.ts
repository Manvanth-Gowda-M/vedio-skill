import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprint, isProcessAlive, resolveWithin, sha256File, stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { readVerifiedOutput, StepError, verifiedBinaryOutput, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import { LOCALIZE_OUTPUTS } from "@creatorflow/localization";
import { captionLayout, contrastRatio, FONT_UNITS, FRAMED_VIDEO_COMPONENTS, headlineSize, unit, type ComponentId } from "@creatorflow/remotion-studio";
import {
  CanonicalScriptSchema,
  LocalizationSetSchema,
  QaReportSchema,
  RenderReportSchema,
  RenderRequestSchema,
  ResearchEvidencePackSchema,
  ReviewManifestSchema,
  validateArtifact,
  type QaCheck,
  type QaCheckStatus,
  type QaReport,
  type ReviewManifest,
} from "@creatorflow/schemas";
import { EVIDENCE_PATH, SCRIPT_OUTPUTS, validateScriptAgainstEvidence } from "@creatorflow/scriptwriter";
import { attributionProblems, captionCoverageProblems, captionLineProblems, captionMethodProblems, captionTextProblems, captionTimingProblems, narrationTextProblems, planProblems, sceneTimelineProblems, technicalVerdict } from "./checks.ts";
import { findFfmpeg, findFfprobe, inspectRender, loadRegistry, loadRenderInputs, projectDirOf, RENDER_OUTPUTS, REQUEST_OUTPUT, type FfprobeChoice } from "@creatorflow/video-engine";
import { parseWav, windowRmsDbfs } from "@creatorflow/voice";
import { analyzeFrame, clippedSamples, colourSignature, dropouts, hexToRgb, levels10ms, planSamples, seekTimeFor, signatureMatches, silentRuns, type CueSpan, type FrameMetrics } from "./analyze.ts";
import { decodeAll, extractFrame, thumbnail, toolInfo } from "./inspect.ts";
import { decodePng } from "./png.ts";

export const QA_VERSION = "qa-1";
export const QA_OUTPUTS = { report: "qa/report.json", reviewManifest: "qa/review-manifest.json" } as const;
export const QA_FRAMES_DIR = "qa/frames";
/** Ratio applied by the composition's backdrop scrim (rgba(0,0,0,0.58)). */
const BACKDROP_GAIN = 0.42;

export interface QaOptions {
  /** Override tool discovery (`null` = pretend the tool is missing). */
  ffprobe?: FfprobeChoice | null;
  ffmpeg?: FfprobeChoice | null;
  now?: () => Date;
}

export const qaStepInputs = (ctx: FingerprintContext): unknown => ({ contentId: ctx.item.contentId, qaVersion: QA_VERSION });
export const qaStepConfig = (ctx: FingerprintContext): unknown => ({ qa: ctx.config.qa, subtitles: ctx.config.localization.subtitles, captions: ctx.config.render.captions, requireFinalReview: ctx.profile.approval.requireFinalReview });

/** This job's registry bindings (an unrelated job's asset change does not invalidate QA) and the inspection tools. */
export function makeQaStepExternalInputs(o: QaOptions = {}) {
  return async (ctx: FingerprintContext & { workspaceDir: string }): Promise<unknown> => {
    const reg = await loadRegistry(ctx.workspaceDir);
    const mine = reg.bindings.filter((b) => b.jobId === ctx.jobId).map((b) => ({ assetId: b.assetId, sha256: b.sha256, registryId: b.registryId ?? null })).sort((a, b) => (a.assetId < b.assetId ? -1 : 1));
    const ffprobe = o.ffprobe === undefined ? await findFfprobe(ctx.config) : o.ffprobe;
    const ffmpeg = o.ffmpeg === undefined ? await findFfmpeg(ctx.config) : o.ffmpeg;
    return { registryProblem: reg.problem ?? null, bindings: mine, tools: { ffprobe: ffprobe?.description ?? null, ffmpeg: ffmpeg?.description ?? null } };
  };
}

/** Removes frame staging dirs and QA temp dirs left by processes that died mid-QA. */
export async function cleanupStaleQaDirs(jobQaDir: string): Promise<void> {
  for (const name of await fs.readdir(jobQaDir).catch(() => [] as string[])) {
    const m = /^\.frames-(\d+)-/.exec(name);
    if (m && Number(m[1]) !== process.pid && !isProcessAlive(Number(m[1]))) await fs.rm(path.join(jobQaDir, name), { recursive: true, force: true });
  }
  for (const name of await fs.readdir(os.tmpdir()).catch(() => [] as string[])) {
    const m = /^cf-qa-(\d+)-/.exec(name);
    if (m && Number(m[1]) !== process.pid && !isProcessAlive(Number(m[1]))) await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function makeQaStepExecute(opts: QaOptions = {}): (ctx: StepContext) => Promise<StepResult> {
  const now = opts.now ?? (() => new Date());
  return async (ctx): Promise<StepResult> => {
    const t0 = Date.now();
    let rssPeak = process.memoryUsage().rss;
    const sampler = setInterval(() => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss)), 100);
    sampler.unref();
    const qaDir = ctx.outputPath("qa");
    await fs.mkdir(qaDir, { recursive: true });
    await cleanupStaleQaDirs(qaDir);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `cf-qa-${process.pid}-`));
    const staging = path.join(qaDir, `.frames-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      // ---------------------------------------------------------------- verified evidence (never used unless hashes match)
      const rq = await readVerifiedOutput(ctx, "queue-render", REQUEST_OUTPUT);
      const rr = await readVerifiedOutput(ctx, "render", RENDER_OUTPUTS.report);
      const video = await verifiedBinaryOutput(ctx, "render", RENDER_OUTPUTS.video);
      const sc = await readVerifiedOutput(ctx, "script", SCRIPT_OUTPUTS.script);
      const ev = await readVerifiedOutput(ctx, "research", EVIDENCE_PATH);
      const lv = await readVerifiedOutput(ctx, "localize", LOCALIZE_OUTPUTS.variants);
      for (const r of [rq, rr, video, sc, ev, lv]) if (!r.ok) return { status: "blocked", code: r.code, reason: `QA needs verified upstream evidence: ${r.reason}` };
      if (!rq.ok || !rr.ok || !video.ok || !sc.ok || !ev.ok || !lv.ok) throw new Error("unreachable");
      const loaded = await loadRenderInputs(ctx);
      if (!loaded.ok) return { status: "blocked", code: loaded.code, reason: `QA cannot trust the render inputs: ${loaded.reason}` };
      const reqV = validateArtifact(RenderRequestSchema, JSON.parse(rq.file.raw));
      const repV = validateArtifact(RenderReportSchema, JSON.parse(rr.file.raw));
      const scrV = validateArtifact(CanonicalScriptSchema, JSON.parse(sc.file.raw));
      const evV = validateArtifact(ResearchEvidencePackSchema, JSON.parse(ev.file.raw));
      const locV = validateArtifact(LocalizationSetSchema, JSON.parse(lv.file.raw));
      for (const [name, v] of [["render/request.json", reqV], ["render/report.json", repV], ["script/script.json", scrV], ["research/evidence.json", evV], ["localize/variants.json", locV]] as const) {
        if (!v.ok) return { status: "blocked", code: "QA_EVIDENCE_INVALID", reason: `${name} fails schema validation: ${v.issues[0]?.path}: ${v.issues[0]?.message}` };
      }
      if (!reqV.ok || !repV.ok || !scrV.ok || !evV.ok || !locV.ok) throw new Error("unreachable");
      const request = reqV.value;
      const report = repV.value;
      const script = scrV.value;
      const { manifest, resolution, narration, subtitles, audio: narrAudio, refs } = loaded.inputs;
      if (!narration || !subtitles) return { status: "blocked", code: "UPSTREAM_MISSING", reason: "QA needs the verified narration record and subtitles" };
      const { width: W, height: H, fps, durationInFrames: N } = request.format;
      const durationMs = (N * 1000) / fps;
      const narrated = narration.status === "generated";
      const L = ctx.config.qa;

      const checks: QaCheck[] = [];
      const reviewItems: QaReport["reviewItems"] = [];
      const add = (c: Omit<QaCheck, "detail"> & { detail: string }) => checks.push({ ...c, detail: c.detail.slice(0, 4000), ...(c.evidence ? { evidence: c.evidence.slice(0, 50) } : {}) });
      const verdict = (problems: string[], ok: string): { status: QaCheckStatus; detail: string } => (problems.length ? { status: "FAIL", detail: problems.join("; ") } : { status: "PASS", detail: ok });

      // ---------------------------------------------------------------- file integrity and report consistency
      {
        const p: string[] = [];
        if (video.sha256 !== report.output.sha256) p.push(`MP4 sha256 ${video.sha256.slice(0, 19)}… differs from the render report's ${report.output.sha256.slice(0, 19)}…`);
        if (video.bytes !== report.output.bytes) p.push(`MP4 is ${video.bytes} bytes, report says ${report.output.bytes}`);
        if (video.bytes === 0) p.push("MP4 is empty");
        if (video.bytes > L.maxOutputBytes) p.push(`MP4 is ${video.bytes} bytes, above qa.maxOutputBytes ${L.maxOutputBytes}`);
        const mbPerMin = video.bytes / 1048576 / Math.max(1 / 60, N / fps / 60);
        if (mbPerMin > L.maxOutputMbPerMinute) p.push(`${mbPerMin.toFixed(0)} MB per minute exceeds qa.maxOutputMbPerMinute ${L.maxOutputMbPerMinute}`);
        add({ id: "file.integrity", category: "file", title: "Output file exists, is within size limits and matches the verified render report", required: true, method: "objective", ...verdict(p, `${video.bytes} bytes, sha256 ${video.sha256.slice(0, 19)}… matches the render step record and report`) });
      }
      {
        const p: string[] = [];
        if (report.jobId !== ctx.jobId || report.contentId !== ctx.item.contentId) p.push(`report is for ${report.jobId}/${report.contentId}`);
        if (report.request.sha256 !== rq.file.sha256) p.push("report refers to a different render request");
        if (report.sceneManifest.sha256 !== refs.manifest.sha256) p.push("report refers to a different scene manifest");
        const e = report.expected;
        if (e.width !== W || e.height !== H || e.fps !== fps || e.durationInFrames !== N) p.push(`report expected ${e.width}x${e.height}@${e.fps} ${e.durationInFrames}f, request says ${W}x${H}@${fps} ${N}f`);
        if (report.status !== "rendered") p.push(`report status ${report.status}`);
        for (const k of Object.keys(request.inputs) as (keyof typeof request.inputs)[]) if (request.inputs[k]?.sha256 !== refs[k]?.sha256) p.push(`${request.inputs[k]?.path ?? k} changed after the render was queued`);
        if (narrated && request.audio?.file?.sha256 !== narrAudio?.sha256) p.push("narration audio differs from the one the render used");
        const resAssets = new Map(resolution.assets.map((a) => [a.assetId, a]));
        for (const a of report.assets) {
          const r = resAssets.get(a.assetId);
          if (!r || r.status !== a.status || (r.file?.sha256 ?? undefined) !== a.sha256) p.push(`report asset ${a.assetId} differs from the asset resolution`);
        }
        add({ id: "file.dependencies", category: "file", title: "Render report, request, manifest, captions, assets and narration hashes form one consistent chain", required: true, method: "objective", ...verdict(p, "every input hash recorded in the request and report is the current verified one") });
      }

      // ---------------------------------------------------------------- container and streams (ffprobe)
      const ffprobe = opts.ffprobe === undefined ? await findFfprobe(ctx.config) : (opts.ffprobe ?? undefined);
      const ffmpeg = opts.ffmpeg === undefined ? await findFfmpeg(ctx.config) : (opts.ffmpeg ?? undefined);
      const tools = [];
      if (ffprobe) tools.push(await toolInfo("ffprobe", ffprobe));
      if (ffmpeg) tools.push(await toolInfo("ffmpeg", ffmpeg));
      const mi = await inspectRender(video.abs, request.format, ffprobe);
      add({ id: "video.container", category: "video", title: "MP4 container structure is complete (ftyp, moov, mdat tile the file)", required: true, method: "objective", status: mi.container.ok ? "PASS" : "FAIL", detail: mi.container.ok ? `boxes ${mi.container.boxes.join(", ")}` : (mi.container.problem ?? "invalid") });
      if (!mi.performed) add({ id: "video.stream", category: "video", title: "Video stream metadata matches the request", required: true, method: "objective", status: "NOT_INSPECTED", detail: mi.reason ?? "no ffprobe" });
      else {
        const p = [...mi.mismatches];
        const rv = report.mediaInspection.video;
        if (rv && mi.video && (rv.codec !== mi.video.codec || rv.width !== mi.video.width || rv.height !== mi.video.height || rv.frames !== mi.video.frames)) p.push("stream metadata differs from what the render report recorded");
        if (mi.video && Math.abs(mi.video.durationSec - N / fps) > L.durationToleranceFrames / fps) p.push(`duration ${mi.video.durationSec}s vs expected ${(N / fps).toFixed(3)}s`);
        add({ id: "video.stream", category: "video", title: "Video stream codec, dimensions, frame rate, frame count and duration match the request and report", required: true, method: "objective", ...verdict(p, `${mi.video?.codec} ${mi.video?.width}x${mi.video?.height} ${mi.video?.fps} fps, ${mi.video?.frames ?? "?"} frames, ${mi.video?.durationSec}s`) });
      }

      // ---------------------------------------------------------------- one full decode pass (video + audio)
      const audioStreams = mi.performed ? (mi.audioStreams ?? 0) : null;
      const wav = path.join(tmp, "audio.wav");
      const decode = ffmpeg && mi.container.ok ? await decodeAll(ffmpeg, video.abs, (audioStreams ?? 0) > 0 ? wav : undefined, { timeoutMs: L.timeoutMs, signal: ctx.signal }) : undefined;
      if (!ffmpeg) add({ id: "video.decode", category: "video", title: "Every video frame decodes", required: true, method: "objective", status: "NOT_INSPECTED", detail: "no ffmpeg available to decode the video" });
      else if (!decode) add({ id: "video.decode", category: "video", title: "Every video frame decodes", required: true, method: "objective", status: "FAIL", detail: "not decoded: the container is invalid" });
      else {
        const p: string[] = [];
        if (!decode.ok) p.push(`decode errors: ${decode.errors.join(" | ")}`);
        if (decode.frames !== N) p.push(`decoded ${decode.frames ?? "?"} frames, expected ${N}`);
        add({ id: "video.decode", category: "video", title: "Every video frame decodes", required: true, method: "objective", ...verdict(p, `${decode.frames} frames decoded without errors in ${decode.ms} ms`) });
      }

      // ---------------------------------------------------------------- audio
      let pcm: ReturnType<typeof parseWav> | undefined;
      let audioMeta: QaReport["media"]["audio"] = null;
      if (audioStreams === null) add({ id: "audio.streams", category: "audio", title: "Audio stream configuration matches the narration mode", required: true, method: "objective", status: "NOT_INSPECTED", detail: "streams not inspected (no ffprobe)" });
      else if (!narrated) add({ id: "audio.streams", category: "audio", title: "Silent job has no audio stream", required: true, method: "objective", ...verdict(audioStreams === 0 ? [] : [`${audioStreams} audio stream(s) in a job whose voice.mode is "${narration.requested.mode}"`], "no audio stream (intentionally silent)") });
      else {
        const a = mi.audio;
        const p: string[] = [];
        if (audioStreams !== 1) p.push(`${audioStreams} audio streams, expected exactly 1`);
        if (a?.codec !== "aac") p.push(`audio codec ${a?.codec ?? "none"}, expected aac`);
        if (!a?.sampleRate || !a?.channels) p.push("audio stream has no sample rate or channel count");
        if (a?.durationSec === undefined || Math.abs(a.durationSec - N / fps) > L.audioDurationToleranceSec) p.push(`audio stream ${a?.durationSec ?? "?"}s vs video ${(N / fps).toFixed(3)}s (tolerance ${L.audioDurationToleranceSec}s)`);
        add({ id: "audio.streams", category: "audio", title: "Narrated job has exactly one AAC stream as long as the video", required: true, method: "objective", ...verdict(p, `1 ${a?.codec} stream, ${a?.sampleRate} Hz, ${a?.channels} ch, ${a?.durationSec}s`) });
      }
      if ((audioStreams ?? 0) > 0 && decode) {
        try {
          pcm = parseWav(await fs.readFile(wav));
        } catch {
          pcm = undefined;
        }
      }
      if (narrated) {
        if (!pcm) add({ id: "audio.decode", category: "audio", title: "Audio decodes and its length matches the timeline", required: true, method: "objective", status: ffmpeg && audioStreams !== null ? "FAIL" : "NOT_INSPECTED", detail: ffmpeg && audioStreams !== null ? "the audio stream could not be decoded" : "no ffmpeg/ffprobe to decode audio" });
        else {
          const decSec = pcm.samples.length / pcm.sampleRate;
          const clipped = clippedSamples(pcm.samples);
          let peak = 0;
          let sq = 0;
          for (const s of pcm.samples) {
            peak = Math.max(peak, Math.abs(s));
            sq += s * s;
          }
          const db = (v: number) => (v <= 0 ? -120 : Math.round(20 * Math.log10(v / 32768) * 100) / 100);
          audioMeta = { codec: mi.audio?.codec ?? "unknown", sampleRate: mi.audio?.sampleRate ?? null, channels: mi.audio?.channels ?? null, durationSec: mi.audio?.durationSec ?? null, decodedDurationSec: Math.round(decSec * 1000) / 1000, peakDbfs: db(peak), rmsDbfs: db(Math.sqrt(sq / Math.max(1, pcm.samples.length))), clippedSamples: clipped };
          const p: string[] = [];
          if (Math.abs(decSec - N / fps) > L.audioDurationToleranceSec) p.push(`decoded audio ${decSec.toFixed(3)}s vs video ${(N / fps).toFixed(3)}s`);
          if (Math.abs(decSec * 1000 - narration.timing.durationMs) > L.audioDurationToleranceSec * 1000) p.push(`decoded audio ${decSec.toFixed(3)}s vs narration timeline ${narration.timing.durationMs} ms`);
          add({ id: "audio.decode", category: "audio", title: "Audio decodes and its length matches the video and the narration timeline", required: true, method: "objective", ...verdict(p, `${decSec.toFixed(3)}s decoded; video ${(N / fps).toFixed(3)}s; timeline ${narration.timing.durationMs} ms`) });
          const windows = narration.segments.flatMap((s) => s.sentences.map((x) => ({ startMs: x.speechStartMs, endMs: x.speechEndMs, label: `${s.segmentId}#${x.index + 1}` })));
          const quiet = windows.filter((w) => windowRmsDbfs(pcm!, w.startMs, w.endMs) < L.speechFloorDbfs);
          add({ id: "audio.speech", category: "audio", title: "Speech is audible in every narrated sentence window", required: true, method: "objective", ...verdict(windows.length === 0 ? ["no narrated sentence windows"] : quiet.map((q) => `${q.label} (${q.startMs}–${q.endMs} ms) below ${L.speechFloorDbfs} dBFS`), `${windows.length}/${windows.length} sentence windows ≥ ${L.speechFloorDbfs} dBFS RMS`) });
          const ratio = clipped / Math.max(1, pcm.samples.length);
          add({ id: "audio.clipping", category: "audio", title: "Decoded audio is not clipped beyond the limit", required: true, method: "objective", ...verdict(ratio > L.maxClippedRatio ? [`${clipped} clipped samples (${(ratio * 100).toFixed(3)}%) > ${L.maxClippedRatio * 100}%`] : [], `${clipped} samples at full scale (limit ${(L.maxClippedRatio * 100).toFixed(2)}%); peak ${audioMeta.peakDbfs} dBFS`) });
          const runs = silentRuns(levels10ms(pcm.samples, pcm.sampleRate), L.silenceFloorDbfs);
          const drop = dropouts(runs, windows, L.maxDropoutMs);
          add({ id: "audio.dropouts", category: "audio", title: "No unexpected silence inside narrated sentences", required: true, method: "objective", ...verdict(drop.map((d) => `silent ${d.startMs}–${d.endMs} ms inside a sentence`), `no silence longer than ${L.maxDropoutMs} ms inside any sentence (${runs.length} silent stretches overall: word gaps and planned pauses)`) });
          const longPauses = runs.filter((r) => r.endMs - r.startMs > L.maxPauseMs);
          add({ id: "audio.pauses", category: "audio", title: "No long pauses between sentences", required: false, method: "heuristic", status: longPauses.length ? "NEEDS_REVIEW" : "PASS", detail: longPauses.length ? `${longPauses.length} silence(s) longer than ${L.maxPauseMs} ms: ${longPauses.slice(0, 5).map((r) => `${r.startMs}–${r.endMs} ms`).join(", ")} (planned scene time, but check pacing)` : `longest silence ${Math.max(0, ...runs.map((r) => r.endMs - r.startMs))} ms` });
        }
        add({ id: "audio.loudness", category: "audio", title: "Integrated loudness (LUFS)", required: false, method: "objective", status: "NOT_INSPECTED", detail: "not measured: the bundled FFmpeg has no ebur128/loudnorm filter and CreatorFlow has no LUFS meter; peak and RMS are reported instead" });
      } else {
        for (const [id, title] of [["audio.decode", "Audio decodes"], ["audio.speech", "Speech present"], ["audio.clipping", "Audio clipping"], ["audio.dropouts", "Silence inside speech"]] as const) add({ id, category: "audio", title, required: true, method: "objective", status: "NOT_APPLICABLE", detail: `intentionally silent video (voice.mode "${narration.requested.mode}")` });
      }

      // ---------------------------------------------------------------- captions (data checks)
      const canon = subtitles.tracks.find((t) => t.language === manifest.narration.language) ?? subtitles.tracks[0]!;
      const burnIn = request.settings.captions === "burn-in";
      const toFrame = (ms: number) => Math.round((ms * fps) / 1000);
      const cueSpans: CueSpan[] = burnIn ? canon.cues.map((c) => ({ cueId: c.cueId, startFrame: toFrame(c.startMs), endFrame: Math.min(N, Math.max(toFrame(c.startMs) + 1, toFrame(c.endMs))) })) : [];
      for (let i = 1; i < cueSpans.length; i++) if (cueSpans[i]!.startFrame < cueSpans[i - 1]!.endFrame) cueSpans[i - 1]!.endFrame = cueSpans[i]!.startFrame;
      {
        const p = captionTimingProblems(canon, durationMs);
        add({ id: "captions.timing", category: "captions", title: "Caption cues are ordered, positive and inside the video", required: true, method: "objective", ...verdict(p, `${canon.cues.length} cues, ordered, all within ${durationMs.toFixed(0)} ms`) });
      }
      {
        const p = captionTextProblems(script.segments, canon);
        add({ id: "captions.text", category: "captions", title: "Caption text equals the approved script narration, segment by segment", required: true, method: "objective", ...verdict(p, `${script.segments.length} segments: caption text identical to the script (whitespace aside)`) });
      }
      if (narrated) {
        const p = captionCoverageProblems(narration, canon);
        add({ id: "captions.coverage", category: "captions", title: "Every narrated sentence has a caption while it is spoken", required: true, method: "objective", ...verdict(p, `${narration.segments.reduce((n, s) => n + s.sentences.length, 0)} sentences, each overlapped by a cue of its segment`) });
      } else add({ id: "captions.coverage", category: "captions", title: "Every narrated sentence has a caption", required: true, method: "objective", status: "NOT_APPLICABLE", detail: "no narration" });
      {
        const p = captionMethodProblems(narrated, canon.timing, report.captions.timing, request.captionsTiming, report.captions.validation);
        add({ id: "captions.method", category: "captions", title: "Caption timing method is reported honestly", required: true, method: "objective", ...verdict(p, `"${canon.timing}" (${narrated ? "measured sentence boundaries; not word-aligned" : "estimated from text length; no audio"})`) });
      }
      {
        const S = ctx.config.localization.subtitles;
        const { fail: p, warn: w } = captionLineProblems(canon, S);
        add({ id: "captions.lines", category: "captions", title: "Caption lines respect the line-length and line-count limits", required: true, method: "objective", ...verdict(p, `all lines ≤ ${S.maxCharsPerLine} characters and ≤ ${S.maxLines} lines${w.length ? `; ${w.length} single unbreakable word(s) longer than the limit` : ""}`) });
        const slow = canon.warnings.filter((x) => x.code === "READING_SPEED");
        add({ id: "captions.reading-speed", category: "captions", title: "Caption reading speed", required: false, method: "heuristic", status: slow.length ? "NEEDS_REVIEW" : "PASS", detail: slow.length ? `${slow.length} cue(s) above ${S.maxCps} characters/second: ${slow.slice(0, 5).map((x) => x.cueId).join(", ")}` : `all cues ≤ ${S.maxCps} characters/second` });
      }

      // ---------------------------------------------------------------- frames: sampling and pixel checks
      const scenes = request.scenes.map((s) => ({ sceneId: s.sceneId, startFrame: s.startFrame, durationInFrames: s.durationInFrames }));
      const plan = planSamples(scenes, N, fps, cueSpans, { everySec: L.sampleEverySec, max: L.maxSamples });
      const c = manifest.brand.colors;
      const layoutBase = { background: hexToRgb(c["background"]!), text: hexToRgb(c["text"]!), margins: L.safeMargins, progressRows: Math.ceil(unit(W, H) * 0.5) + 2 };
      const samples: QaReport["frames"]["samples"] = [];
      const metrics = new Map<number, FrameMetrics>();
      const tF = Date.now();
      let extractProblems: string[] = [];
      if (ffmpeg && decode?.ok) {
        await fs.mkdir(staging, { recursive: true });
        for (const s of plan) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          const name = `frame-${String(s.frame).padStart(6, "0")}.png`;
          const out = path.join(staging, name);
          const x = await extractFrame(ffmpeg, video.abs, seekTimeFor(s.frame, fps), out, { signal: ctx.signal });
          if (!x.ok) {
            extractProblems.push(`frame ${s.frame}: ${x.message}`);
            continue;
          }
          let img;
          try {
            img = decodePng(await fs.readFile(out));
          } catch (e) {
            extractProblems.push(`frame ${s.frame}: ${(e as Error).message}`);
            continue;
          }
          if (img.width !== W || img.height !== H) extractProblems.push(`frame ${s.frame} is ${img.width}x${img.height}`);
          const scene = manifest.scenes.find((m) => m.sceneId === s.sceneId)!;
          const m = analyzeFrame(img, { ...layoutBase, captionZoneTop: H * (1 - scene.safeArea.bottom) }, { blankStdDev: L.blankStdDev, blankUniformFraction: L.blankUniformFraction });
          metrics.set(s.frame, m);
          samples.push({ ...s, timeSec: Math.round((s.frame / fps) * 1000) / 1000, path: `${QA_FRAMES_DIR}/${name}`, sha256: (await sha256File(out)).sha256, width: img.width, height: img.height, metrics: m });
        }
      }
      const framesMs = Date.now() - tF;
      const visualInspectable = Boolean(ffmpeg && decode?.ok);
      const notInspected = (id: string, title: string, required = true) => add({ id, category: id.startsWith("captions") ? "captions" : "visual", title, required, method: "objective", status: "NOT_INSPECTED", detail: !ffmpeg ? "no ffmpeg to extract frames" : "the video did not decode, so frames were not analysed" });
      if (!visualInspectable) {
        for (const [id, title] of [["visual.frames", "Sample frames decode at the expected size"], ["visual.blank", "No blank frames inside scenes"], ["visual.edges", "No text cut off at the frame edges"], ["visual.safe-margins", "Outer safe margins are free of text"], ["captions.burned-in", "Captions appear exactly while a cue is active"], ["captions.safe-area", "Captions sit inside the safe margins"], ["captions.contrast", "Measured caption contrast"], ["visual.assets", "Registered media is visible in its scenes"]] as const) notInspected(id, title);
      } else {
        add({ id: "visual.frames", category: "visual", title: "Sample frames decode at the expected size", required: true, method: "objective", ...verdict(extractProblems.length || samples.length !== plan.length ? [...extractProblems, ...(samples.length !== plan.length ? [`${samples.length}/${plan.length} frames extracted`] : [])] : [], `${samples.length} frames at ${W}x${H}: start, middle, end, every scene and every ${L.sampleEverySec}s`), evidence: samples.map((s) => s.path) });
        const blanks = samples.filter((s) => s.metrics.blank && !s.blankAllowed);
        const allowed = samples.filter((s) => s.metrics.blank && s.blankAllowed);
        add({ id: "visual.blank", category: "visual", title: "No blank or nearly uniform frames inside scenes", required: true, method: "objective", ...verdict(blanks.map((s) => `frame ${s.frame} (${s.sceneId}, ${s.purpose}) is nearly uniform: luma σ ${s.metrics.lumaStdDev}, ${(s.metrics.uniformFraction * 100).toFixed(1)}% at one level`), `no blank scene content in ${samples.length - allowed.length} non-transition frames${allowed.length ? `; ${allowed.length} blank frame(s) inside entrance/exit animation windows are allowed (${allowed.map((s) => s.frame).join(", ")})` : ""}`), evidence: blanks.map((s) => s.path) });
        const edges = samples.filter((s) => s.metrics.edgeForeground > 0);
        add({ id: "visual.edges", category: "visual", title: "No text-like pixels at the outermost frame edges (cut-off content)", required: true, method: "heuristic", ...verdict(edges.map((s) => `frame ${s.frame}: ${s.metrics.edgeForeground} text-like pixels at the edge`), "no text-like pixels in the outer 0.5% border of any sample"), evidence: edges.map((s) => s.path) });
        const margins = samples.filter((s) => s.metrics.marginForeground > 20);
        add({ id: "visual.safe-margins", category: "visual", title: "Outer safe margins are free of text", required: true, method: "heuristic", ...verdict(margins.map((s) => `frame ${s.frame}: ${s.metrics.marginForeground} text-like pixels in the safe margins`), `no text-like pixels inside margins top ${L.safeMargins.top}, bottom ${L.safeMargins.bottom}, left ${L.safeMargins.left}, right ${L.safeMargins.right}`), evidence: margins.map((s) => s.path) });
        {
          const p: string[] = [];
          for (const s of samples) {
            if (s.activeCueId && !s.metrics.captionBox) p.push(`frame ${s.frame}: cue ${s.activeCueId} is active but no caption was found`);
            if (!s.activeCueId && s.metrics.captionBox) p.push(`frame ${s.frame}: caption-like text without an active cue`);
          }
          const withCue = samples.filter((s) => s.activeCueId).length;
          add({ id: "captions.burned-in", category: "captions", title: burnIn ? "Captions are visible exactly while a cue is active" : "No captions are drawn (render.captions off)", required: true, method: "heuristic", ...verdict(p, burnIn ? `caption text found in all ${withCue} samples with an active cue and in none of the ${samples.length - withCue} without` : "no caption text in any sample") });
        }
        {
          const p: string[] = [];
          const wrapped: string[] = [];
          for (const s of samples) {
            const b = s.metrics.captionBox;
            if (!b) continue;
            if (b.left < L.safeMargins.left * W || b.right >= W - L.safeMargins.right * W || b.bottom >= H - L.safeMargins.bottom * H) p.push(`frame ${s.frame}: caption box x ${b.left}–${b.right}, y ${b.top}–${b.bottom} leaves the safe area`);
            const cue = canon.cues.find((q) => q.cueId === s.activeCueId);
            const scene = manifest.scenes.find((m) => m.sceneId === s.sceneId)!;
            if (cue) {
              const lay = captionLayout(W, H, scene.safeArea.bottom, cue.lines.length);
              if (b.top < lay.top - lay.fontPx * 0.5) wrapped.push(`frame ${s.frame}: caption is taller than its ${cue.lines.length} line(s); the browser wrapped it`);
              if (b.top <= Math.round(H * (1 - scene.safeArea.bottom)) + 1) wrapped.push(`frame ${s.frame}: caption reaches into the scene content area`);
            }
          }
          add({ id: "captions.safe-area", category: "captions", title: "Captions sit inside the safe margins", required: true, method: "heuristic", ...verdict(p, `all detected caption boxes inside the safe margins`) });
          add({ id: "captions.layout", category: "captions", title: "Captions keep their planned line layout", required: false, method: "heuristic", status: wrapped.length ? "NEEDS_REVIEW" : "PASS", detail: wrapped.length ? wrapped.slice(0, 8).join("; ") : "every detected caption fits its planned box" });
          const low = samples.filter((s) => s.metrics.captionContrast !== null && s.metrics.captionContrast < L.minContrast);
          const measured = samples.filter((s) => s.metrics.captionContrast !== null);
          add({ id: "captions.contrast", category: "captions", title: "Measured caption text/box contrast", required: burnIn, method: "objective", status: !burnIn ? "NOT_APPLICABLE" : !measured.length ? "NEEDS_REVIEW" : low.length ? "FAIL" : "PASS", detail: !burnIn ? "captions are off" : !measured.length ? "no caption was sampled" : low.length ? low.map((s) => `frame ${s.frame}: ${s.metrics.captionContrast}:1 < ${L.minContrast}:1`).join("; ") : `min ${Math.min(...measured.map((s) => s.metrics.captionContrast!))}:1 over ${measured.length} samples (≥ ${L.minContrast}:1)` });
        }
        // Registered media visible in its scenes (colour-signature heuristic, compared with frames of other scenes).
        {
          const p: string[] = [];
          const review: string[] = [];
          const passed: string[] = [];
          const projectDir = projectDirOf(ctx.workspaceDir, ctx.config);
          const assets = new Map(resolution.assets.map((a) => [a.assetId, a]));
          const mids = new Map(samples.filter((s) => s.purpose === "scene-mid").map((s) => [s.sceneId, s]));
          for (const scene of manifest.scenes) {
            const media = scene.assetIds.map((id) => assets.get(id)!).filter((a) => a.status === "resolved" && a.file && (a.file.mediaType.startsWith("image/") || a.video));
            for (const a of media) {
              const sample = mids.get(scene.sceneId);
              if (!sample) {
                review.push(`${a.assetId}: no mid-scene sample`);
                continue;
              }
              const req = request.scenes.find((x) => x.sceneId === scene.sceneId)!;
              const clip = request.clips?.find((x) => x.sceneId === scene.sceneId && x.assetId === a.assetId);
              if (a.video && !clip) {
                review.push(`${a.assetId}: video is attached but not the one shown in ${scene.sceneId}`);
                continue;
              }
              const src = resolveWithin(a.file!.root === "assets" ? resolveWithin(ctx.workspaceDir, "assets") : projectDir, a.file!.path);
              const tScene = (sample.frame - req.startFrame) / fps;
              const at = clip ? clip.startSec + Math.min(tScene, Math.max(0, clip.playSec - 1 / fps)) : undefined;
              const thumbFile = path.join(tmp, `thumb-${a.assetId}.png`);
              if (!(await thumbnail(ffmpeg!, src, at, thumbFile, { signal: ctx.signal }))) {
                review.push(`${a.assetId}: the source could not be decoded for comparison`);
                continue;
              }
              const sig = colourSignature(decodePng(await fs.readFile(thumbFile)), [layoutBase.background]);
              if (!sig.length) {
                review.push(`${a.assetId}: the source has no distinctive colours to look for`);
                continue;
              }
              const gain = a.video && !FRAMED_VIDEO_COMPONENTS.has(req.component as ComponentId) ? BACKDROP_GAIN : 1;
              const here = signatureMatches(decodePng(await fs.readFile(path.join(staging, path.basename(sample.path)))), sig, gain);
              const others = [];
              for (const o of samples.filter((s) => s.purpose === "scene-mid" && s.sceneId !== scene.sceneId)) others.push(signatureMatches(decodePng(await fs.readFile(path.join(staging, path.basename(o.path)))), sig, gain));
              others.sort((x, y) => x - y);
              const control = others.length ? others[Math.floor(others.length / 2)]! : 0;
              const need = Math.round(W * H * 0.002);
              const line = `${a.assetId} in ${scene.sceneId}: ${here} matching pixels vs ${control} in other scenes (need +${need})`;
              if (here - control >= need) passed.push(line);
              else p.push(line);
            }
          }
          const status: QaCheckStatus = p.length ? "FAIL" : review.length ? "NEEDS_REVIEW" : passed.length ? "PASS" : "NOT_APPLICABLE";
          add({ id: "visual.assets", category: "visual", title: "Registered images and video clips are visible in their scenes", required: true, method: "heuristic", status, detail: [...p, ...review, ...passed].join("; ") || "no registered images or videos in this video" });
        }
      }
      // Layout data checks (no pixels needed).
      {
        const pairs: [string, string][] = [["text", c["text"]!], ["secondary (source labels)", c["secondary"]!]];
        const p = pairs.map(([n, col]) => [n, contrastRatio(col, c["background"]!)] as const).filter(([, r]) => r < L.minContrast).map(([n, r]) => `brand ${n} on background is ${r.toFixed(2)}:1 < ${L.minContrast}:1`);
        add({ id: "visual.text-contrast", category: "visual", title: "Brand text colours contrast with the background (WCAG)", required: true, method: "objective", ...verdict(p, pairs.map(([n, col]) => `${n} ${contrastRatio(col, c["background"]!).toFixed(1)}:1`).join(", ")) });
        const backdrop = request.scenes.filter((s) => request.clips?.some((x) => x.sceneId === s.sceneId) && !FRAMED_VIDEO_COMPONENTS.has(s.component as ComponentId));
        if (backdrop.length) reviewItems.push({ id: "review.backdrop-contrast", topic: "legibility", question: `Is the text legible over the dimmed video backdrop in ${backdrop.map((s) => s.sceneId).join(", ")}? (contrast over moving video is not measured)`, evidence: samples.filter((s) => backdrop.some((b) => b.sceneId === s.sceneId)).map((s) => s.path) });
      }
      {
        const minPx = L.minFontFraction * Math.min(W, H);
        const u = unit(W, H);
        const sizes: [string, number][] = [];
        const assets = new Map(resolution.assets.map((a) => [a.assetId, a]));
        for (const s of manifest.scenes) {
          const comp = request.scenes.find((x) => x.sceneId === s.sceneId)!.component as ComponentId;
          const hasMedia = s.assetIds.some((id) => assets.get(id)?.status === "resolved" && assets.get(id)?.file);
          const kind = comp === "Hook" ? "hook" : comp === "ScreenCapture" || comp === "CodeDemo" || (comp === "Diagram" && hasMedia) ? "body" : "headline";
          sizes.push([`${s.sceneId} primary`, comp === "Outro" ? u * FONT_UNITS.outroLine : headlineSize(s.text.primary, W, H, kind)]);
          if (s.text.secondary) sizes.push([`${s.sceneId} source label`, u * FONT_UNITS.sourceLabel]);
          if (comp === "Title" || comp === "Comparison" || comp === "Summary") sizes.push([`${s.sceneId} label`, u * FONT_UNITS.label]);
          if (comp === "CodeDemo") sizes.push([`${s.sceneId} code`, u * FONT_UNITS.code]);
        }
        if (resolution.assets.some((a) => a.provenance?.attributionRequired && a.attribution)) sizes.push(["asset attribution", u * FONT_UNITS.attribution]);
        if (burnIn && canon.cues.length) sizes.push(["captions", u * FONT_UNITS.caption]);
        const small = sizes.filter(([, px]) => px < minPx);
        const min = sizes.reduce((m, x) => (x[1] < m[1] ? x : m), sizes[0]!);
        add({ id: "visual.font-size", category: "visual", title: "Every text element is at least the minimum font size (from the layout)", required: true, method: "objective", ...verdict(small.map(([n, px]) => `${n} ${px.toFixed(1)} px < ${minPx.toFixed(1)} px`), `smallest: ${min[0]} ${min[1].toFixed(1)} px (minimum ${minPx.toFixed(1)} px)`) });
      }
      {
        const p = sceneTimelineProblems(request.scenes, manifest.scenes, narration.timing.scenes, N);
        if (visualInspectable) for (const s of request.scenes) if (!samples.some((x) => x.sceneId === s.sceneId && x.purpose === "scene-mid")) p.push(`${s.sceneId} has no sampled frame`);
        add({ id: "content.scenes", category: "content", title: "Rendered scenes follow the approved manifest order and timeline, and every scene was sampled", required: true, method: "objective", ...verdict(p, `${request.scenes.length} scenes in manifest order, contiguous, ${N} frames (${narrated ? "narration" : "estimated"} timeline)`) });
      }

      // ---------------------------------------------------------------- content and provenance
      {
        const { problems: p, notes } = planProblems({ jobId: ctx.jobId, approved: ctx.plan, itemHash: fingerprint(ctx.item), report, script, manifest });
        add({ id: "content.plan", category: "content", title: "Output belongs to this job and its approved plan item (not stale)", required: true, method: "objective", ...verdict(p, `${ctx.jobId}, approved plan ${ctx.plan.weekId} v${ctx.plan.version} ${ctx.plan.contentHash.slice(0, 19)}…, item hash matches${notes.length ? `; ${notes.join("; ")}` : ""}`) });
      }
      {
        const issues = validateScriptAgainstEvidence(script, evV.value);
        const errs = issues.filter((i) => i.severity === "error");
        const warns = issues.filter((i) => i.severity === "warning");
        add({ id: "content.claims", category: "content", title: "Every factual script claim traces to the verified evidence (existing script validator)", required: true, method: "objective", ...verdict(errs.map((e) => `${e.code} ${e.segmentId ?? ""}: ${e.message}`), `${script.segments.reduce((n, s) => n + s.claimRefs.length, 0)} claim references validated against research/evidence.json${warns.length ? `; ${warns.length} warning(s) for review` : ""}`) });
        if (warns.length) reviewItems.push({ id: "review.script-warnings", topic: "facts", question: `Check these script warnings: ${warns.slice(0, 6).map((w) => `${w.code} (${w.segmentId ?? "script"})`).join(", ")}`, evidence: ["script/script.json"] });
      }
      {
        const p = attributionProblems(manifest, script.attributions, resolution, request.scenes.map((s) => s.sceneId));
        add({ id: "content.attribution", category: "content", title: "Required source and asset attributions are present in the rendered scenes", required: true, method: "objective", ...verdict(p, `${manifest.attributions.filter((x) => x.required).length} source attribution(s) and ${resolution.assets.filter((a) => a.provenance?.attributionRequired).length} asset attribution(s) present in the scene text drawn by the renderer`) });
        reviewItems.push({ id: "review.attribution-visible", topic: "attribution", question: "Are the source labels and asset attributions legible in the frames where they appear?", evidence: samples.filter((s) => manifest.scenes.find((m) => m.sceneId === s.sceneId)?.text.secondary).map((s) => s.path).slice(0, 12) });
      }
      {
        const p: string[] = [];
        const reg = await loadRegistry(ctx.workspaceDir);
        const projectDir = projectDirOf(ctx.workspaceDir, ctx.config);
        for (const a of resolution.assets) {
          if (a.status !== "resolved" || !a.file) continue;
          const root = a.file.root === "assets" ? resolveWithin(ctx.workspaceDir, "assets") : projectDir;
          const now = await sha256File(resolveWithin(root, a.file.path)).catch(() => undefined);
          if (!now) p.push(`${a.assetId}: ${a.file.path} is missing`);
          else if (now.sha256 !== a.file.sha256) p.push(`${a.assetId}: ${a.file.path} changed after it was resolved`);
          if (a.file.root === "assets") {
            const b = reg.bindings.find((x) => x.jobId === ctx.jobId && x.assetId === a.assetId);
            if (!b) p.push(`${a.assetId} is no longer registered for this job`);
            else if (b.sha256 !== a.file.sha256 || (a.file.registryId && b.registryId !== a.file.registryId)) p.push(`${a.assetId}: the registry now points to different content`);
          }
        }
        if (reg.problem) p.push(`asset registry: ${reg.problem}`);
        add({ id: "content.assets-current", category: "content", title: "Every asset used is still registered, unchanged and current", required: true, method: "objective", ...verdict(p, `${resolution.assets.filter((a) => a.status === "resolved").length} resolved asset(s) re-hashed: unchanged and still bound to this job`) });
      }
      if (narrated) {
        const p = narrationTextProblems(script.segments, narration, sc.file.sha256);
        add({ id: "content.narration-text", category: "content", title: "Narrated text equals the approved script (no added or missing words)", required: true, method: "objective", ...verdict(p, `${narration.segments.length} segments narrated verbatim from script.json${narration.pronunciations.length ? ` (${narration.pronunciations.length} glossary respelling(s) sent to the engine only)` : ""}`) });
      } else add({ id: "content.narration-text", category: "content", title: "Narrated text equals the script", required: true, method: "objective", status: "NOT_APPLICABLE", detail: "silent video" });
      {
        const p: string[] = [];
        const loc = locV.value;
        if (loc.script.sha256 !== sc.file.sha256) p.push("localization was made from another script");
        for (const v of loc.variants) {
          if (v.review === "reviewed-claimed-by-importer" && !v.reviewer) p.push(`${v.language} is marked reviewed without a reviewer`);
          if (v.provider === "canonical" && v.review !== "not-applicable") p.push(`canonical ${v.language} has review status ${v.review}`);
        }
        const unreviewed = loc.variants.filter((v) => v.review === "unreviewed").map((v) => v.language);
        const others = loc.variants.filter((v) => v.language !== manifest.narration.language).map((v) => v.language);
        add({ id: "content.localization", category: "content", title: "Translation review status is reported honestly; only the canonical language is rendered", required: true, method: "objective", ...verdict(p, `rendered language ${manifest.narration.language}${others.length ? `; ${others.join(", ")} exist only as subtitle tracks (not rendered, not narrated)` : ""}${unreviewed.length ? `; unreviewed: ${unreviewed.join(", ")}` : ""}`) });
        if (unreviewed.length) reviewItems.push({ id: "review.translations", topic: "translation", question: `Translations ${unreviewed.join(", ")} are unreviewed. Have a fluent reviewer check them before publishing subtitles in those languages.`, evidence: [LOCALIZE_OUTPUTS.variants] });
      }
      {
        const p: string[] = [];
        for (const a of resolution.assets) {
          const r = report.assets.find((x) => x.assetId === a.assetId);
          if (a.provenance && r && (r.origin !== a.provenance.origin || r.verification !== a.provenance.verification)) p.push(`${a.assetId}: report provenance differs from the asset resolution`);
          if (a.provenance && a.provenance.verification !== "unverified" && a.provenance.verification !== "user-attested") p.push(`${a.assetId}: provenance verification "${a.provenance.verification}" is not a supported state`);
          if (a.status === "resolved" && a.file?.root === "assets") reviewItems.push({ id: `review.asset-${a.assetId}`, topic: "media", question: `Is ${a.assetId} (${a.kind}, licence ${a.license ?? "unknown"}, origin ${a.provenance?.origin ?? "unknown"}, ${a.provenance?.verification ?? "unverified"}) relevant, authentic and licensed for this use? Presence in the frame does not prove any of this.`, evidence: samples.filter((s) => manifest.scenes.find((m) => m.sceneId === s.sceneId)?.assetIds.includes(a.assetId)).map((s) => s.path) });
        }
        for (const f of resolution.fonts) if (f.license === "unknown") reviewItems.push({ id: `review.font-${f.slot}`, topic: "licence", question: `Font ${f.family} (${f.slot}) has no recorded licence.`, evidence: [] });
        add({ id: "provenance.claims", category: "provenance", title: "Provenance and licences are reported as user claims, unchanged from registration", required: true, method: "objective", ...verdict(p, `${resolution.assets.filter((a) => a.provenance).length} registered asset(s); licences and origins remain unverified user claims`) });
      }

      // ---------------------------------------------------------------- human review items (always)
      reviewItems.unshift(
        { id: "review.facts", topic: "facts", question: "Are the statements accurate, current and fairly attributed? Automated checks only prove each claim's text comes from the recorded evidence, not that the sources are true.", evidence: ["script/script.json", "research/evidence.json"] },
        { id: "review.visual", topic: "visual", question: "Do the sampled frames look right: legible, no overlapping or clipped text, on-brand, nothing misleading? Pixel checks cannot detect every collision.", evidence: samples.map((s) => s.path) },
        { id: "review.platform-ui", topic: "layout", question: "Are captions and text clear of the target platform's UI overlays (buttons, titles)? Platform overlays are not modelled.", evidence: samples.filter((s) => s.activeCueId).map((s) => s.path).slice(0, 6) },
      );
      if (narrated) reviewItems.push({ id: "review.voice", topic: "audio", question: `Listen to the narration (${narration.provider?.voice.name}): pronunciation, pacing, naturalness. Voice licence notes: ${narration.provider?.license.notes.join(" ") ?? "none"}`, evidence: [RENDER_OUTPUTS.video] });
      for (const ch of checks.filter((x) => x.status === "NEEDS_REVIEW")) reviewItems.push({ id: `review.check-${ch.id}`, topic: ch.category, question: `${ch.title}: ${ch.detail}`, evidence: ch.evidence ?? [] });

      // ---------------------------------------------------------------- verdict, report, review manifest
      const { status, reasons } = technicalVerdict(checks);
      const failed = checks.filter((x) => x.required && x.status === "FAIL");
      const missing = checks.filter((x) => x.required && (x.status === "BLOCKED" || x.status === "NOT_INSPECTED"));
      const reviewRequired = ctx.profile.approval.requireFinalReview;
      const blockers = [...(status !== "passed" ? [`technical QA ${status}`] : []), ...(reviewRequired ? ["human review pending (creatorflow review approve)"] : [])];
      const summary = Object.fromEntries(["PASS", "FAIL", "BLOCKED", "NOT_INSPECTED", "NEEDS_REVIEW", "NOT_APPLICABLE"].map((k) => [k, checks.filter((x) => x.status === k).length])) as QaReport["summary"];

      // Frames become review artifacts only now: replace the previous set atomically (rename).
      const framesDir = ctx.outputPath(QA_FRAMES_DIR);
      if (samples.length) {
        await fs.rm(framesDir, { recursive: true, force: true, maxRetries: 3 });
        await fs.rename(staging, framesDir);
      } else await fs.rm(staging, { recursive: true, force: true });
      if (ctx.signal.aborted) throw ctx.signal.reason;

      const qaReport: QaReport = {
        schemaVersion: 1,
        kind: "qa-report",
        qaVersion: QA_VERSION,
        jobId: ctx.jobId,
        contentId: ctx.item.contentId,
        plan: { weekId: ctx.plan.weekId, version: ctx.plan.version, contentHash: ctx.plan.contentHash },
        render: { reportPath: RENDER_OUTPUTS.report, reportSha256: rr.file.sha256, outputPath: RENDER_OUTPUTS.video, outputSha256: video.sha256, outputBytes: video.bytes },
        inspectedAt: now().toISOString(),
        tools,
        media: {
          container: mi.container,
          video: mi.video ? { codec: mi.video.codec, width: mi.video.width, height: mi.video.height, fps: mi.video.fps, frames: mi.video.frames ?? null, durationSec: mi.video.durationSec, ...(mi.video.pixelFormat ? { pixelFormat: mi.video.pixelFormat } : {}) } : null,
          decodedFrames: decode?.frames ?? null,
          audioStreams,
          audio: audioMeta ?? (mi.audio ? { codec: mi.audio.codec, sampleRate: mi.audio.sampleRate ?? null, channels: mi.audio.channels ?? null, durationSec: mi.audio.durationSec ?? null, decodedDurationSec: null, peakDbfs: null, rmsDbfs: null, clippedSamples: null } : null),
        },
        frames: { dir: QA_FRAMES_DIR, samples },
        captions: { track: refs.subtitles?.path ?? SCRIPT_OUTPUTS.captions, timing: canon.timing, cues: canon.cues.length, burnedIn: burnIn },
        checks,
        summary,
        reviewItems,
        technicalQa: { status, reasons },
        humanReview: { required: reviewRequired, status: reviewRequired ? "pending" : "not-required" },
        deliveryReadiness: { status: blockers.length ? "blocked" : "ready-for-packaging", blockers },
        limitations: [
          "Pixel checks are heuristics: they find blank frames, text in the margins, missing captions and absent media colours, not every overlap, typo or rendering artefact.",
          "Media visibility uses colour signatures; it cannot tell whether footage is relevant, authentic or correctly licensed.",
          "Claim checks prove that script text comes from the recorded evidence, not that the sources are true or current.",
          "Caption timing is at most sentence-aligned; no word-level alignment exists.",
          "Integrated loudness (LUFS) is not measured.",
          "Platform UI overlays are not modelled.",
        ],
        performance: { totalMs: Date.now() - t0, decodeMs: decode?.ms ?? 0, framesMs, nodeRssPeakMb: Math.round((rssPeak / 1048576) * 10) / 10 },
      };
      const v = validateArtifact(QaReportSchema, qaReport);
      if (!v.ok) throw new StepError(`QA report invalid: ${v.issues[0]?.path}: ${v.issues[0]?.message}`, { kind: "permanent", code: "QA_REPORT_INVALID" });
      const reportBody = stringifyJson(v.value);
      await writeFileAtomic(ctx.outputPath(QA_OUTPUTS.report), reportBody);
      const reportSha = (await sha256File(ctx.outputPath(QA_OUTPUTS.report))).sha256;
      const manifestOut: ReviewManifest = {
        schemaVersion: 1,
        kind: "qa-review-manifest",
        jobId: ctx.jobId,
        qaReport: { path: QA_OUTPUTS.report, sha256: reportSha },
        video: { path: RENDER_OUTPUTS.video, sha256: video.sha256 },
        technicalQa: status,
        frames: samples.map((s) => ({ path: s.path, sha256: s.sha256, frame: s.frame, timeSec: s.timeSec, sceneId: s.sceneId, purpose: s.purpose, sceneText: manifest.scenes.find((m) => m.sceneId === s.sceneId)?.text.primary ?? "", captionLines: canon.cues.find((q) => q.cueId === s.activeCueId)?.lines ?? [] })),
        scenes: request.scenes.map((s) => {
          const m = manifest.scenes.find((x) => x.sceneId === s.sceneId)!;
          return { sceneId: s.sceneId, type: s.type, startSec: Math.round((s.startFrame / fps) * 1000) / 1000, endSec: Math.round(((s.startFrame + s.durationInFrames) / fps) * 1000) / 1000, primary: m.text.primary, ...(m.text.secondary ? { secondary: m.text.secondary } : {}), assets: m.assetIds };
        }),
        items: reviewItems,
        warnings: [...report.warnings, ...checks.filter((x) => !x.required && x.status !== "PASS" && x.status !== "NOT_APPLICABLE").map((x) => `${x.id}: ${x.detail}`)],
        instructions: `Open the video (${RENDER_OUTPUTS.video}) and the frames listed here, answer every item, then record the decision with: creatorflow review approve --job ${ctx.jobId} --qa-hash ${reportSha.slice(7, 23)} --by "<your name>"  (or review reject --note "...").`,
      };
      const mv = validateArtifact(ReviewManifestSchema, manifestOut);
      if (!mv.ok) throw new StepError(`review manifest invalid: ${mv.issues[0]?.path}: ${mv.issues[0]?.message}`, { kind: "permanent", code: "QA_REPORT_INVALID" });
      await writeFileAtomic(ctx.outputPath(QA_OUTPUTS.reviewManifest), stringifyJson(mv.value));

      if (status === "failed") throw new StepError(`technical QA failed (${failed.length} check(s)): ${reasons.slice(0, 4).join(" | ")}. The render is kept for diagnosis; see qa/report.json`, { kind: "permanent", code: "QA_FAILED" });
      if (status === "blocked") return { status: "blocked", code: missing.some((x) => x.status === "NOT_INSPECTED") ? "QA_TOOLS_UNAVAILABLE" : "QA_BLOCKED", reason: `technical QA could not complete: ${reasons.slice(0, 4).join(" | ")}` };
      return { status: "succeeded", metadata: { technicalQa: status, checks: checks.length, pass: summary.PASS, needsReview: summary.NEEDS_REVIEW, reviewItems: reviewItems.length, frames: samples.length, totalMs: qaReport.performance.totalMs } };
    } finally {
      clearInterval(sampler);
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
      await fs.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  };
}
