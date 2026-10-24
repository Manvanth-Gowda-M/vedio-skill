import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive, resolveWithin, runProcess, sha256File, sha256Hex, stringifyJson, writeFileAtomic, type ProcessResult } from "@creatorflow/core";
import { StepError, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import { COMPOSITION_ID } from "@creatorflow/remotion-studio";
import { RenderReportSchema, RenderRequestSchema, validateArtifact, type MediaInspection, type NarrationRecord, type RenderReport, type RenderRequest } from "@creatorflow/schemas";
import { checkSubtitleTrack } from "@creatorflow/scriptwriter";
import { parseWav, windowRmsDbfs } from "@creatorflow/voice";
import { chooseBrowser, findFfmpeg, findFfprobe, remotionVersion, type FfprobeChoice } from "./environment.ts";
import { fontRootDir } from "./fonts.ts";
import { inspectRender } from "./inspect.ts";
import { extractAudioWav } from "./media.ts";
import { buildRenderProps, loadRenderInputs, mapScenes, REQUEST_OUTPUT } from "./prepare.ts";
import { projectDirOf, readVerifiedOutput } from "./verified.ts";

export const RENDER_OUTPUTS = { video: "render/output.mp4", report: "render/report.json" } as const;

const require = createRequire(import.meta.url);
export const WORKER_PATH = fileURLToPath(new URL("./render-worker.ts", import.meta.url));
export const ENTRY_POINT = path.join(path.dirname(require.resolve("@creatorflow/remotion-studio/package.json")), "src", "index.tsx");

export interface RenderEngineOptions {
  /** Replaces the worker process (unit tests use a fake worker). Receives the job file path. */
  worker?: (jobFile: string, signal: AbortSignal) => Promise<ProcessResult>;
  /** Override ffprobe discovery; `null` = pretend none is available. */
  ffprobe?: { path: string; description: string } | null;
  /** Override ffmpeg discovery (audio verification); `null` = none available. */
  ffmpeg?: { path: string; description: string } | null;
  now?: () => Date;
}

export const renderStepInputs = (ctx: FingerprintContext): unknown => ({ contentId: ctx.item.contentId });
export const renderStepConfig = (ctx: FingerprintContext): unknown => ({ render: ctx.config.render, maxConcurrentRenders: ctx.config.hardware.maxConcurrentRenders });

const tailText = (s: string, n = 800) => (s.length > n ? `…${s.slice(-n)}` : s).trim();

export const TEMP_PREFIX = "cf-render-";
/** Decoded output audio must be at least this loud inside every narrated sentence window. */
export const SPEECH_FLOOR_DBFS = -45;

/**
 * Removes render temp dirs left by processes that died mid-render. Names are
 * cf-render-<ownerPid>-<random>; a dir is removed only if its owner is gone.
 */
export async function cleanupStaleRenderDirs(root = os.tmpdir()): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const m = /^cf-(?:render|voice|sapi|qa)-(\d+)-/.exec(name);
    if (!m || Number(m[1]) === process.pid || isProcessAlive(Number(m[1]))) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true, maxRetries: 3 }).then(() => removed.push(name), () => undefined);
  }
  return removed;
}

type Check = { check: string; ok: boolean; detail: string };

/**
 * Verifies the audio of a rendered file against the request: silent jobs must
 * have no audio stream; narrated jobs exactly one AAC stream whose duration
 * matches the video and whose decoded signal carries speech in every
 * narrated sentence window.
 */
export async function verifyRenderedAudio(file: string, request: RenderRequest, inspection: MediaInspection, narration: NarrationRecord | undefined, ffmpeg: FfprobeChoice | undefined, tmp: string, signal?: AbortSignal): Promise<{ verified: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const expected = request.audio?.expected ?? "none";
  if (!inspection.performed) return { verified: false, checks: [{ check: "streams-inspected", ok: false, detail: inspection.reason ?? "media streams were not inspected" }] };
  if (expected === "none") {
    checks.push({ check: "no-audio-stream", ok: (inspection.audioStreams ?? 0) === 0, detail: `${inspection.audioStreams ?? 0} audio stream(s)` });
    return { verified: checks.every((c) => c.ok), checks };
  }
  checks.push({ check: "one-audio-stream", ok: inspection.audioStreams === 1, detail: `${inspection.audioStreams ?? 0} audio stream(s)` });
  const a = inspection.audio;
  checks.push({ check: "codec", ok: a?.codec === "aac", detail: `${a?.codec ?? "none"}${a?.sampleRate ? ` ${a.sampleRate} Hz` : ""}${a?.channels ? ` ${a.channels} ch` : ""}` });
  const videoSec = request.format.durationInFrames / request.format.fps;
  const tol = Math.max(0.1, 3 / request.format.fps);
  const audioSec = a?.durationSec;
  checks.push({ check: "duration-matches-video", ok: audioSec !== undefined && Math.abs(audioSec - videoSec) <= tol, detail: `audio ${audioSec?.toFixed(3) ?? "?"} s vs video ${videoSec.toFixed(3)} s (tolerance ${tol.toFixed(3)} s)` });
  if (!ffmpeg) {
    checks.push({ check: "speech-present", ok: false, detail: "no ffmpeg available to decode the rendered audio" });
    return { verified: false, checks };
  }
  if (inspection.audioStreams && inspection.audioStreams > 0) {
    const wav = path.join(tmp, "out-audio.wav");
    const x = await extractAudioWav(ffmpeg, file, wav, signal);
    if (!x.ok) checks.push({ check: "speech-present", ok: false, detail: `could not decode the rendered audio: ${x.message}` });
    else {
      const pcm = parseWav(await fs.readFile(wav));
      const windows = (narration?.segments ?? []).flatMap((s) => s.sentences);
      const quiet = windows.filter((w) => windowRmsDbfs(pcm, w.speechStartMs, w.speechEndMs) < SPEECH_FLOOR_DBFS);
      checks.push({ check: "speech-present", ok: windows.length > 0 && quiet.length === 0, detail: `${windows.length - quiet.length}/${windows.length} narrated sentence windows carry speech (RMS ≥ ${SPEECH_FLOOR_DBFS} dBFS)${quiet.length ? `; silent at ${quiet.slice(0, 3).map((w) => `${w.speechStartMs} ms`).join(", ")}` : ""}` });
      await fs.rm(wav, { force: true });
    }
  }
  return { verified: checks.every((c) => c.ok), checks };
}

export function makeRenderStepExecute(opts: RenderEngineOptions = {}): (ctx: StepContext) => Promise<StepResult> {
  const now = opts.now ?? (() => new Date());
  return async (ctx) => {
    const rq = await readVerifiedOutput(ctx, "queue-render", REQUEST_OUTPUT);
    if (!rq.ok) return { status: "blocked", code: rq.code, reason: rq.reason };
    const rv = validateArtifact(RenderRequestSchema, JSON.parse(rq.file.raw));
    if (!rv.ok) throw new StepError("render/request.json is invalid", { kind: "permanent", code: "RENDER_REQUEST_INVALID" });
    const request = rv.value;
    const loaded = await loadRenderInputs(ctx);
    if (!loaded.ok) return { status: "blocked", code: loaded.code, reason: loaded.reason };
    const inputs = loaded.inputs;
    for (const k of Object.keys(request.inputs) as (keyof typeof request.inputs)[]) {
      if (request.inputs[k]?.sha256 !== inputs.refs[k]?.sha256) return { status: "blocked", code: "RENDER_INPUTS_CHANGED", reason: `${request.inputs[k]?.path ?? k} changed after the render was queued; run resume to re-queue` };
    }
    const narrated = request.audio?.expected === "narration";
    if (narrated && (!inputs.audio || inputs.audio.sha256 !== request.audio?.file?.sha256)) return { status: "blocked", code: "NARRATION_AUDIO_CHANGED", reason: "the narration audio is missing or differs from the queued request; run resume" };
    const map = mapScenes(inputs.manifest, inputs.resolution, inputs.narration?.timing);
    if (!map.ok) return { status: "blocked", code: "UNSUPPORTED_SCENE_TYPE", reason: map.problems.join("; ") };
    const browser = await chooseBrowser(ctx.config);
    if (!browser.ok) return { status: "blocked", code: "BROWSER_UNAVAILABLE", reason: browser.message };
    const ffprobe = opts.ffprobe === undefined ? await findFfprobe(ctx.config) : (opts.ffprobe ?? undefined);
    const ffmpeg = opts.ffmpeg === undefined ? await findFfmpeg(ctx.config) : (opts.ffmpeg ?? undefined);
    if (narrated && (!ffprobe || !ffmpeg)) return { status: "blocked", code: "MEDIA_TOOLS_UNAVAILABLE", reason: "a narrated render can only be verified with ffprobe and ffmpeg (Remotion's bundled copies, PATH, or hardware.ffprobePath/ffmpegPath); none was found" };

    const projectDir = projectDirOf(ctx.workspaceDir, ctx.config);
    const rootDir = (root: string, family?: string) => (root === "assets" ? resolveWithin(ctx.workspaceDir, "assets") : root === "project" ? projectDir : fontRootDir("fontsource", family!, projectDir));
    const codeTexts = new Map<string, string>();
    for (const a of inputs.resolution.assets) {
      if (a.status !== "resolved" || a.file?.mediaType !== "text/plain") continue;
      const buf = await fs.readFile(resolveWithin(rootDir(a.file.root), a.file.path));
      if (`sha256:${sha256Hex(buf)}` !== a.file.sha256) return { status: "blocked", code: "ASSET_CHANGED", reason: `${a.assetId} (${a.file.path}) changed after it was resolved; run resume` };
      codeTexts.set(a.assetId, buf.toString("utf8"));
    }
    const { props, files } = buildRenderProps(inputs, request, rootDir, (id) => codeTexts.get(id));

    await cleanupStaleRenderDirs();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
    try {
      // Stage fonts and media into a private public dir; every copy is re-hashed (streamed, never held in memory).
      for (const f of files) {
        const dest = resolveWithin(path.join(tmp, "public"), f.name);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(f.abs, dest);
        if ((await sha256File(dest)).sha256 !== f.sha256) return { status: "blocked", code: "ASSET_CHANGED", reason: `${path.basename(f.abs)} changed after it was resolved; run resume` };
      }
      const propsFile = path.join(tmp, "props.json");
      const out = path.join(tmp, "out.mp4");
      await fs.writeFile(propsFile, stringifyJson(props));
      const jobFile = path.join(tmp, "job.json");
      await fs.writeFile(
        jobFile,
        stringifyJson({
          entryPoint: ENTRY_POINT,
          publicDir: path.join(tmp, "public"),
          bundleDir: path.join(tmp, "bundle"),
          propsFile,
          output: out,
          compositionId: COMPOSITION_ID,
          settings: { crf: request.settings.crf, pixelFormat: request.settings.pixelFormat, concurrency: request.settings.concurrency, chromeMode: browser.chromeMode },
          browserExecutable: browser.executable,
          parentPid: process.pid,
        }),
      );

      const startedAt = now().toISOString();
      const res = opts.worker
        ? await opts.worker(jobFile, ctx.signal)
        : await runProcess(process.execPath, [WORKER_PATH, jobFile], { signal: ctx.signal, cwd: path.dirname(ENTRY_POINT) });
      const completedAt = now().toISOString();
      if (res.errorCode === "ABORTED" || res.errorCode === "TIMEOUT" || ctx.signal.aborted) throw ctx.signal.reason ?? new Error("render aborted");
      const ok = res.exitCode === 0 && /^CF_RESULT \{"ok":true/m.test(res.stdout);
      if (!ok) {
        throw new StepError(`Remotion render failed (exit ${res.exitCode ?? res.errorCode}${res.exitCode === 0 ? ", but no result line" : ""}): ${tailText(res.stderr || res.stdout)}`, { kind: "retryable", code: "RENDER_FAILED" });
      }
      const st = await fs.stat(out).catch(() => undefined);
      if (!st || st.size === 0) throw new StepError("The renderer exited successfully but wrote no video (missing or empty file)", { kind: "retryable", code: "RENDER_OUTPUT_INVALID" });
      const inspection: MediaInspection = await inspectRender(out, request.format, ffprobe);
      if (!inspection.container.ok) throw new StepError(`Rendered file is not a complete MP4: ${inspection.container.problem}`, { kind: "retryable", code: "RENDER_OUTPUT_INVALID" });
      if (inspection.performed && !inspection.matchesRequest) throw new StepError(`Rendered video does not match the request: ${inspection.mismatches.join("; ")}`, { kind: "permanent", code: "RENDER_OUTPUT_MISMATCH" });
      const audioCheck = await verifyRenderedAudio(out, request, inspection, inputs.narration, ffmpeg, tmp, ctx.signal);
      if (inspection.performed && !audioCheck.verified) throw new StepError(`Rendered audio does not match the request: ${audioCheck.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`).join("; ")}`, { kind: "permanent", code: "RENDER_AUDIO_MISMATCH" });

      // Captions actually burned in: valid, ordered and inside the rendered timeline.
      const track = (inputs.subtitles ?? inputs.captions).tracks.find((t) => t.language === inputs.manifest.narration.language) ?? (inputs.subtitles ?? inputs.captions).tracks[0]!;
      const durMs = (request.format.durationInFrames * 1000) / request.format.fps;
      const capProblems = [...checkSubtitleTrack(track), ...track.cues.filter((c) => c.endMs > durMs + 1).map((c) => `${c.cueId} ends after the video`)];

      // Replace the previous output only now, atomically; a failed render never touches it.
      const finalAbs = ctx.outputPath(RENDER_OUTPUTS.video);
      await fs.mkdir(path.dirname(finalAbs), { recursive: true });
      const partial = `${finalAbs}.${process.pid}.partial`;
      await fs.copyFile(out, partial);
      await fs.rename(partial, finalAbs);
      const { sha256, bytes } = await sha256File(finalAbs);

      const warnings = [...request.warnings];
      // Node/Remotion warnings printed by the worker (e.g. MaxListenersExceededWarning) are surfaced, not hidden.
      for (const l of res.stderr.split(/\r?\n/).filter((x) => /\bWarning\b/.test(x)).slice(0, 5)) warnings.push(`renderer process warning: ${l.trim().slice(0, 300)}`);
      if (!inspection.performed) warnings.push(`media streams not inspected: ${inspection.reason}; only the MP4 container structure was checked`);
      if (capProblems.length) warnings.push(`caption issues: ${capProblems.join("; ")}`);
      const n = inputs.narration;
      const report: RenderReport = {
        schemaVersion: 1,
        kind: "render-report",
        jobId: ctx.jobId,
        contentId: request.contentId,
        plan: request.plan,
        sceneManifest: request.inputs.manifest,
        request: { path: REQUEST_OUTPUT, sha256: rq.file.sha256 },
        renderer: { id: "creatorflow-remotion", version: request.renderer.version, remotion: remotionVersion(), browser: browser.description },
        output: { path: RENDER_OUTPUTS.video, sha256, bytes },
        expected: { ...request.format, durationSec: Math.round((request.format.durationInFrames / request.format.fps) * 1000) / 1000 },
        settings: { ...request.settings, chromeMode: browser.chromeMode },
        startedAt,
        completedAt,
        renderDurationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        process: { exitCode: res.exitCode ?? 0 },
        status: "rendered",
        mediaInspection: inspection,
        audio: {
          present: (inspection.audioStreams ?? 0) > 0,
          reason: narrated ? `narration from ${n?.provider?.id ?? "?"} (${n?.provider?.voice.name ?? "?"})` : 'voice.mode is "none": intentionally silent video with burned-in captions',
          expected: narrated ? "narration" : "none",
          verified: audioCheck.verified,
          ...(request.audio?.file ? { source: request.audio.file } : {}),
          checks: audioCheck.checks,
        },
        captions: { burnedIn: request.settings.captions === "burn-in", timing: track.timing, cues: track.cues.length, validation: { ok: capProblems.length === 0, problems: capProblems } },
        narration: {
          requested: n?.requested.mode ?? ctx.profile.voice.mode,
          configuredProvider: n?.requested.provider ?? null,
          generated: n?.status === "generated",
          ...(n?.provider ? { provider: { id: n.provider.id, version: n.provider.version, voice: n.provider.voice.name, language: n.provider.voice.language } } : {}),
          ...(n?.settings ? { settings: { speakingRate: n.settings.speakingRate.applied, sampleRate: n.settings.sampleRate, gainDb: n.settings.gainDb, timing: n.timing.method } } : {}),
          ...(n?.provider ? { licenseNotes: [n.provider.license.engine, n.provider.license.voice, ...n.provider.license.notes] } : {}),
        },
        videoClips: request.clips ?? [],
        assets: inputs.resolution.assets.map((a) => ({
          assetId: a.assetId,
          status: a.status,
          ...(a.file ? { sha256: a.file.sha256 } : {}),
          ...(a.file?.registryId ? { registryId: a.file.registryId } : {}),
          ...(a.license ? { license: a.license } : {}),
          ...(a.provenance ? { origin: a.provenance.origin, verification: a.provenance.verification } : {}),
        })),
        fonts: inputs.resolution.fonts.map((f) => ({ slot: f.slot, family: f.family, coverage: f.coverage })),
        warnings,
        errors: [],
        technicalQa: "pending",
      };
      const v = validateArtifact(RenderReportSchema, report);
      if (!v.ok) throw new StepError(`Render report invalid: ${v.issues[0]?.path}: ${v.issues[0]?.message}`, { kind: "permanent", code: "RENDER_REPORT_INVALID" });
      await writeFileAtomic(ctx.outputPath(RENDER_OUTPUTS.report), stringifyJson(v.value));
      return {
        status: "succeeded",
        metadata: { width: request.format.width, height: request.format.height, fps: request.format.fps, frames: request.format.durationInFrames, bytes, inspected: inspection.performed, audio: narrated ? "narration" : "none", audioVerified: audioCheck.verified, renderMs: report.renderDurationMs },
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
}
