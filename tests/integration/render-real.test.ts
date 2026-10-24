// REAL RENDER: runs Remotion (bundler + headless system Chrome) through the production
// render step. Local fixtures only: FICTIONAL research, a generated PNG diagram, fonts from the
// installed @fontsource packages. No network. Verifies the MP4 with ffprobe and by decoding frames.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonFile, sha256File, sha256Hex, writeJsonAtomic } from "@creatorflow/core";
import { QaReportSchema, RenderReportSchema, RenderRequestSchema, SceneManifestSchema } from "@creatorflow/schemas";
import { buildProductionPipeline } from "../../packages/cli/src/pipeline.ts";
import { makeTempDir } from "../helpers.ts";
import { frameRgb as frameAt, makePng } from "../fixtures/media.ts";
import { DIAGRAM_CANDIDATE, ownRenderTmpDirs, renderProject, RENDER_PROFILE, resumeWith, withRealRenderSlot } from "../render-helpers.ts";
import { readJob, type FixtureProject } from "../workflow-helpers.ts";

const pixels = (b: Buffer, pred: (r: number, g: number, bl: number) => boolean) => {
  let n = 0;
  for (let i = 0; i + 2 < b.length; i += 3) if (pred(b[i]!, b[i + 1]!, b[i + 2]!)) n++;
  return n;
};

describe("REAL Remotion render of a scene manifest", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  const jobId = `2026-w44-${DIAGRAM_CANDIDATE.key}`;
  let dir: string;
  let renderMs = 0;

  beforeAll(async () => {
    tmp = await makeTempDir("cf-real-");
    ({ p } = await renderProject(tmp.dir, { profile: { ...RENDER_PROFILE, visual: { styles: ["motion-typography", "technical-diagrams"] } }, keep: [DIAGRAM_CANDIDATE.key], extraCandidates: [DIAGRAM_CANDIDATE] }));
    const pipe = buildProductionPipeline();
    await resumeWith(p, pipe);
    const blocked = await readJob(p.paths, jobId);
    const assetId = /ast-scn-\d{2}-diagram/.exec(blocked.blocked!.reason)![0];
    // White and brand-purple bands: easy to detect in decoded frames.
    const png = makePng(800, 450, [[255, 255, 255], [124, 92, 255], [255, 255, 255]]);
    await fs.mkdir(path.join(p.ws, "assets"), { recursive: true });
    await fs.writeFile(path.join(p.ws, "assets", "diagram.png"), png);
    await writeJsonAtomic(path.join(p.ws, "assets", "registry.json"), { schemaVersion: 1, kind: "asset-registry", assets: [{ jobId, assetId, path: "diagram.png", sha256: `sha256:${sha256Hex(png)}`, license: "test fixture (generated)" }] });
    const t0 = Date.now();
    const r = await withRealRenderSlot(() => resumeWith(p, pipe));
    renderMs = Date.now() - t0;
    // Stage H: real technical QA runs after the render; the job then waits for a human reviewer.
    expect(r.jobs[0]!.stepsRun).toEqual(["assets", "queue-render", "render", "qa", "review"]);
    dir = p.paths.jobDir(jobId);
  }, 900_000);
  afterAll(() => tmp.cleanup());

  it("produces a verified H.264 MP4 matching the manifest, with a schema-valid report", async () => {
    const job = await readJob(p.paths, jobId);
    expect(job).toMatchObject({ state: "BLOCKED", resumeState: "QA_PASSED", lastSuccessfulStep: "qa", blocked: { step: "review", code: "NEEDS_HUMAN_REVIEW" } });
    const manifest = SceneManifestSchema.parse(await readJsonFile(path.join(dir, "script", "scene-manifest.json")));
    const request = RenderRequestSchema.parse(await readJsonFile(path.join(dir, "render", "request.json")));
    const report = RenderReportSchema.parse(await readJsonFile(path.join(dir, "render", "report.json")));
    expect(request.format).toEqual({ width: manifest.format.width, height: manifest.format.height, fps: manifest.format.fps, durationInFrames: manifest.durationInFrames });
    expect(report.output.sha256).toBe((await sha256File(path.join(dir, "render", "output.mp4"))).sha256);
    expect(report.mediaInspection).toMatchObject({
      performed: true,
      matchesRequest: true,
      container: { ok: true },
      audioStreams: 0,
      video: { codec: "h264", width: 1080, height: 1920, fps: 30, frames: manifest.durationInFrames },
    });
    expect(report.mediaInspection.video!.durationSec).toBeCloseTo(manifest.durationInFrames / 30, 1);
    expect(report.renderer).toMatchObject({ id: "creatorflow-remotion", remotion: "4.0.538" });
    expect(report.process.exitCode).toBe(0);
    expect(report.technicalQa).toBe("pending");
    expect(request.scenes.map((s) => s.component)).toContain("Diagram");
    console.log(`[real render] ${manifest.durationInFrames} frames ${report.expected.durationSec}s 1080x1920 in ${renderMs} ms, ${report.output.bytes} bytes`);
    expect(await ownRenderTmpDirs()).toEqual([]);
  });

  it("the decoded frames show the diagram in its scene, captions in the lower area, and brand background elsewhere", async () => {
    const manifest = SceneManifestSchema.parse(await readJsonFile(path.join(dir, "script", "scene-manifest.json")));
    const video = path.join(dir, "render", "output.mp4");
    const diagram = manifest.scenes.find((s) => s.type === "technical-diagram")!;
    const hook = manifest.scenes[0]!;
    const mid = (s: typeof hook) => (s.startFrame + s.durationInFrames * 0.6) / 30;
    const purple = (r: number, g: number, b: number) => Math.abs(r - 124) < 30 && Math.abs(g - 92) < 30 && Math.abs(b - 255) < 40;
    const white = (r: number, g: number, b: number) => r > 235 && g > 235 && b > 235;
    const dFrame = await frameAt(video, mid(diagram));
    const hFrame = await frameAt(video, mid(hook));
    expect(pixels(dFrame, purple)).toBeGreaterThan(20); // the registered image is on screen
    expect(pixels(hFrame, purple)).toBeLessThan(20); // and not in the hook scene
    // Bottom 20% of the hook frame (decoded at 270x480 so text stays sharp) contains white caption text.
    const big = await frameAt(video, mid(hook), 270, 480);
    const bottom = big.subarray(Math.floor(480 * 0.8) * 270 * 3);
    expect(pixels(bottom, white)).toBeGreaterThan(50);
    // Background is the brand background colour (#0B0D12) in the top-left corner.
    expect(hFrame[3 * 54 * 5]!).toBeLessThan(30);
  });

  it("REAL technical QA of the real silent render passes, with every required check measured", async () => {
    const qa = QaReportSchema.parse(await readJsonFile(path.join(dir, "qa", "report.json")));
    const report = RenderReportSchema.parse(await readJsonFile(path.join(dir, "render", "report.json")));
    const notPass = qa.checks.filter((c) => c.required && c.status !== "PASS" && c.status !== "NOT_APPLICABLE");
    expect(notPass, JSON.stringify(notPass, null, 1)).toEqual([]);
    expect(qa).toMatchObject({ technicalQa: { status: "passed" }, humanReview: { status: "pending" }, deliveryReadiness: { status: "blocked" }, render: { outputSha256: report.output.sha256 } });
    expect(qa.media).toMatchObject({ decodedFrames: report.expected.durationInFrames, audioStreams: 0, video: { codec: "h264", width: 1080, height: 1920 } });
    const byId = Object.fromEntries(qa.checks.map((c) => [c.id, c]));
    expect(byId["visual.assets"]!.status).toBe("PASS"); // the registered diagram is visible in its scene
    expect(byId["captions.burned-in"]!.status).toBe("PASS");
    expect(byId["audio.speech"]!.status).toBe("NOT_APPLICABLE");
    expect(qa.frames.samples.filter((s) => s.metrics.blank && !s.blankAllowed)).toEqual([]);
    expect(qa.frames.samples[0]).toMatchObject({ frame: 0, blankAllowed: true });
    const contrasts = qa.frames.samples.map((s) => s.metrics.captionContrast).filter((x): x is number => x !== null);
    console.log(`[real qa silent] ${qa.checks.length} checks: ${Object.entries(qa.summary).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}; ${qa.frames.samples.length} frames (${qa.frames.samples.filter((s) => s.metrics.blank).length} blank, all in animation windows); decoded ${qa.media.decodedFrames} frames in ${qa.performance.decodeMs} ms; frames ${qa.performance.framesMs} ms; total ${qa.performance.totalMs} ms; node RSS peak ${qa.performance.nodeRssPeakMb} MB; caption contrast ${Math.min(...contrasts)}–${Math.max(...contrasts)}:1; ${byId["visual.assets"]!.detail}`);
    for (const c of qa.checks.filter((x) => x.status !== "PASS")) console.log(`[real qa silent]   ${c.status} ${c.id}: ${c.detail.slice(0, 200)}`);
  });

  it("resuming again reuses the verified render (no second Remotion run)", async () => {
    const before = await readJob(p.paths, jobId);
    const r = await resumeWith(p, buildProductionPipeline());
    expect(r.jobs[0]!.stepsReused).toEqual(["research", "script", "localize", "narrate", "assets", "queue-render", "render", "qa"]);
    expect((await readJob(p.paths, jobId)).steps["render"]!.attempts).toHaveLength(before.steps["render"]!.attempts.length);
  });
});
