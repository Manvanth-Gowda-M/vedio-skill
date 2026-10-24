// REAL MEDIA: real Remotion render (system Chrome) of a job with a REAL local video clip in its
// screen-capture scene and REAL narration from Windows SAPI (System.Speech), through the production
// pipeline. The clip is generated locally by tests/fixtures/media.ts (coloured bands; no third-party
// footage). Research is FICTIONAL. No network. When SAPI is not available (non-Windows, no voices)
// the narration part is reported as skipped and the clip is rendered silent instead.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonFile, sha256File } from "@creatorflow/core";
import { CreatorFlowConfigSchema, NarrationRecordSchema, QaReportSchema, RenderReportSchema, RenderRequestSchema } from "@creatorflow/schemas";
import { findFfmpeg, extractAudioWav } from "@creatorflow/video-engine";
import { parseWav, windowRmsDbfs, WindowsSapiProvider } from "@creatorflow/voice";
import { buildProductionPipeline } from "../../packages/cli/src/pipeline.ts";
import { assetsRegisterCommand } from "../../packages/cli/src/commands/assets.ts";
import { subtitlesExportCommand } from "../../packages/cli/src/commands/script.ts";
import { createOutput } from "../../packages/cli/src/output.ts";
import { captureStreams, makeTempDir } from "../helpers.ts";
import { frameRgb, makeClip } from "../fixtures/media.ts";
import { patchConfig, renderProject, RENDER_PROFILE, resumeWith, withRealRenderSlot } from "../render-helpers.ts";
import { readJob, type FixtureProject } from "../workflow-helpers.ts";

const sapiReady = process.platform === "win32" && (await new WindowsSapiProvider(CreatorFlowConfigSchema.parse({ schemaVersion: 1 })).health()).ready;
const MODE = sapiReady ? "narrated (REAL Windows SAPI)" : "silent (SAPI unavailable: narration NOT tested here)";
const KEY = "hooks-tutorial";
const J = `2026-w44-${KEY}`;
const pixels = (b: Buffer, pred: (r: number, g: number, bl: number) => boolean) => {
  let n = 0;
  for (let i = 0; i + 2 < b.length; i += 3) if (pred(b[i]!, b[i + 1]!, b[i + 2]!)) n++;
  return n;
};

describe(`REAL render with a video clip, ${MODE}`, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  let dir: string;
  let ms = 0;

  beforeAll(async () => {
    tmp = await makeTempDir("cf-media-real-");
    ({ p } = await renderProject(tmp.dir, { profile: { ...RENDER_PROFILE, voice: { mode: sapiReady ? "tts" : "none" } }, keep: [KEY] }));
    if (sapiReady) await patchConfig(p, (c) => (c.providers = { ...(c.providers ?? {}), tts: { id: "windows-sapi" } }));
    const { requireProject } = await import("../../packages/cli/src/project.ts");
    p = { ...p, config: (await requireProject(p.dir)).config };
    const pipe = buildProductionPipeline();
    await resumeWith(p, pipe);
    const blocked = await readJob(p.paths, J);
    expect(blocked.blocked).toMatchObject({ step: "assets", code: "ASSETS_MISSING" });
    const slot = /ast-scn-\d{2}-screen-recording/.exec(blocked.blocked!.reason)![0];
    const file = path.join(p.ws, "assets", "captures", "demo.mp4");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await makeClip(file, { width: 640, height: 360, fps: 30, frames: 120, withAudio: true });
    const cap = captureStreams();
    expect(await assetsRegisterCommand(createOutput(true, cap.streams), p.dir, { file, type: "screen-recording", job: J, slot, start: "0.5", end: "3.5", fit: "contain", origin: "user-created", license: "test fixture (generated)", attest: true })).toBe(0);
    const t0 = Date.now();
    const r = await withRealRenderSlot(() => resumeWith(p, pipe));
    ms = Date.now() - t0;
    expect(r.jobs[0]!.stepsRun, JSON.stringify(r.jobs[0])).toEqual(["assets", "queue-render", "render", "qa", "review"]);
    dir = p.paths.jobDir(J);
  }, 900_000);
  afterAll(() => tmp.cleanup());

  it("the render report verifies video, clip and audio against the request", async () => {
    const report = RenderReportSchema.parse(await readJsonFile(path.join(dir, "render", "report.json")));
    const request = RenderRequestSchema.parse(await readJsonFile(path.join(dir, "render", "request.json")));
    expect(report.output.sha256).toBe((await sha256File(path.join(dir, "render", "output.mp4"))).sha256);
    expect(report.mediaInspection).toMatchObject({ performed: true, matchesRequest: true, video: { codec: "h264", width: 1080, height: 1920, fps: 30, frames: request.format.durationInFrames } });
    expect(report.videoClips).toHaveLength(1);
    expect(report.videoClips![0]).toMatchObject({ startSec: 0.5, endSec: 3.5, fit: "contain", sourceAudio: "muted" });
    expect(report.technicalQa).toBe("pending");
    const n = NarrationRecordSchema.parse(await readJsonFile(path.join(dir, "narration", "narration.json")));
    if (sapiReady) {
      expect(n).toMatchObject({ status: "generated", provider: { id: "windows-sapi" }, timing: { method: "sentence-aligned" } });
      expect(report.audio).toMatchObject({ present: true, expected: "narration", verified: true });
      expect(report.mediaInspection.audioStreams).toBe(1);
      expect(report.mediaInspection.audio).toMatchObject({ codec: "aac" });
      expect(Math.abs(report.mediaInspection.audio!.durationSec! - report.expected.durationSec)).toBeLessThan(0.1);
      expect(report.captions).toMatchObject({ timing: "sentence-aligned", validation: { ok: true } });
      expect(request.format.durationInFrames).toBe(n.timing.durationInFrames);
      console.log(`[real media] narrated by ${n.provider!.voice.name}: ${n.audio!.durationMs} ms, ${n.segments.flatMap((s) => s.sentences).length} sentences, peak ${n.audio!.peakDbfs} dBFS; video ${report.expected.durationInFrames} frames; output audio ${report.mediaInspection.audio!.codec} ${report.mediaInspection.audio!.sampleRate} Hz ${report.mediaInspection.audio!.channels} ch ${report.mediaInspection.audio!.durationSec} s; render ${ms} ms, ${report.output.bytes} bytes`);
      for (const c of report.audio.checks!) console.log(`[real media]   ${c.check}: ${c.ok ? "ok" : "FAIL"} — ${c.detail}`);
    } else {
      expect(report.audio).toMatchObject({ present: false, expected: "none", verified: true });
      console.log(`[real media] SAPI unavailable: silent clip render only (${ms} ms)`);
    }
  });

  it("decoded frames show the clip only in its scene; decoded audio has speech exactly in the narrated sentence windows", async () => {
    const request = RenderRequestSchema.parse(await readJsonFile(path.join(dir, "render", "request.json")));
    const video = path.join(dir, "render", "output.mp4");
    const sc = request.scenes.find((s) => s.type === "screen-capture")!;
    const hook = request.scenes[0]!;
    const teal = (r: number, g: number, b: number) => Math.abs(r - 42) < 28 && Math.abs(g - 157) < 28 && Math.abs(b - 143) < 28;
    const mid = (s: typeof sc) => (s.startFrame + s.durationInFrames * 0.5) / 30;
    expect(pixels(await frameRgb(video, mid(sc)), teal)).toBeGreaterThan(15);
    expect(pixels(await frameRgb(video, mid(hook)), teal)).toBeLessThan(5);
    if (!sapiReady) return;
    const n = NarrationRecordSchema.parse(await readJsonFile(path.join(dir, "narration", "narration.json")));
    const ffmpeg = (await findFfmpeg(p.config))!;
    const wav = path.join(tmp.dir, "out.wav");
    expect((await extractAudioWav(ffmpeg, video, wav)).ok).toBe(true);
    const pcm = parseWav(await fs.readFile(wav));
    const sentences = n.segments.flatMap((s) => s.sentences);
    const levels = sentences.map((s) => windowRmsDbfs(pcm, s.speechStartMs, s.speechEndMs));
    expect(Math.min(...levels)).toBeGreaterThan(-40);
    // Gaps between sentences (and the lead-in) are much quieter than speech: captions and audio share one timeline.
    const gaps = sentences.slice(1).map((s, i) => [sentences[i]!.speechEndMs + 40, s.speechStartMs - 40] as const).filter(([a, b]) => b - a >= 80);
    expect(gaps.length).toBeGreaterThan(0);
    for (const [a, b] of gaps) expect(windowRmsDbfs(pcm, a, b)).toBeLessThan(Math.min(...levels) - 15);
    expect(windowRmsDbfs(pcm, 0, Math.max(40, sentences[0]!.speechStartMs - 40))).toBeLessThan(-50);
    console.log(`[real media] speech RMS ${Math.min(...levels).toFixed(1)}..${Math.max(...levels).toFixed(1)} dBFS in ${levels.length} sentence windows; ${gaps.length} gaps all ≥15 dB quieter`);
  });

  it(`REAL technical QA of the ${sapiReady ? "narrated" : "silent"} clip render passes; the job then waits for human review`, async () => {
    const qa = QaReportSchema.parse(await readJsonFile(path.join(dir, "qa", "report.json")));
    const notPass = qa.checks.filter((c) => c.required && c.status !== "PASS" && c.status !== "NOT_APPLICABLE");
    expect(notPass, JSON.stringify(notPass, null, 1)).toEqual([]);
    expect(qa.technicalQa.status).toBe("passed");
    const byId = Object.fromEntries(qa.checks.map((c) => [c.id, c]));
    expect(byId["visual.assets"]!.status).toBe("PASS"); // the clip's colours are on screen in the screen-capture scene
    if (sapiReady) {
      for (const id of ["audio.streams", "audio.decode", "audio.speech", "audio.clipping", "audio.dropouts", "captions.coverage", "content.narration-text"]) expect(byId[id]!.status, id).toBe("PASS");
      expect(qa.captions.timing).toBe("sentence-aligned");
      expect(qa.media.audio).toMatchObject({ codec: "aac" });
      expect(qa.reviewItems.some((i) => i.id === "review.voice")).toBe(true);
    }
    expect((await readJob(p.paths, J)).blocked).toMatchObject({ step: "review", code: "NEEDS_HUMAN_REVIEW" });
    console.log(`[real qa ${sapiReady ? "narrated" : "silent"}] ${Object.entries(qa.summary).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}; ${qa.frames.samples.length} frames; decoded ${qa.media.decodedFrames} frames + audio in ${qa.performance.decodeMs} ms; total ${qa.performance.totalMs} ms; RSS peak ${qa.performance.nodeRssPeakMb} MB; audio ${JSON.stringify(qa.media.audio)}`);
    for (const c of qa.checks.filter((x) => x.status !== "PASS" && x.status !== "NOT_APPLICABLE")) console.log(`[real qa]   ${c.status} ${c.id}: ${c.detail.slice(0, 200)}`);
    for (const id of ["audio.speech", "audio.dropouts", "captions.coverage", "visual.assets", "captions.contrast"]) console.log(`[real qa]   ${id}: ${byId[id]!.detail.slice(0, 220)}`);
  });

  it("exports sentence-aligned SRT/VTT whose cues sit inside the narrated speech", async () => {
    const cap = captureStreams();
    const out = path.join(tmp.dir, "subs.vtt");
    expect(await subtitlesExportCommand(createOutput(true, cap.streams), p.dir, { job: J, lang: "en", format: "vtt", out })).toBe(0);
    const res = JSON.parse(cap.stdout) as { timing: string; cues: number };
    const vtt = await fs.readFile(out, "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    if (!sapiReady) return expect(res.timing).toBe("estimated");
    expect(res.timing).toBe("sentence-aligned");
    expect(vtt).toContain("sentence-aligned to the narration audio");
    const n = NarrationRecordSchema.parse(await readJsonFile(path.join(dir, "narration", "narration.json")));
    const first = n.segments[0]!.sentences[0]!;
    const stamp = (ms: number) => `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
    expect(vtt).toContain(`${stamp(first.speechStartMs)} --> `);
  });
});
