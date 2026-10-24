// Technical QA and the human review gate in the production pipeline, with a SIMULATED renderer
// (tests/fixtures/qa-video.ts draws QA-plausible frames, or frames with one deliberate defect) and
// the REAL QA executor, which decodes and measures those files with Remotion's bundled ffmpeg/ffprobe.
// Fault-injection tests rewrite an upstream artifact AND its recorded hash, simulating a buggy upstream
// step whose output passed its own checks; they are labelled [fault injection].
// Real Remotion output is QA'd in render-real.test.ts, media-real.test.ts and e2e/render.test.ts.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, sha256File, sha256Hex, stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { JobStore } from "@creatorflow/orchestrator";
import { QaReportSchema, ReviewManifestSchema, ReviewRecordSchema, type QaReport } from "@creatorflow/schemas";
import { assetsRegisterCommand } from "../../packages/cli/src/commands/assets.ts";
import { qaShowCommand, reviewDecideCommand, reviewShowCommand } from "../../packages/cli/src/commands/qa.ts";
import { createOutput } from "../../packages/cli/src/output.ts";
import { captureStreams, makeTempDir } from "../helpers.ts";
import { makePng } from "../fixtures/media.ts";
import { fakeRenderPipeline, renderProject, resumeWith, type FakeControl } from "../render-helpers.ts";
import { readJob, type FixtureProject } from "../workflow-helpers.ts";

const KEY = "hooks-explained";
const J = `2026-w44-${KEY}`;
const jdir = (p: FixtureProject) => p.paths.jobDir(J);
const qaReport = async (p: FixtureProject) => QaReportSchema.parse(await readJsonFile(path.join(jdir(p), "qa", "report.json")));
const check = (r: QaReport, id: string) => r.checks.find((c) => c.id === id)!;
const renders = async (log: string) => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
const out = () => {
  const c = captureStreams();
  return { o: createOutput(true, c.streams), c };
};

/** [fault injection] rewrites a verified output and updates its recorded hash so the step still looks verified. */
async function inject(p: FixtureProject, step: string, rel: string, edit: (data: any) => void): Promise<void> {
  const file = path.join(jdir(p), rel);
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  edit(data);
  const body = stringifyJson(data);
  await writeFileAtomic(file, body);
  const store = new JobStore(p.paths);
  const l = await store.load(J);
  if (l.status !== "ok") throw new Error("job");
  const o = l.job.steps[step]!.outputs.find((x) => x.path === rel)!;
  o.sha256 = `sha256:${sha256Hex(body)}`;
  o.bytes = Buffer.byteLength(body);
  await store.save(l.job);
}

describe("technical QA with a SIMULATED renderer and the REAL QA executor", { timeout: 300_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-qa-");
    ctl = { mode: "qa-ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "pid") };
  });
  afterEach(() => tmp.cleanup());
  const pipe = (qa = {}) => fakeRenderPipeline(ctl, { qa });

  it("a sound silent video passes technical QA; review stays pending until a human approves this exact report", async () => {
    const { p } = await renderProject(tmp.dir);
    const r = await resumeWith(p, pipe());
    const rep = await qaReport(p);
    expect(rep.technicalQa, JSON.stringify(rep.checks.filter((c) => c.status !== "PASS" && c.status !== "NOT_APPLICABLE"), null, 1)).toEqual({ status: "passed", reasons: [] });
    expect(r.jobs[0]!.stepsRun).toEqual(["research", "script", "localize", "narrate", "assets", "queue-render", "render", "qa", "review"]);
    let job = await readJob(p.paths, J);
    expect(job).toMatchObject({ state: "BLOCKED", resumeState: "QA_PASSED", lastSuccessfulStep: "qa", blocked: { step: "review", code: "NEEDS_HUMAN_REVIEW" } });
    expect(job.artifacts).toMatchObject({ quality: `jobs/${J}/qa/report.json`, qaReview: `jobs/${J}/qa/review-manifest.json` });

    expect(rep.humanReview).toEqual({ required: true, status: "pending" });
    expect(rep.deliveryReadiness).toEqual({ status: "blocked", blockers: ["human review pending (creatorflow review approve)"] });
    for (const id of ["file.integrity", "file.dependencies", "video.container", "video.stream", "video.decode", "audio.streams", "captions.timing", "captions.text", "captions.method", "captions.lines", "captions.burned-in", "captions.safe-area", "captions.contrast", "visual.frames", "visual.blank", "visual.edges", "visual.safe-margins", "visual.text-contrast", "visual.font-size", "content.scenes", "content.plan", "content.claims", "content.attribution", "content.assets-current", "content.localization", "provenance.claims"]) expect(check(rep, id).status, id).toBe("PASS");
    for (const id of ["audio.decode", "audio.speech", "audio.clipping", "audio.dropouts", "captions.coverage", "content.narration-text"]) expect(check(rep, id).status, id).toBe("NOT_APPLICABLE");
    expect(check(rep, "visual.assets").status).toBe("NOT_APPLICABLE"); // text-only video
    expect(rep.media).toMatchObject({ video: { codec: "h264", width: 1080, height: 1920, fps: 30 }, audioStreams: 0, audio: null });
    expect(rep.media.decodedFrames).toBe(rep.media.video!.frames);
    expect(rep.captions).toMatchObject({ timing: "estimated", burnedIn: true });
    // Deterministic sampling: start, middle, end, every scene; every frame file hashed.
    const s = rep.frames.samples;
    expect(s[0]).toMatchObject({ frame: 0, purpose: "start", blankAllowed: true });
    expect(s.at(-1)!.frame).toBe(rep.media.video!.frames! - 1);
    expect(new Set(s.filter((x) => x.purpose === "scene-mid").map((x) => x.sceneId)).size).toBe(new Set(s.map((x) => x.sceneId)).size);
    for (const f of s) expect((await sha256File(path.join(jdir(p), f.path))).sha256).toBe(f.sha256);
    expect(s.filter((x) => x.activeCueId).every((x) => x.metrics.captionBox)).toBe(true);
    expect(rep.reviewItems.map((i) => i.id)).toEqual(expect.arrayContaining(["review.facts", "review.visual", "review.platform-ui"]));
    expect(rep.tools.map((t) => t.name)).toEqual(["ffprobe", "ffmpeg"]);
    expect(JSON.stringify(rep)).not.toContain(os.homedir());
    // No staging dirs or temp dirs left behind.
    expect((await fs.readdir(path.join(jdir(p), "qa"))).filter((n) => n.startsWith(".frames-"))).toEqual([]);
    expect((await fs.readdir(os.tmpdir())).filter((n) => n.startsWith(`cf-qa-${process.pid}-`))).toEqual([]);
    const manifest = ReviewManifestSchema.parse(await readJsonFile(path.join(jdir(p), "qa", "review-manifest.json")));
    expect(manifest.qaReport.sha256).toBe((await sha256File(path.join(jdir(p), "qa", "report.json"))).sha256);
    expect(manifest.frames).toHaveLength(s.length);

    // Review gate: show (pending, exit 1), wrong hash (exit 5), approve, resume -> REVIEWED; package not implemented.
    expect(await reviewShowCommand(out().o, p.dir, { job: J })).toBe(1);
    await expect(reviewDecideCommand(out().o, p.dir, { job: J, qaHash: "0123456789abcdef", by: "Reviewer", decision: "approved" })).rejects.toMatchObject({ code: "QA_HASH_MISMATCH", exitCode: 5 });
    await expect(reviewDecideCommand(out().o, p.dir, { job: J, qaHash: manifest.qaReport.sha256.slice(7, 23), by: "Reviewer", decision: "rejected" })).rejects.toMatchObject({ code: "USAGE" });
    expect(await reviewDecideCommand(out().o, p.dir, { job: J, qaHash: manifest.qaReport.sha256.slice(7, 23), by: "Reviewer", decision: "approved", note: "frames checked" })).toBe(0);
    const r2 = await resumeWith(p, pipe());
    expect(r2.jobs[0]!.stepsRun).toEqual(["review", "package"]);
    job = await readJob(p.paths, J);
    expect(job).toMatchObject({ state: "PACKAGE_READY" });
    const rec = ReviewRecordSchema.parse(await readJsonFile(path.join(jdir(p), "review", "record.json")));
    expect(rec).toMatchObject({ review: { status: "approved", by: "Reviewer" }, deliveryReadiness: { status: "ready-for-packaging" } });
    const sh = out();
    expect(await reviewShowCommand(sh.o, p.dir, { job: J })).toBe(0);
    expect(JSON.parse(sh.c.stdout)).toMatchObject({ review: "approved", deliveryReadiness: "ready-for-packaging" });

    // A new render (render setting changed) re-runs QA; the old approval no longer applies.
    const before = await renders(ctl.log);
    const cfg = { ...p.config, render: { ...p.config.render, crf: 24 } };
    const r3 = await resumeWith(p, pipe(), {}, cfg);
    expect(r3.jobs[0]!.stepsRun).toEqual(["queue-render", "render", "qa", "review"]);
    expect(await renders(ctl.log)).toBe(before + 1);
    expect((await readJob(p.paths, J)).blocked).toMatchObject({ step: "review", code: "REVIEW_STALE" });
    const show = out();
    expect(await reviewShowCommand(show.o, p.dir, { job: J })).toBe(1);
    expect(JSON.parse(show.c.stdout)).toMatchObject({ review: "stale-decision", deliveryReadiness: "blocked" });
  });

  it("selective invalidation: edited MP4 re-renders; edited QA report, QA thresholds or --force-step qa re-run QA only; unrelated asset changes do nothing", async () => {
    const { p } = await renderProject(tmp.dir);
    await resumeWith(p, pipe());
    const runs = async (extra = {}, cfg = p.config) => (await resumeWith(p, pipe(), extra, cfg)).jobs[0]!.stepsRun;
    const n0 = await renders(ctl.log);
    expect(await runs()).toEqual(["review"]); // review is re-checked (blocked); nothing else re-runs
    // Editing the QA report: only QA re-runs, never the render.
    const qaFile = path.join(jdir(p), "qa", "report.json");
    await fs.appendFile(qaFile, " ");
    expect(await runs()).toEqual(["qa", "review"]);
    expect(await renders(ctl.log)).toBe(n0);
    // QA thresholds changed: QA only.
    expect(await runs({}, { ...p.config, qa: { ...p.config.qa, maxPauseMs: 4000 } })).toEqual(["qa", "review"]);
    // Forced QA: QA only.
    expect(await runs({ forceSteps: new Set(["qa"]) })).toEqual(["qa", "review"]);
    expect(await renders(ctl.log)).toBe(n0);
    // An asset registered for ANOTHER job does not invalidate this job.
    const png = path.join(p.ws, "assets", "other.png");
    await fs.mkdir(path.dirname(png), { recursive: true });
    await fs.writeFile(png, makePng(64, 64, [[10, 200, 30]]));
    expect(await assetsRegisterCommand(out().o, p.dir, { file: png, type: "diagram", job: "2026-w44-some-other-job", slot: "ast-scn-02-diagram", origin: "user-created" })).toBe(0);
    expect(await runs()).toEqual(["review"]);
    // Editing the final MP4 invalidates the render (re-rendered, byte-identical here) and therefore QA.
    const mp4 = path.join(jdir(p), "render", "output.mp4");
    await fs.appendFile(mp4, "x");
    expect(await runs()).toEqual(["render", "qa", "review"]);
    expect(await renders(ctl.log)).toBe(n0 + 1);
    const rep = await qaReport(p);
    expect(rep.render.outputSha256).toBe((await sha256File(mp4)).sha256);
    expect(rep.technicalQa.status).toBe("passed");
  });

  it.each([
    ["ok", ["visual.blank", "captions.burned-in"]], // uniform frames, no captions
    ["qa-no-captions", ["captions.burned-in"]],
    ["qa-margin-text", ["visual.safe-margins", "visual.edges"]],
    ["qa-blank-scene", ["visual.blank"]],
    ["qa-caption-low", ["captions.contrast"]],
    ["qa-damaged", ["video.decode"]],
  ])("a render that passed the render step but has a defect fails QA: %s -> %s; the render is kept", async (mode, failing) => {
    ctl.mode = mode;
    const { p } = await renderProject(tmp.dir);
    const r = await resumeWith(p, pipe());
    expect(r.jobs[0]!.result).toBe("failed");
    const job = await readJob(p.paths, J);
    expect(job).toMatchObject({ state: "FAILED", resumeState: "RENDERED", failure: { step: "qa", kind: "permanent", code: "QA_FAILED" } });
    expect(job.steps["render"]!.status).toBe("succeeded");
    await fs.stat(path.join(jdir(p), "render", "output.mp4")); // preserved for diagnosis
    const rep = await qaReport(p);
    expect(rep.technicalQa.status).toBe("failed");
    for (const id of failing) expect(check(rep, id).status, `${id}: ${check(rep, id).detail}`).toBe("FAIL");
    expect(rep.deliveryReadiness.status).toBe("blocked");
    // The failed report is shown, but never as verified, and review cannot approve it.
    const sh = out();
    expect(await qaShowCommand(sh.o, p.dir, { job: J })).toBe(1);
    expect(JSON.parse(sh.c.stdout)).toMatchObject({ ok: false, source: "unverified", qaStep: "failed" });
    await expect(reviewDecideCommand(out().o, p.dir, { job: J, qaHash: (await sha256File(path.join(jdir(p), "qa", "report.json"))).sha256.slice(7, 23), decision: "approved" })).rejects.toMatchObject({ code: "QA_NOT_VERIFIED" });
    // Re-running without changes does not retry a permanent QA failure, nor re-render.
    const n = await renders(ctl.log);
    expect((await resumeWith(p, pipe())).jobs[0]!.stepsRun).toEqual([]);
    expect(await renders(ctl.log)).toBe(n);
  });

  it("missing inspection tools block QA with NOT_INSPECTED checks; they are never treated as passed", async () => {
    const { p } = await renderProject(tmp.dir);
    await resumeWith(p, pipe({ ffprobe: null }));
    let job = await readJob(p.paths, J);
    expect(job.blocked).toMatchObject({ step: "qa", code: "QA_TOOLS_UNAVAILABLE" });
    let rep = await qaReport(p);
    expect(rep.technicalQa.status).toBe("blocked");
    expect(check(rep, "video.stream").status).toBe("NOT_INSPECTED");
    expect(check(rep, "audio.streams").status).toBe("NOT_INSPECTED");
    await resumeWith(p, pipe({ ffmpeg: null }));
    job = await readJob(p.paths, J);
    expect(job.blocked).toMatchObject({ step: "qa", code: "QA_TOOLS_UNAVAILABLE" });
    rep = await qaReport(p);
    expect(["video.decode", "visual.frames", "visual.blank", "captions.burned-in"].map((id) => check(rep, id).status)).toEqual(["NOT_INSPECTED", "NOT_INSPECTED", "NOT_INSPECTED", "NOT_INSPECTED"]);
    expect(rep.deliveryReadiness.status).toBe("blocked");
    // With the tools back, the same render passes without being re-rendered.
    const n = await renders(ctl.log);
    await resumeWith(p, pipe());
    expect((await qaReport(p)).technicalQa.status).toBe("passed");
    expect(await renders(ctl.log)).toBe(n);
  });

  it("[fault injection] caption text that differs from the script, captions past the end, and a dropped source attribution fail QA", async () => {
    const { p } = await renderProject(tmp.dir);
    await resumeWith(p, pipe());
    // 1. A cue's words no longer match the approved script.
    await inject(p, "narrate", "narration/subtitles.json", (d) => (d.tracks[0].cues[0].lines = ["Words the script never said."]));
    {
      // keep narration.json's reference to the edited subtitles consistent
      const subs = await fs.readFile(path.join(jdir(p), "narration", "subtitles.json"));
      await inject(p, "narrate", "narration/narration.json", (d) => (d.subtitles.sha256 = `sha256:${sha256Hex(subs)}`));
    }
    await resumeWith(p, pipe());
    let rep = await qaReport(p);
    expect(check(rep, "captions.text")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("differ from the approved script") });
    expect((await readJob(p.paths, J)).failure).toMatchObject({ step: "qa", code: "QA_FAILED" });

    // 2. A cue that runs past the end of the video.
    const t2 = await makeTempDir("cf-qa2-");
    try {
      const { p: q } = await renderProject(t2.dir);
      await resumeWith(q, pipe());
      const dur = (await qaReport(q)).media.video!.durationSec * 1000;
      await inject(q, "narrate", "narration/subtitles.json", (d) => (d.tracks[0].cues.at(-1).endMs = Math.round(dur + 5000)));
      const subs = await fs.readFile(path.join(q.paths.jobDir(J), "narration", "subtitles.json"));
      await inject(q, "narrate", "narration/narration.json", (d) => (d.subtitles.sha256 = `sha256:${sha256Hex(subs)}`));
      await resumeWith(q, pipe());
      rep = await qaReport(q);
      expect(check(rep, "captions.timing")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("outside the video") });
    } finally {
      await t2.cleanup();
    }

    // 3. The scene that must show a source label lost it.
    const t3 = await makeTempDir("cf-qa3-");
    try {
      const { p: q } = await renderProject(t3.dir);
      await resumeWith(q, pipe());
      const m = (await readJsonFile(path.join(q.paths.jobDir(J), "script", "scene-manifest.json"))) as any;
      const required = m.attributions.find((a: any) => a.required && a.sceneIds.length);
      expect(required).toBeTruthy();
      await inject(q, "script", "script/scene-manifest.json", (d) => {
        for (const s of d.scenes) if (required.sceneIds.includes(s.sceneId)) delete s.text.secondary;
      });
      await resumeWith(q, pipe());
      rep = await qaReport(q);
      expect(check(rep, "content.attribution")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("should show \"Source:") });
    } finally {
      await t3.cleanup();
    }
  });
});
