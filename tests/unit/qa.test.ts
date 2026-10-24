// Unit tests for packages/qa: frame sampling, pixel measurements on SYNTHETIC images, audio
// measurements on SYNTHETIC samples, the pure consistency checks and the verdict, plus the media
// inspection layer on REAL small files generated locally with Remotion's bundled ffmpeg.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "@creatorflow/core";
import { buildSubtitleTrack } from "@creatorflow/scriptwriter";
import { CreatorFlowConfigSchema, type SubtitleTrack } from "@creatorflow/schemas";
import {
  analyzeFrame,
  attributionProblems,
  captionCoverageProblems,
  captionLineProblems,
  captionMethodProblems,
  captionTextProblems,
  captionTimingProblems,
  clippedSamples,
  colourSignature,
  decodeAll,
  decodePng,
  dropouts,
  extractFrame,
  inAnimationWindow,
  levels10ms,
  narrationTextProblems,
  planProblems,
  planSamples,
  sceneTimelineProblems,
  seekTimeFor,
  signatureMatches,
  silentRuns,
  technicalVerdict,
  type FrameLayout,
} from "@creatorflow/qa";
import { findFfmpeg, findFfprobe, inspectRender } from "@creatorflow/video-engine";
import { makeTempDir } from "../helpers.ts";
import { makeClip, makeMp4, remotionFfmpeg, toneWav } from "../fixtures/media.ts";
import { paintPng } from "../fixtures/qa-video.ts";

const W = 270;
const H = 480;
const BG: [number, number, number] = [11, 13, 18];
const layout: FrameLayout = { background: BG, text: [245, 247, 250], margins: { top: 0.03, bottom: 0.03, left: 0.04, right: 0.04 }, progressRows: 4, captionZoneTop: H * 0.8 };
const opts = { blankStdDev: 2.5, blankUniformFraction: 0.995 };
const img = (rects: Parameters<typeof paintPng>[3]) => decodePng(paintPng(W, H, BG, rects));

describe("frame sampling plan", () => {
  const scenes = [{ sceneId: "scn-01", startFrame: 0, durationInFrames: 90 }, { sceneId: "scn-02", startFrame: 90, durationInFrames: 60 }, { sceneId: "scn-03", startFrame: 150, durationInFrames: 450 }];
  it("is deterministic and covers start, middle, end, every scene, boundaries and intervals", () => {
    const a = planSamples(scenes, 600, 30, [{ cueId: "c1", startFrame: 10, endFrame: 80 }], { everySec: 5, max: 60 });
    expect(planSamples(scenes, 600, 30, [{ cueId: "c1", startFrame: 10, endFrame: 80 }], { everySec: 5, max: 60 })).toEqual(a);
    expect(a.map((s) => s.frame)).toEqual([...a.map((s) => s.frame)].sort((x, y) => x - y));
    expect(a[0]).toMatchObject({ frame: 0, purpose: "start", blankAllowed: true, activeCueId: null });
    expect(a.at(-1)).toMatchObject({ frame: 599, purpose: "end" });
    for (const s of scenes) expect(a.some((x) => x.sceneId === s.sceneId && x.purpose === "scene-mid" && !x.blankAllowed)).toBe(true);
    expect(a.filter((x) => x.purpose === "scene-start").map((x) => x.frame)).toEqual([100, 160]);
    expect(a.filter((x) => x.purpose === "interval").length).toBeGreaterThan(0);
    expect(a.find((x) => x.frame === 54)).toMatchObject({ activeCueId: "c1", sceneId: "scn-01" });
  });
  it("caps samples but always keeps the mandatory ones; animation windows are the only blank exceptions", () => {
    const capped = planSamples(scenes, 600, 30, [], { everySec: 1, max: 6 });
    expect(capped.length).toBe(6);
    expect(capped.filter((s) => s.purpose === "scene-mid")).toHaveLength(3);
    expect(inAnimationWindow(0, scenes)).toBe(true);
    expect(inAnimationWindow(11, scenes)).toBe(true);
    expect(inAnimationWindow(54, scenes)).toBe(false);
    expect(inAnimationWindow(87, scenes)).toBe(true); // exit fade of scene 1
    expect(inAnimationWindow(599, scenes)).toBe(false); // final scene has no exit fade
    expect(seekTimeFor(30, 30)).toBeCloseTo(29.75 / 30);
  });
});

describe("frame measurements (synthetic images)", () => {
  it("detects nearly uniform scene content, ignoring the caption zone and progress bar", () => {
    expect(analyzeFrame(img([]), layout, opts).blank).toBe(true);
    // A caption alone does not make an empty scene look non-blank.
    expect(analyzeFrame(img([{ x: 40, y: 400, w: 190, h: 20, c: [255, 255, 255] }]), layout, opts).blank).toBe(true);
    const text = analyzeFrame(img([{ x: 20, y: 150, w: 200, h: 14, c: [245, 247, 250] }]), layout, opts);
    expect(text.blank).toBe(false);
    // False-positive guard: subtle compression noise does not count as content, a dark-on-dark scene still does.
    const dim = analyzeFrame(img([{ x: 20, y: 150, w: 200, h: 60, c: [40, 44, 52] }]), layout, opts);
    expect(dim.blank).toBe(false);
  });

  it("counts text-like pixels in the safe margins and at the frame edges", () => {
    const ok = analyzeFrame(img([{ x: 30, y: 150, w: 200, h: 14, c: [245, 247, 250] }]), layout, opts);
    expect([ok.marginForeground, ok.edgeForeground]).toEqual([0, 0]);
    const edge = analyzeFrame(img([{ x: 0, y: 150, w: 40, h: 14, c: [255, 255, 255] }]), layout, opts);
    expect(edge.marginForeground).toBeGreaterThan(0);
    expect(edge.edgeForeground).toBeGreaterThan(0);
    // Dimmed backdrop video (×0.42 of white = 107) is not text.
    expect(analyzeFrame(img([{ x: 0, y: 0, w: W, h: H, c: [107, 107, 107] }]), layout, opts).marginForeground).toBe(0);
  });

  it("finds the caption box in the caption zone and measures its contrast", () => {
    const shade: [number, number, number] = [3, 4, 5];
    const cap = analyzeFrame(img([{ x: 40, y: 395, w: 190, h: 40, c: shade }, { x: 50, y: 402, w: 80, h: 10, c: [255, 255, 255] }, { x: 140, y: 402, w: 60, h: 10, c: [255, 255, 255] }]), layout, opts);
    expect(cap.captionBox).toMatchObject({ top: 402, bottom: 411, left: 50, right: 199 });
    expect(cap.captionContrast!).toBeGreaterThan(15);
    const low = analyzeFrame(img([{ x: 40, y: 395, w: 190, h: 40, c: [200, 200, 200] }, { x: 50, y: 402, w: 80, h: 10, c: [255, 255, 255] }]), layout, opts);
    expect(low.captionContrast!).toBeLessThan(2);
    expect(analyzeFrame(img([{ x: 50, y: 150, w: 80, h: 10, c: [255, 255, 255] }]), layout, opts).captionBox).toBeNull();
  });

  it("colour signatures find registered media and ignore brand background, black and white", () => {
    const src = decodePng(paintPng(40, 40, [255, 255, 255], [{ x: 0, y: 0, w: 40, h: 20, c: [124, 92, 255] }]));
    const sig = colourSignature(src, [BG]);
    expect(sig).toHaveLength(1);
    const withMedia = img([{ x: 20, y: 100, w: 230, h: 60, c: [124, 92, 255] }]);
    expect(signatureMatches(withMedia, sig)).toBe(230 * 60);
    expect(signatureMatches(img([]), sig)).toBe(0);
    expect(signatureMatches(img([{ x: 20, y: 100, w: 230, h: 60, c: [52, 39, 107] }]), sig, 0.42)).toBe(230 * 60); // dimmed backdrop
    expect(colourSignature(decodePng(paintPng(20, 20, [255, 255, 255], [])), [BG])).toEqual([]);
  });

  it("rejects non-PNG and unsupported PNG data", () => {
    expect(() => decodePng(Buffer.from("not a png at all, no"))).toThrow(/not a PNG/);
  });
});

describe("audio measurements (synthetic samples)", () => {
  const SR = 16000;
  const tone = (ms: number, amp: number) => Int16Array.from({ length: (ms * SR) / 1000 }, (_, i) => Math.round(Math.sin((2 * Math.PI * 200 * i) / SR) * amp * 32767));
  const join = (...parts: Int16Array[]) => {
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  it("finds silent runs, dropouts inside sentences only, and clipping", () => {
    const s = join(tone(500, 0.3), tone(1500, 0), tone(500, 0.3), tone(300, 0), tone(400, 0.3));
    const runs = silentRuns(levels10ms(s, SR), -50);
    expect(runs.map((r) => [r.startMs, r.endMs])).toEqual([[500, 2000], [2500, 2800]]);
    // The 1.5 s gap lies inside a "sentence" spanning 0–2500 ms -> dropout; the 300 ms gap inside the next does not exceed 1000 ms.
    expect(dropouts(runs, [{ startMs: 0, endMs: 2500 }, { startMs: 2500, endMs: 3200 }], 1000)).toEqual([{ startMs: 500, endMs: 2000 }]);
    // The same gap between two sentences (a planned pause) is not a dropout.
    expect(dropouts(runs, [{ startMs: 0, endMs: 500 }, { startMs: 2000, endMs: 3200 }], 1000)).toEqual([]);
    expect(clippedSamples(tone(100, 0.9))).toBe(0);
    const hot = Int16Array.from({ length: 1600 }, (_, i) => Math.max(-32768, Math.min(32767, Math.round(Math.sin((2 * Math.PI * 200 * i) / SR) * 1.2 * 32767))));
    expect(clippedSamples(hot)).toBeGreaterThan(0);
  });
});

describe("consistency checks (pure)", () => {
  const subs = { maxCharsPerLine: 42, maxLines: 2, maxCps: 17, minCueMs: 1000 };
  const segs = [{ segmentId: "seg-01-hook", narration: "Hooks run before tools. They are configured." }, { segmentId: "seg-02-outro", narration: "Thanks for watching." }];
  const track = (): SubtitleTrack => buildSubtitleTrack("en", "canonical", [{ segmentId: "seg-01-hook", text: segs[0]!.narration, startMs: 0, endMs: 4000 }, { segmentId: "seg-02-outro", text: segs[1]!.narration, startMs: 4000, endMs: 6000 }], subs);

  it("caption text must equal the script; mismatches and missing segments are reported", () => {
    expect(captionTextProblems(segs, track())).toEqual([]);
    const t = track();
    t.cues[0]!.lines = ["Something else entirely."];
    expect(captionTextProblems(segs, t)).toEqual(["seg-01-hook captions differ from the approved script text"]);
    expect(captionTextProblems([...segs, { segmentId: "seg-03-takeaway", narration: "x" }], track())).toEqual(["seg-03-takeaway has no caption"]);
  });

  it("caption timing must be ordered and inside the video; out-of-bounds cues fail", () => {
    expect(captionTimingProblems(track(), 6000)).toEqual([]);
    const t = track();
    t.cues.at(-1)!.endMs = 9000;
    expect(captionTimingProblems(t, 6000)[0]).toMatch(/outside the video/);
    const u = track();
    u.cues[1]!.startMs = 0;
    expect(captionTimingProblems(u, 6000).join()).toMatch(/overlaps/);
  });

  it("every narrated sentence needs a cue while spoken; the timing label must be honest", () => {
    const n = { segments: [{ segmentId: "seg-01-hook", sceneId: "scn-01", startMs: 0, endMs: 4000, sentences: [{ index: 0, text: "Hooks run before tools.", startMs: 0, endMs: 2000, speechStartMs: 100, speechEndMs: 1900 }] }] };
    expect(captionCoverageProblems(n, track())).toEqual([]);
    expect(captionCoverageProblems({ segments: [{ ...n.segments[0]!, sentences: [{ ...n.segments[0]!.sentences[0]!, speechStartMs: 7000, speechEndMs: 7500 }] }] }, track())[0]).toMatch(/no caption on screen/);
    expect(captionMethodProblems(false, "estimated", "estimated", "estimated")).toEqual([]);
    expect(captionMethodProblems(true, "estimated", "estimated", undefined)[0]).toMatch(/expected "sentence-aligned"/);
    expect(captionMethodProblems(true, "word-aligned", "word-aligned", undefined).join()).toMatch(/no CreatorFlow component produces word timestamps/);
    expect(captionMethodProblems(true, "sentence-aligned", "estimated", undefined)[0]).toMatch(/render report says/);
  });

  it("line limits fail, except single unbreakable words (warning)", () => {
    const t = track();
    t.cues[0]!.lines = ["a".repeat(50)];
    expect(captionLineProblems(t, subs).fail).toEqual([]);
    expect(captionLineProblems(t, subs).warn).toHaveLength(1);
    t.cues[0]!.lines = ["word ".repeat(12).trim(), "b", "c"];
    expect(captionLineProblems(t, subs).fail).toHaveLength(2);
  });

  it("stale plans and manifests fail; a newer plan version with the same item is accepted", () => {
    const base = { jobId: "2026-w44-x", approved: { weekId: "2026-W44", version: 2, contentHash: "sha256:b" }, itemHash: "sha256:item", report: { jobId: "2026-w44-x", plan: { weekId: "2026-W44", version: 1 } } };
    const script = { jobId: "2026-w44-x", plan: { weekId: "2026-W44", version: 1, contentHash: "sha256:a", itemHash: "sha256:item" } };
    const manifest = { jobId: "2026-w44-x", plan: { weekId: "2026-W44", version: 1, contentHash: "sha256:a", itemHash: "sha256:item" } };
    expect(planProblems({ ...base, script, manifest })).toEqual({ problems: [], notes: ["rendered under plan v1; approved is v2 with this item unchanged"] });
    expect(planProblems({ ...base, itemHash: "sha256:changed", script, manifest }).problems[0]).toMatch(/stale plan/);
    expect(planProblems({ ...base, script, manifest: { ...manifest, plan: { ...manifest.plan, itemHash: "sha256:old" } } }).problems[0]).toMatch(/stale manifest/);
    expect(planProblems({ ...base, script, manifest, report: { jobId: "2026-w44-y", plan: base.report.plan } }).problems[0]).toMatch(/another job/);
  });

  it("required attributions must be drawn; scene order and narration text must match", () => {
    const m = { attributions: [{ sourceId: "src-a", text: "Example, 2026", required: true, sceneIds: ["scn-02"] }], scenes: [{ sceneId: "scn-01", text: { primary: "x" } }, { sceneId: "scn-02", text: { primary: "y", secondary: "Source: Example Tools" } }] } as never;
    const attrs = [{ sourceId: "src-a", title: "Docs", publisher: "Example Tools", usageRestrictions: [], segmentIds: [] }] as never;
    const res = { assets: [] };
    expect(attributionProblems(m, attrs, res, ["scn-01", "scn-02"])).toEqual([]);
    const dropped = { attributions: (m as any).attributions, scenes: [(m as any).scenes[0], { sceneId: "scn-02", text: { primary: "y" } }] } as never;
    expect(attributionProblems(dropped, attrs, res, ["scn-01", "scn-02"])[0]).toMatch(/should show "Source: Example Tools"/);
    expect(attributionProblems(m, attrs, { assets: [{ assetId: "ast-x", kind: "diagram", required: true, status: "resolved", provenance: { origin: "open-license-claim", verification: "unverified", attributionRequired: true } }] } as never, ["scn-01", "scn-02"])[0]).toMatch(/requires attribution/);
    const sc = [{ sceneId: "scn-01", type: "hook-typography", component: "Hook", startFrame: 0, durationInFrames: 30, fallback: "none" as const }, { sceneId: "scn-02", type: "outro", component: "Outro", startFrame: 30, durationInFrames: 30, fallback: "none" as const }];
    const tl = sc.map((s) => ({ sceneId: s.sceneId, startFrame: s.startFrame, durationInFrames: s.durationInFrames }));
    expect(sceneTimelineProblems(sc, [{ sceneId: "scn-01" }, { sceneId: "scn-02" }], tl, 60)).toEqual([]);
    expect(sceneTimelineProblems([sc[1]!, sc[0]!], [{ sceneId: "scn-01" }, { sceneId: "scn-02" }], tl, 60)[0]).toMatch(/order/);
    expect(sceneTimelineProblems(sc, [{ sceneId: "scn-01" }, { sceneId: "scn-02" }], tl, 90).join()).toMatch(/cover 60 frames/);
    const narr = { script: { path: "script/script.json", sha256: "sha256:s" }, segments: [{ segmentId: "seg-01-hook", sceneId: "scn-01", startMs: 0, endMs: 1, sentences: [{ index: 0, text: "Hooks run before tools.", startMs: 0, endMs: 1, speechStartMs: 0, speechEndMs: 1 }, { index: 1, text: "They are configured.", startMs: 0, endMs: 1, speechStartMs: 0, speechEndMs: 1 }] }] };
    expect(narrationTextProblems([segs[0]!], narr, "sha256:s")).toEqual([]);
    expect(narrationTextProblems([segs[0]!], { ...narr, segments: [{ ...narr.segments[0]!, sentences: [narr.segments[0]!.sentences[0]!] }] }, "sha256:s")[0]).toMatch(/differs from the script/);
  });

  it("the verdict never passes with a required failure or an uninspected required check", () => {
    const c = (status: string, required = true) => ({ id: `x.${status.toLowerCase()}`, required, status: status as never, detail: "d" });
    expect(technicalVerdict([c("PASS"), c("NOT_APPLICABLE"), c("NEEDS_REVIEW", false), c("NOT_INSPECTED", false)]).status).toBe("passed");
    expect(technicalVerdict([c("PASS"), c("NOT_INSPECTED")]).status).toBe("blocked");
    expect(technicalVerdict([c("BLOCKED"), c("FAIL")]).status).toBe("failed");
  });
});

describe("media inspection layer (REAL small files from the bundled ffmpeg)", { timeout: 120_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  const cfg = CreatorFlowConfigSchema.parse({ schemaVersion: 1 });
  let ffprobe: NonNullable<Awaited<ReturnType<typeof findFfprobe>>>;
  let ffmpeg: NonNullable<Awaited<ReturnType<typeof findFfmpeg>>>;
  const expected = { width: 320, height: 240, fps: 30, durationInFrames: 60 };
  beforeAll(async () => {
    tmp = await makeTempDir("cf-qa-media-");
    ffprobe = (await findFfprobe(cfg))!;
    ffmpeg = (await findFfmpeg(cfg))!;
    await makeClip(path.join(tmp.dir, "good.mp4"), { width: 320, height: 240, fps: 30, frames: 60, withAudio: true });
  });
  afterAll(() => tmp.cleanup());

  it("a good file: streams match, every frame and the audio decode in one pass, a frame extracts at the right size", async () => {
    const f = path.join(tmp.dir, "good.mp4");
    const mi = await inspectRender(f, expected, ffprobe);
    expect(mi).toMatchObject({ matchesRequest: true, audioStreams: 1, audio: { codec: "aac" } });
    const d = await decodeAll(ffmpeg, f, path.join(tmp.dir, "a.wav"), { timeoutMs: 60_000 });
    expect(d).toMatchObject({ ok: true, frames: 60, errors: [] });
    expect((await fs.stat(path.join(tmp.dir, "a.wav"))).size).toBeGreaterThan(44);
    expect(await extractFrame(ffmpeg, f, seekTimeFor(30, 30), path.join(tmp.dir, "f.png"), {})).toEqual({ ok: true });
    expect(decodePng(await fs.readFile(path.join(tmp.dir, "f.png")))).toMatchObject({ width: 320, height: 240 });
  });

  it("truncated, damaged, wrong-size and video-less files are caught", async () => {
    const good = await fs.readFile(path.join(tmp.dir, "good.mp4"));
    await fs.writeFile(path.join(tmp.dir, "trunc.mp4"), good.subarray(0, Math.floor(good.length * 0.5)));
    const t = await inspectRender(path.join(tmp.dir, "trunc.mp4"), expected, ffprobe);
    expect(t.container.ok).toBe(false);
    const dmg = Buffer.from(good);
    for (let i = Math.floor(dmg.length * 0.3); i < Math.floor(dmg.length * 0.6); i += 5) dmg[i] = 0x5a;
    await fs.writeFile(path.join(tmp.dir, "dmg.mp4"), dmg);
    expect((await inspectRender(path.join(tmp.dir, "dmg.mp4"), expected, ffprobe)).container.ok).toBe(true); // header intact…
    expect((await decodeAll(ffmpeg, path.join(tmp.dir, "dmg.mp4"), undefined, { timeoutMs: 60_000 })).ok).toBe(false); // …but frames do not decode
    await makeMp4(path.join(tmp.dir, "small.mp4"), 160, 120, 30, 60);
    expect((await inspectRender(path.join(tmp.dir, "small.mp4"), expected, ffprobe)).mismatches.join()).toMatch(/160x120, expected 320x240/);
    await makeMp4(path.join(tmp.dir, "short.mp4"), 320, 240, 30, 30);
    expect((await inspectRender(path.join(tmp.dir, "short.mp4"), expected, ffprobe)).mismatches.join()).toMatch(/30 frames, expected 60/);
    const wav = path.join(tmp.dir, "t.wav");
    await fs.writeFile(wav, toneWav(1, 16000, 440));
    const r = await runCommand(remotionFfmpeg(), ["-v", "error", "-y", "-i", wav, "-c:a", "aac", path.join(tmp.dir, "audio-only.mp4")], { timeoutMs: 60_000 });
    expect(r.exitCode).toBe(0);
    expect((await inspectRender(path.join(tmp.dir, "audio-only.mp4"), expected, ffprobe)).mismatches).toEqual(["no video stream"]);
  });

  it("many sequential tool runs sharing one step AbortSignal do not leak abort listeners (no MaxListenersExceededWarning)", async () => {
    const warnings: string[] = [];
    const onWarn = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
    process.on("warning", onWarn);
    try {
      const ac = new AbortController();
      for (let i = 0; i < 15; i++) expect(await extractFrame(ffmpeg, path.join(tmp.dir, "good.mp4"), seekTimeFor(i * 3, 30), path.join(tmp.dir, `l${i}.png`), { signal: ac.signal })).toEqual({ ok: true });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("warning", onWarn);
    }
    expect(warnings.filter((w) => w.includes("MaxListeners"))).toEqual([]);
  });

  it("decoding honours timeouts and cancellation (the ffmpeg child is stopped)", async () => {
    await makeClip(path.join(tmp.dir, "long.mp4"), { width: 640, height: 480, fps: 30, frames: 300 });
    const slow = await decodeAll(ffmpeg, path.join(tmp.dir, "long.mp4"), undefined, { timeoutMs: 1 });
    expect(slow).toMatchObject({ ok: false, timedOut: true });
    const ac = new AbortController();
    const p = decodeAll(ffmpeg, path.join(tmp.dir, "long.mp4"), undefined, { timeoutMs: 60_000, signal: ac.signal });
    ac.abort(new Error("cancelled by test"));
    await expect(p).rejects.toThrow(/cancelled by test/);
  });
});
