// SIMULATED RENDERER: these tests replace Remotion with tests/fixtures/fake-render-worker.ts
// (which writes real H.264 files with Remotion's bundled ffmpeg, or misbehaves on purpose).
// They prove the render STEP's orchestration, verification, recovery and invalidation, not
// that Remotion renders. Real Remotion renders: render-real.test.ts and tests/e2e/render.test.ts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, readJsonFile, sha256File, sha256Hex, writeJsonAtomic } from "@creatorflow/core";
import { AssetResolutionSchema, RenderReportSchema, RenderRequestSchema } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { makePng } from "../fixtures/media.ts";
import { DIAGRAM_CANDIDATE, fakeRenderPipeline, ownRenderTmpDirs, renderProject, RENDER_PROFILE, resumeWith, type FakeControl } from "../render-helpers.ts";
import { readJob } from "../workflow-helpers.ts";

const J = (c: string) => `2026-w44-${c}`;
let KEY = "hooks-explained";
const fakeRuns = async (log: string) => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
const cfRenderTmpDirs = ownRenderTmpDirs;

describe("render step with a SIMULATED renderer", { timeout: 180_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-rsim-");
    ctl = { mode: "ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "grandchild.pid") };
  });
  afterEach(() => tmp.cleanup());

  it("renders, verifies, reports, then reuses; a failed re-render keeps the previous video", async () => {
    const { p } = await renderProject(tmp.dir);
    const pipe = fakeRenderPipeline(ctl);
    const r1 = await resumeWith(p, pipe);
    expect(r1.jobs[0]).toMatchObject({ result: "blocked", stepsRun: ["research", "script", "localize", "narrate", "assets", "queue-render", "render"] });
    const job = await readJob(p.paths, J(KEY));
    expect(job).toMatchObject({ state: "BLOCKED", resumeState: "RENDERED", lastSuccessfulStep: "render", blocked: { step: "qa", code: "EXECUTOR_UNAVAILABLE" } });
    expect(job.artifacts).toMatchObject({ render: `jobs/${J(KEY)}/render/output.mp4`, renderReport: `jobs/${J(KEY)}/render/report.json` });
    const dir = p.paths.jobDir(J(KEY));
    const report = RenderReportSchema.parse(await readJsonFile(path.join(dir, "render", "report.json")));
    const request = RenderRequestSchema.parse(await readJsonFile(path.join(dir, "render", "request.json")));
    expect(report.output.sha256).toBe((await sha256File(path.join(dir, "render", "output.mp4"))).sha256);
    expect(report).toMatchObject({ status: "rendered", technicalQa: "pending", captions: { burnedIn: true, timing: "estimated" }, audio: { present: false }, process: { exitCode: 0 } });
    expect(report.mediaInspection).toMatchObject({ performed: true, matchesRequest: true, video: { codec: "h264", width: 1080, height: 1920, fps: 30, frames: request.format.durationInFrames } });
    expect(report.sceneManifest.sha256).toBe(job.steps["script"]!.outputs.find((o) => o.path === "script/scene-manifest.json")!.sha256);
    expect(report.plan).toEqual(request.plan);
    expect(Date.parse(report.completedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    expect(JSON.stringify(report)).not.toMatch(/C:\\\\Users|\/home\//); // no local user paths in the report except the browser description
    const res = AssetResolutionSchema.parse(await readJsonFile(path.join(dir, "assets", "resolution.json")));
    expect(res.fonts.map((f) => [f.slot, f.family, f.coverage])).toEqual([["heading", "Inter", "verified"], ["body", "Inter", "verified"], ["mono", "JetBrains Mono", "verified"]]);
    expect(await fakeRuns(ctl.log)).toBe(1);

    const r2 = await resumeWith(p, pipe);
    expect(r2.jobs[0]!.stepsReused).toEqual(["research", "script", "localize", "narrate", "assets", "queue-render", "render"]);
    expect(await fakeRuns(ctl.log)).toBe(1);

    const before = (await sha256File(path.join(dir, "render", "output.mp4"))).sha256;
    ctl.mode = "fail";
    const r3 = await resumeWith(p, pipe, { forceSteps: new Set(["render"]) });
    expect(r3.jobs[0]).toMatchObject({ result: "failed" });
    const failed = await readJob(p.paths, J(KEY));
    expect(failed).toMatchObject({ state: "FAILED", failure: { step: "render", kind: "retries-exhausted", code: "RENDER_FAILED" } });
    expect(failed.steps["render"]!.attempts.slice(-3).map((a) => a.outcome)).toEqual(["failed-retryable", "failed-retryable", "failed-retryable"]);
    expect(failed.steps["render"]!.attempts.at(-1)!.error!.message).toContain("simulated renderer crash");
    expect((await sha256File(path.join(dir, "render", "output.mp4"))).sha256).toBe(before); // previous video untouched
    expect(failed.steps["render"]!.outputs).toEqual([]); // but no longer reported as a verified output
    expect(await cfRenderTmpDirs()).toEqual([]);
  });

  it.each([
    ["empty", "RENDER_OUTPUT_INVALID", "failed-retryable", 3],
    ["garbage", "RENDER_OUTPUT_INVALID", "failed-retryable", 3],
    ["no-result", "RENDER_FAILED", "failed-retryable", 3],
    ["wrong-size", "RENDER_OUTPUT_MISMATCH", "failed-permanent", 1],
  ])("never accepts a bad render: %s -> %s", async (mode, code, outcome, attempts) => {
    const { p } = await renderProject(tmp.dir);
    ctl.mode = mode;
    await resumeWith(p, fakeRenderPipeline(ctl));
    const job = await readJob(p.paths, J(KEY));
    expect(job.state).toBe("FAILED");
    expect(job.failure!.code).toBe(code);
    expect(job.steps["render"]!.attempts.map((a) => a.outcome)).toEqual(Array(attempts).fill(outcome));
    await expect(fs.stat(path.join(p.paths.jobDir(job.jobId), "render", "output.mp4"))).rejects.toThrow();
  });

  it("without ffprobe, records that streams were not inspected (container check still required)", async () => {
    const { p } = await renderProject(tmp.dir);
    await resumeWith(p, fakeRenderPipeline(ctl, { ffprobe: null }));
    const report = RenderReportSchema.parse(await readJsonFile(path.join(p.paths.jobDir(J(KEY)), "render", "report.json")));
    expect(report.mediaInspection).toMatchObject({ performed: false, container: { ok: true } });
    expect(report.mediaInspection.video).toBeUndefined();
    expect(report.warnings.join(" ")).toContain("media streams not inspected");
    expect(report.technicalQa).toBe("pending");
  });

  it("a timeout kills the worker AND its child processes and cleans up temporary files", async () => {
    const { p } = await renderProject(tmp.dir);
    ctl.mode = "hang";
    const policy = { ...p.config.workflow, maxAttempts: 1, stepTimeoutMs: { render: 4000 } };
    const t0 = Date.now();
    const r = await resumeWith(p, fakeRenderPipeline(ctl), { policy, graceMs: 8000 });
    expect(Date.now() - t0).toBeLessThan(40_000);
    expect(r.jobs[0]!.result).toBe("failed");
    const job = await readJob(p.paths, J(KEY));
    expect(job.steps["render"]!.attempts[0]).toMatchObject({ outcome: "timeout", error: { code: "TIMEOUT" } });
    const grandchild = Number(await fs.readFile(ctl.pidFile, "utf8"));
    for (let i = 0; i < 100 && isProcessAlive(grandchild); i++) await new Promise((res) => setTimeout(res, 50));
    expect(isProcessAlive(grandchild)).toBe(false);
    for (let i = 0; i < 50 && (await cfRenderTmpDirs()).length; i++) await new Promise((res) => setTimeout(res, 100));
    expect(await cfRenderTmpDirs()).toEqual([]);
  });

  it("a scene-manifest change re-renders only that video; unrelated renders are reused", async () => {
    const { p, plan, approve } = await renderProject(tmp.dir, { keep: ["hooks-explained", "subagents-release"] });
    const pipe = fakeRenderPipeline(ctl);
    await resumeWith(p, pipe);
    expect(await fakeRuns(ctl.log)).toBe(2);
    await approve(plan((c) => (c.items.find((i) => i.contentId === "hooks-explained")!.hook = "A new opening line for this video.")));
    const r = await resumeWith(p, pipe);
    const by = Object.fromEntries(r.jobs.map((j) => [j.contentId, j]));
    expect(by["hooks-explained"]!.stepsRun).toEqual(["script", "localize", "narrate", "assets", "queue-render", "render"]);
    expect(by["subagents-release"]!.stepsRun).toEqual([]);
    expect(by["subagents-release"]!.stepsReused).toContain("render");
    expect(await fakeRuns(ctl.log)).toBe(3);
    const j = await readJob(p.paths, J(KEY));
    expect(j.history.some((h) => h.type === "invalidated" && h.step === "render" && h.reason === "step inputs changed")).toBe(true);
  });

  it("a render-config change re-renders without redoing script or assets", async () => {
    const { p } = await renderProject(tmp.dir);
    const pipe = fakeRenderPipeline(ctl);
    await resumeWith(p, pipe);
    const cfg = { ...p.config, render: { ...p.config.render, crf: 23 } };
    const r = await resumeWith(p, pipe, {}, cfg);
    expect(r.jobs[0]!.stepsRun).toEqual(["queue-render", "render"]);
    expect(RenderRequestSchema.parse(await readJsonFile(path.join(p.paths.jobDir(J(KEY)), "render", "request.json"))).settings.crf).toBe(23);
  });
});

describe("assets step and pre-render checks (no renderer involved)", { timeout: 180_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;
  beforeEach(async () => {
    KEY = "hooks-explained";
    tmp = await makeTempDir("cf-rast-");
    ctl = { mode: "ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "pid") };
  });
  afterEach(() => tmp.cleanup());

  const DIAGRAM_PROFILE = { ...RENDER_PROFILE, visual: { styles: ["motion-typography", "technical-diagrams"] } };
  async function registry(ws: string, assets: Record<string, unknown>[]) {
    await writeJsonAtomic(path.join(ws, "assets", "registry.json"), { schemaVersion: 1, kind: "asset-registry", assets });
  }

  it("a required diagram blocks until registered; a registered, verified PNG is resolved and drawn", async () => {
    KEY = DIAGRAM_CANDIDATE.key;
    const { p } = await renderProject(tmp.dir, { profile: DIAGRAM_PROFILE, keep: [DIAGRAM_CANDIDATE.key], extraCandidates: [DIAGRAM_CANDIDATE] });
    const pipe = fakeRenderPipeline(ctl);
    await resumeWith(p, pipe);
    let job = await readJob(p.paths, J(KEY));
    expect(job.blocked).toMatchObject({ step: "assets", code: "ASSETS_MISSING" });
    const id = /ast-scn-\d{2}-diagram/.exec(job.blocked!.reason)![0];
    expect(job.blocked!.reason).toContain("workspace/assets/registry.json");
    expect(await fakeRuns(ctl.log)).toBe(0);

    const png = makePng(640, 360, [[255, 255, 255], [124, 92, 255]]);
    await fs.mkdir(path.join(p.ws, "assets", "diagrams"), { recursive: true });
    await fs.writeFile(path.join(p.ws, "assets", "diagrams", "hooks.png"), png);
    await registry(p.ws, [{ jobId: job.jobId, assetId: id, path: "diagrams/hooks.png", sha256: `sha256:${"0".repeat(64)}`, license: "own work" }]);
    await resumeWith(p, pipe);
    job = await readJob(p.paths, J(KEY));
    expect(job.blocked).toMatchObject({ step: "assets", code: "ASSET_INVALID", reason: expect.stringContaining("does not match the registered") });

    await registry(p.ws, [{ jobId: job.jobId, assetId: id, path: "diagrams/hooks.png", sha256: `sha256:${sha256Hex(png)}`, license: "own work", attribution: "Diagram by the creator" }]);
    const r = await resumeWith(p, pipe);
    expect(r.jobs[0]!.stepsRun).toEqual(["assets", "queue-render", "render"]);
    const res = AssetResolutionSchema.parse(await readJsonFile(path.join(p.paths.jobDir(job.jobId), "assets", "resolution.json")));
    expect(res.assets.find((a) => a.assetId === id)).toMatchObject({ status: "resolved", license: "own work", file: { root: "assets", path: "diagrams/hooks.png", mediaType: "image/png" } });
    const req = RenderRequestSchema.parse(await readJsonFile(path.join(p.paths.jobDir(job.jobId), "render", "request.json")));
    expect(req.scenes.find((s) => s.type === "technical-diagram")).toMatchObject({ component: "Diagram", fallback: "none" });

    // Editing the registered file invalidates the assets step, which then refuses the changed file.
    await fs.writeFile(path.join(p.ws, "assets", "diagrams", "hooks.png"), makePng(640, 360, [[0, 0, 0]]));
    await registry(p.ws, [{ jobId: job.jobId, assetId: id, path: "diagrams/hooks.png", sha256: `sha256:${sha256Hex(png)}`, license: "own work" }]);
    await resumeWith(p, pipe);
    expect((await readJob(p.paths, job.jobId)).blocked).toMatchObject({ step: "assets", code: "ASSET_INVALID" });
  });

  it("rejects registry paths that escape the assets directory, and files that are not what they claim", async () => {
    KEY = DIAGRAM_CANDIDATE.key;
    const { p } = await renderProject(tmp.dir, { profile: DIAGRAM_PROFILE, keep: [DIAGRAM_CANDIDATE.key], extraCandidates: [DIAGRAM_CANDIDATE] });
    const pipe = fakeRenderPipeline(ctl);
    await resumeWith(p, pipe);
    const job = await readJob(p.paths, J(KEY));
    const id = /ast-scn-\d{2}-diagram/.exec(job.blocked!.reason)![0];
    await registry(p.ws, [{ jobId: job.jobId, assetId: id, path: "../../creatorflow.config.json", sha256: `sha256:${"1".repeat(64)}`, license: "x" }]);
    await resumeWith(p, pipe);
    expect((await readJob(p.paths, job.jobId)).blocked).toMatchObject({ code: "ASSET_REGISTRY_INVALID" });
    const fake = Buffer.from("not really a png");
    await fs.mkdir(path.join(p.ws, "assets"), { recursive: true });
    await fs.writeFile(path.join(p.ws, "assets", "fake.png"), fake);
    await registry(p.ws, [{ jobId: job.jobId, assetId: id, path: "fake.png", sha256: `sha256:${sha256Hex(fake)}`, license: "x" }]);
    await resumeWith(p, pipe);
    expect((await readJob(p.paths, job.jobId)).blocked!.reason).toContain("does not contain image/png data");
    expect(await fakeRuns(ctl.log)).toBe(0);
  });

  it("a file named .mp4 that is not a video is rejected from its bytes (Stage G accepts real video assets)", async () => {
    const { p } = await renderProject(tmp.dir, { keep: ["hooks-tutorial"] });
    const pipe = fakeRenderPipeline(ctl);
    await resumeWith(p, pipe);
    let job = await readJob(p.paths, J("hooks-tutorial"));
    expect(job.blocked).toMatchObject({ step: "assets", code: "ASSETS_MISSING" });
    const id = /ast-scn-\d{2}-screen-recording/.exec(job.blocked!.reason)![0];
    await fs.mkdir(path.join(p.ws, "assets"), { recursive: true });
    await fs.writeFile(path.join(p.ws, "assets", "demo.mp4"), "x");
    await registry(p.ws, [{ jobId: job.jobId, assetId: id, path: "demo.mp4", sha256: `sha256:${sha256Hex("x")}`, license: "own" }]);
    await resumeWith(p, pipe);
    job = await readJob(p.paths, job.jobId);
    expect(job.blocked).toMatchObject({ step: "assets", code: "ASSET_INVALID", reason: expect.stringContaining("not an MP4/MOV") });
  });

  it("blocks when the brand font cannot draw the text (Devanagari brand name with Inter)", async () => {
    const { p } = await renderProject(tmp.dir, { profile: { ...RENDER_PROFILE, brand: { name: "हिंदी Tech" } } });
    await resumeWith(p, fakeRenderPipeline(ctl));
    const job = await readJob(p.paths, J(KEY));
    expect(job.blocked).toMatchObject({ step: "assets", code: "FONT_GLYPHS_MISSING" });
    expect(job.blocked!.reason).toMatch(/U\+0939/); // ह
    expect(await fakeRuns(ctl.log)).toBe(0);
  });

  it("blocks system fonts (coverage unverifiable), missing fonts, and voice modes without narration support", async () => {
    const sys = { ...RENDER_PROFILE, brand: { name: "Fixture Brand", fonts: { heading: { family: "Arial", source: "system", license: "proprietary" }, body: { family: "Inter", source: "google-fonts", license: "OFL-1.1" }, mono: { family: "JetBrains Mono", source: "google-fonts", license: "OFL-1.1" } } } };
    const { p } = await renderProject(tmp.dir, { profile: sys });
    await resumeWith(p, fakeRenderPipeline(ctl));
    expect((await readJob(p.paths, J(KEY))).blocked).toMatchObject({ step: "assets", code: "FONT_UNVERIFIABLE" });

    const tmp2 = await makeTempDir("cf-rast2-");
    try {
      const missing = { ...RENDER_PROFILE, brand: { name: "Fixture Brand", fonts: { heading: { family: "Totally Not Installed", source: "google-fonts", license: "OFL-1.1" }, body: { family: "Inter", source: "google-fonts", license: "OFL-1.1" }, mono: { family: "JetBrains Mono", source: "google-fonts", license: "OFL-1.1" } } } };
      const { p: p2 } = await renderProject(tmp2.dir, { profile: missing });
      await resumeWith(p2, fakeRenderPipeline(ctl));
      const j2 = await readJob(p2.paths, J(KEY));
      expect(j2.blocked).toMatchObject({ step: "assets", code: "FONT_UNAVAILABLE" });
      expect(j2.blocked!.reason).toContain("does not download fonts");
    } finally {
      await tmp2.cleanup();
    }
  });

  it("voice.mode tts without a configured provider blocks at narrate instead of rendering a video with missing narration", async () => {
    const { p } = await renderProject(tmp.dir, { profile: { ...RENDER_PROFILE, voice: { mode: "tts" } } });
    await resumeWith(p, fakeRenderPipeline(ctl));
    expect((await readJob(p.paths, J(KEY))).blocked).toMatchObject({ step: "narrate", code: "VOICE_PROVIDER_UNAVAILABLE", reason: expect.stringContaining('providers.tts.id is "none"') });
    expect(await fakeRuns(ctl.log)).toBe(0);
  });

  it("no browser and no permission to download -> queue-render blocks before any render", async () => {
    const { p } = await renderProject(tmp.dir);
    const cfg = { ...p.config, hardware: { ...p.config.hardware, browserExecutable: path.join(tmp.dir, "missing-chrome.exe") } };
    await resumeWith(p, fakeRenderPipeline(ctl), {}, cfg);
    expect((await readJob(p.paths, J(KEY))).blocked).toMatchObject({ step: "queue-render", code: "BROWSER_UNAVAILABLE" });
    expect(await fakeRuns(ctl.log)).toBe(0);
  });
});
