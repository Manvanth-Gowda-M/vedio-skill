// SIMULATED voice provider + SIMULATED renderer (tests/fixtures/sim-voice.ts, fake-render-worker.ts).
// The narrate step, timing, captions, asset/clip validation, queue-render, audio muxing checks and
// invalidation run for real; only speech synthesis and the Remotion render are simulated. Video clips
// are REAL files generated locally. Real speech + real Remotion: tests/integration/media-real.test.ts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, sha256File } from "@creatorflow/core";
import { NarrationRecordSchema, RenderReportSchema, RenderRequestSchema, SceneManifestSchema, type CreatorFlowConfig } from "@creatorflow/schemas";
import { assetsRegisterCommand, assetsUpdateCommand } from "../../packages/cli/src/commands/assets.ts";
import { createOutput } from "../../packages/cli/src/output.ts";
import { captureStreams, makeTempDir } from "../helpers.ts";
import { makeClip } from "../fixtures/media.ts";
import { SimulatedVoiceProvider, simControl, type SimControl } from "../fixtures/sim-voice.ts";
import { fakeRenderPipeline, renderProject, RENDER_PROFILE, resumeWith, type FakeControl } from "../render-helpers.ts";
import { readJob, type FixtureProject } from "../workflow-helpers.ts";

const J = (c: string) => `2026-w44-${c}`;
const KEY = "hooks-explained";
const NARRATED = { ...RENDER_PROFILE, voice: { mode: "tts" } };
const ttsConfig = (p: FixtureProject, over: Partial<CreatorFlowConfig> = {}): CreatorFlowConfig => ({ ...p.config, providers: { ...p.config.providers, tts: { ...p.config.providers.tts, id: "simulated" } }, ...over });
const fakeRuns = async (log: string) => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { audio: boolean; videos: number; timing: string });
const jdir = (p: FixtureProject, c = KEY) => p.paths.jobDir(J(c));
const read = async <T>(p: FixtureProject, rel: string, c = KEY) => (await readJsonFile(path.join(jdir(p, c), rel))) as T;

describe("narration with a SIMULATED voice provider and SIMULATED renderer", { timeout: 240_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;
  let sim: SimControl;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-narr-");
    ctl = { mode: "ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "pid") };
    sim = simControl();
  });
  afterEach(() => tmp.cleanup());
  const pipe = (extra: { ffprobe?: null } = {}) => fakeRenderPipeline(ctl, { ...extra, voice: new SimulatedVoiceProvider(sim) });

  it("narrates from the verified script, re-times scenes and captions from measured speech, and verifies the muxed audio", async () => {
    const { p } = await renderProject(tmp.dir, { profile: NARRATED });
    const cfg = ttsConfig(p);
    const r = await resumeWith(p, pipe(), {}, cfg);
    expect(r.jobs[0]!.stepsRun).toEqual(["research", "script", "localize", "narrate", "assets", "queue-render", "render"]);
    const job = await readJob(p.paths, J(KEY));
    expect(job).toMatchObject({ state: "BLOCKED", resumeState: "RENDERED", blocked: { step: "qa" } });
    expect(job.artifacts).toMatchObject({ narration: `jobs/${J(KEY)}/narration/narration.json`, narrationAudio: `jobs/${J(KEY)}/narration/voice.wav` });

    const script = await read<{ segments: { segmentId: string; narration: string }[] }>(p, "script/script.json");
    const n = NarrationRecordSchema.parse(await read(p, "narration/narration.json"));
    expect(n).toMatchObject({ status: "generated", provider: { id: "simulated", voice: { name: "Sim English", language: "en-US" }, offline: true }, timing: { method: "sentence-aligned", fps: 30 }, audio: { format: "wav-pcm-s16le", sampleRate: 16000, channels: 1, clippedSamples: 0 } });
    // Only script text is spoken: the sentences joined per segment are exactly the script narration.
    for (const seg of n.segments) expect(seg.sentences.map((s) => s.text).join(" ")).toBe(script.segments.find((x) => x.segmentId === seg.segmentId)!.narration);
    expect(sim.calls.join(" ")).toBe(script.segments.map((s) => s.narration).join(" "));
    expect(n.audio!.sha256).toBe((await sha256File(path.join(jdir(p), "narration", "voice.wav"))).sha256);
    expect(n.audio!.peakDbfs).toBeCloseTo(-1, 0); // normalised to voice.targetPeakDbfs
    expect(n.audio!.durationMs).toBe(n.timing.durationMs);

    // The render timeline is the narration timeline, not the script estimate.
    const manifest = SceneManifestSchema.parse(await read(p, "script/scene-manifest.json"));
    const req = RenderRequestSchema.parse(await read(p, "render/request.json"));
    expect(req.format.durationInFrames).toBe(n.timing.durationInFrames);
    expect(req.scenes.map((s) => [s.sceneId, s.startFrame, s.durationInFrames])).toEqual(n.timing.scenes.map((s) => [s.sceneId, s.startFrame, s.durationInFrames]));
    expect(req.format.durationInFrames).not.toBe(manifest.durationInFrames);
    expect(req).toMatchObject({ audio: { expected: "narration", file: { path: "narration/voice.wav", sha256: n.audio!.sha256 } }, captionsTiming: "sentence-aligned" });
    expect((await fakeRuns(ctl.log))[0]).toMatchObject({ audio: true, timing: "sentence-aligned" });

    // Captions: same cue ids as the script track, ordered, inside speech/audio, and frame-converted.
    const subs = await read<{ tracks: { language: string; timing: string; cues: { cueId: string; startMs: number; endMs: number; segmentId: string }[] }[] }>(p, "narration/subtitles.json");
    const est = await read<{ tracks: { cues: { cueId: string }[] }[] }>(p, "script/captions.json");
    const track = subs.tracks[0]!;
    expect(subs.tracks.map((t) => t.language)).toEqual(["en"]);
    expect(track.cues.map((c) => c.cueId)).toEqual(est.tracks[0]!.cues.map((c) => c.cueId));
    const sentences = n.segments.flatMap((s) => s.sentences);
    for (const [i, c] of track.cues.entries()) {
      expect(c.endMs).toBeGreaterThan(c.startMs);
      if (i) expect(c.startMs).toBeGreaterThanOrEqual(track.cues[i - 1]!.endMs);
      expect(c.endMs).toBeLessThanOrEqual(n.timing.durationMs);
      // every cue starts inside a measured sentence window of its own segment
      const seg = n.segments.find((s) => s.segmentId === c.segmentId)!;
      expect(seg.sentences.some((s) => c.startMs >= s.speechStartMs - 1 && c.startMs < s.speechEndMs)).toBe(true);
    }
    expect(sentences[0]!.speechStartMs).toBe(track.cues[0]!.startMs);

    const report = RenderReportSchema.parse(await read(p, "render/report.json"));
    expect(report).toMatchObject({ technicalQa: "pending", captions: { timing: "sentence-aligned", validation: { ok: true } }, audio: { present: true, expected: "narration", verified: true }, narration: { requested: "tts", generated: true, provider: { id: "simulated", voice: "Sim English" } } });
    expect(report.audio.checks!.map((c) => [c.check, c.ok])).toEqual([["one-audio-stream", true], ["codec", true], ["duration-matches-video", true], ["speech-present", true]]);
    expect(report.mediaInspection.audio).toMatchObject({ codec: "aac" });
  });

  it("a narrated render whose audio is missing or silent is never accepted; the previous video is kept", async () => {
    const { p } = await renderProject(tmp.dir, { profile: NARRATED });
    const cfg = ttsConfig(p);
    await resumeWith(p, pipe(), {}, cfg);
    const video = path.join(jdir(p), "render", "output.mp4");
    const good = (await sha256File(video)).sha256;
    for (const mode of ["drop-audio", "silent-audio"]) {
      ctl.mode = mode;
      await resumeWith(p, pipe(), { forceSteps: new Set(["render"]), retryFailed: true }, cfg);
      const job = await readJob(p.paths, J(KEY));
      expect(job.failure).toMatchObject({ step: "render", kind: "permanent", code: "RENDER_AUDIO_MISMATCH" });
      expect(job.failure!.message).toContain(mode === "drop-audio" ? "one-audio-stream: 0 audio stream(s)" : "speech-present: 0/");
      expect((await sha256File(video)).sha256).toBe(good);
    }
  });

  it("silent jobs stay silent: an unexpected audio track fails verification", async () => {
    const { p } = await renderProject(tmp.dir);
    await resumeWith(p, pipe());
    const n = NarrationRecordSchema.parse(await read(p, "narration/narration.json"));
    expect(n).toMatchObject({ status: "silent", requested: { mode: "none", provider: null }, timing: { method: "estimated" } });
    await expect(fs.stat(path.join(jdir(p), "narration", "voice.wav"))).rejects.toThrow();
    const report = RenderReportSchema.parse(await read(p, "render/report.json"));
    expect(report).toMatchObject({ audio: { present: false, expected: "none", verified: true }, captions: { timing: "estimated" }, narration: { generated: false } });
    expect(sim.calls).toEqual([]);
    ctl.mode = "add-audio";
    await resumeWith(p, pipe(), { forceSteps: new Set(["render"]) });
    expect((await readJob(p.paths, J(KEY))).failure).toMatchObject({ code: "RENDER_AUDIO_MISMATCH", message: expect.stringContaining("no-audio-stream") });
  });

  it("provider problems block or fail honestly: unavailable, unknown voice, silence, garbage, crash", async () => {
    const { p } = await renderProject(tmp.dir, { profile: NARRATED });
    const cfg = ttsConfig(p);
    sim.mode = "unavailable";
    await resumeWith(p, pipe(), {}, cfg);
    expect((await readJob(p.paths, J(KEY))).blocked).toMatchObject({ step: "narrate", code: "VOICE_PROVIDER_UNAVAILABLE", reason: "simulated provider: model file missing" });
    expect(await fakeRuns(ctl.log)).toEqual([]);

    sim.mode = "ok";
    const prof = { ...p.profile, voice: { ...p.profile.voice, voiceId: "Nonexistent Voice" } };
    await resumeWith({ ...p, profile: prof }, pipe(), {}, cfg);
    expect((await readJob(p.paths, J(KEY))).blocked).toMatchObject({ step: "narrate", code: "VOICE_NOT_FOUND" });
    const fast = { ...p.profile, voice: { ...p.profile.voice, speakingRate: 2.5 } };
    await resumeWith({ ...p, profile: fast }, pipe(), {}, cfg);
    expect((await readJob(p.paths, J(KEY))).blocked).toMatchObject({ step: "narrate", code: "VOICE_OPTION_UNSUPPORTED" });

    sim.mode = "silent";
    await resumeWith(p, pipe(), {}, cfg);
    expect((await readJob(p.paths, J(KEY))).failure).toMatchObject({ step: "narrate", kind: "permanent", code: "VOICE_OUTPUT_SILENT" });
    // Silent output was not cached: the next attempt really synthesises again.
    const before = sim.calls.length;
    sim.mode = "garbage";
    await resumeWith(p, pipe(), { retryFailed: true }, cfg);
    expect(sim.calls.length).toBeGreaterThan(before);
    const g = await readJob(p.paths, J(KEY));
    expect(g.failure).toMatchObject({ step: "narrate", kind: "retries-exhausted", code: "VOICE_OUTPUT_INVALID" });
    expect(g.steps["narrate"]!.attempts.slice(-3).map((a) => a.outcome)).toEqual(["failed-retryable", "failed-retryable", "failed-retryable"]);
    sim.mode = "fail";
    await resumeWith(p, pipe(), { retryFailed: true }, cfg);
    expect((await readJob(p.paths, J(KEY))).failure).toMatchObject({ code: "VOICE_SYNTHESIS_FAILED" });
    expect(await fakeRuns(ctl.log)).toEqual([]);
    sim.mode = "ok";
    const ok = await resumeWith(p, pipe(), { retryFailed: true }, cfg);
    expect(ok.jobs[0]!.stepsRun).toEqual(["narrate", "assets", "queue-render", "render"]);
    // Synthesis temp dirs of this process are removed.
    const { tmpdir } = await import("node:os");
    expect((await fs.readdir(tmpdir())).filter((x) => x.startsWith(`cf-voice-${process.pid}-`))).toEqual([]);
  });

  it("granular invalidation: voice settings, engine version, caption style and audio tampering rerun only what depends on them", async () => {
    const { p, plan, approve } = await renderProject(tmp.dir, { profile: NARRATED, keep: ["hooks-explained", "subagents-release"] });
    const cfg = ttsConfig(p);
    await resumeWith(p, pipe(), {}, cfg);
    const calls0 = sim.calls.length;
    const runs = (r: Awaited<ReturnType<typeof resumeWith>>) => Object.fromEntries(r.jobs.map((j) => [j.contentId, j.stepsRun]));

    // Unchanged: everything reused, nothing synthesised.
    let r = await resumeWith(p, pipe(), {}, cfg);
    expect(runs(r)).toEqual({ "hooks-explained": [], "subagents-release": [] });

    // Speaking rate: Stage E already uses it for the script's timing estimates and records it in the
    // scene manifest, so the deterministic script step re-runs too; research is never redone.
    const prof = { ...p.profile, voice: { ...p.profile.voice, speakingRate: 1.2 } };
    r = await resumeWith({ ...p, profile: prof }, pipe(), {}, cfg);
    expect(runs(r)[KEY]).toEqual(["script", "localize", "narrate", "assets", "queue-render", "render"]);
    expect(r.jobs.find((j) => j.contentId === KEY)!.stepsReused).toContain("research");
    expect(sim.calls.length).toBeGreaterThan(calls0);

    // Engine/model version change: only narration and what depends on it.
    sim.version = "2.0";
    r = await resumeWith({ ...p, profile: prof }, pipe(), {}, cfg);
    expect(runs(r)[KEY]).toEqual(["narrate", "assets", "queue-render", "render"]);
    expect((await readJob(p.paths, J(KEY))).history.some((h) => h.type === "invalidated" && h.step === "narrate" && h.reason === "step inputs changed")).toBe(true);

    // Caption styling: re-render (assets re-checks font coverage, as in Stage F); no narration, no synthesis.
    const before = sim.calls.length;
    const off = { ...cfg, render: { ...cfg.render, captions: "off" as const } };
    r = await resumeWith({ ...p, profile: prof }, pipe(), {}, off);
    expect(runs(r)[KEY]).toEqual(["assets", "queue-render", "render"]);
    expect(sim.calls.length).toBe(before);

    // Tampered audio: narrate re-runs from its sentence cache (no new synthesis) and reproduces the same file.
    await fs.appendFile(path.join(jdir(p), "narration", "voice.wav"), "x");
    r = await resumeWith({ ...p, profile: prof }, pipe(), {}, off);
    expect(runs(r)[KEY]).toEqual(["narrate"]);
    expect(r.jobs.find((j) => j.contentId === KEY)!.stepsReused).toEqual(expect.arrayContaining(["assets", "queue-render", "render"]));
    expect(sim.calls.length).toBe(before);
    expect((await readJob(p.paths, J(KEY))).steps["narrate"]!.metadata).toMatchObject({ synthesized: 0 });

    // A script change for one item renarrates only that item.
    await approve(plan((c) => (c.items.find((i) => i.contentId === KEY)!.hook = "A different opening line, spoken.")));
    r = await resumeWith({ ...p, profile: prof }, pipe(), {}, off);
    expect(runs(r)).toEqual({ "hooks-explained": ["script", "localize", "narrate", "assets", "queue-render", "render"], "subagents-release": [] });
    expect(sim.calls.at(-1)).not.toBeUndefined();
  });
});

describe("video clips in scenes (REAL clip files, SIMULATED renderer)", { timeout: 240_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-clip-");
    ctl = { mode: "ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "pid") };
  });
  afterEach(() => tmp.cleanup());

  it("a screen-capture scene blocks until a validated video fills its slot; trims are validated; only that job re-renders", async () => {
    const { p } = await renderProject(tmp.dir, { keep: ["hooks-tutorial", "hooks-explained"] });
    const pipe = fakeRenderPipeline(ctl);
    await resumeWith(p, pipe);
    const tj = J("hooks-tutorial");
    const blocked = await readJob(p.paths, tj);
    expect(blocked.blocked).toMatchObject({ step: "assets", code: "ASSETS_MISSING" });
    const slot = /ast-scn-\d{2}-screen-recording/.exec(blocked.blocked!.reason)![0];
    const explainedRuns = (await readJob(p.paths, J(KEY))).steps["render"]!.attempts.length;

    await fs.mkdir(path.join(p.ws, "assets", "captures"), { recursive: true });
    const file = path.join(p.ws, "assets", "captures", "terminal.mp4");
    await makeClip(file, { width: 640, height: 360, fps: 30, frames: 90, withAudio: true });
    const cap = captureStreams();
    const o = createOutput(true, cap.streams);
    // Trim beyond the end of the 3 s clip is refused at registration.
    await expect(assetsRegisterCommand(o, p.dir, { file, type: "screen-recording", job: tj, slot, start: "1", end: "5", origin: "user-created" })).rejects.toMatchObject({ code: "CLIP_INVALID" });
    expect(await assetsRegisterCommand(o, p.dir, { file, type: "screen-recording", job: tj, slot, start: "0.5", end: "2.5", fit: "contain", origin: "user-created", license: "own work", attest: true })).toBe(0);

    const r = await resumeWith(p, pipe);
    const by = Object.fromEntries(r.jobs.map((j) => [j.contentId, j]));
    expect(by["hooks-tutorial"]!.stepsRun).toEqual(["assets", "queue-render", "render"]);
    expect(by["hooks-explained"]!.stepsRun).toEqual([]); // unrelated registration: no re-render
    expect((await readJob(p.paths, J(KEY))).steps["render"]!.attempts).toHaveLength(explainedRuns);
    const req = RenderRequestSchema.parse(await read(p, "render/request.json", "hooks-tutorial"));
    expect(req.clips).toHaveLength(1);
    expect(req.clips![0]).toMatchObject({ assetId: slot, startSec: 0.5, endSec: 2.5, fit: "contain", sourceAudio: "muted" });
    expect(req.scenes.find((s) => s.type === "screen-capture")).toMatchObject({ component: "ScreenCapture", fallback: "none" });
    const report = RenderReportSchema.parse(await read(p, "render/report.json", "hooks-tutorial"));
    expect(report.videoClips![0]).toMatchObject({ assetId: slot, startSec: 0.5 });
    expect(report.assets.find((a) => a.assetId === slot)).toMatchObject({ status: "resolved", license: "own work", origin: "user-created", verification: "user-attested" });
    expect((await fakeRuns(ctl.log)).at(-1)).toMatchObject({ videos: 1 });

    // Changing the trim re-renders the job (assets onward), without touching research or script.
    expect(await assetsUpdateCommand(o, p.dir, { id: "ast-terminal", use: `${tj}:${slot}`, start: "1", end: "2" })).toBe(0);
    const r2 = await resumeWith(p, pipe);
    expect(Object.fromEntries(r2.jobs.map((j) => [j.contentId, j.stepsRun]))).toEqual({ "hooks-tutorial": ["assets", "queue-render", "render"], "hooks-explained": [] });
    expect(RenderRequestSchema.parse(await read(p, "render/request.json", "hooks-tutorial")).clips![0]).toMatchObject({ startSec: 1, endSec: 2 });

    // Replacing the file with corrupt bytes blocks the job; nothing else is affected.
    await fs.writeFile(file, (await fs.readFile(file)).subarray(0, 4000));
    await resumeWith(p, pipe);
    expect((await readJob(p.paths, tj)).blocked).toMatchObject({ step: "assets", code: "ASSET_INVALID", reason: expect.stringContaining("does not match the registered") });
  });
});
