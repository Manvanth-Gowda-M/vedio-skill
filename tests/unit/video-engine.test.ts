// Unit tests for the render engine's pure parts. No Remotion and no browser are involved here.
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, runProcess, sha256Hex } from "@creatorflow/core";
import { captionAt, contrastRatio, headlineSize, SCENE_COMPONENTS, UNSUPPORTED_SCENES } from "@creatorflow/remotion-studio";
import { SceneType, type AssetResolution, type SceneManifest } from "@creatorflow/schemas";
import {
  buildRenderProps,
  checkAssetFile,
  fontCodePoints,
  fontsourceDir,
  inspectMp4Container,
  mapScenes,
  missingGlyphs,
  requiredCodePoints,
  resolveFont,
  unicodeRange,
} from "@creatorflow/video-engine";
import { makeTempDir } from "../helpers.ts";
import { makePng } from "../fixtures/media.ts";

const interLatin = () => readFileSync(path.join(fontsourceDir("Inter")!, "files", "inter-latin-400-normal.woff"));

describe("font glyph coverage (read from the font's cmap)", () => {
  it("parses WOFF cmaps and reports coverage per character", () => {
    const cps = fontCodePoints(interLatin());
    expect(cps.has("A".codePointAt(0)!)).toBe(true);
    expect(cps.has(0x2026)).toBe(true); // …
    expect(cps.has(0x0915)).toBe(false); // क
    expect(unicodeRange(new Set([0x41, 0x42, 0x43, 0x45]))).toBe("U+41-43,U+45");
  });

  it("finds missing glyphs for Indic text and ignores whitespace, controls and ZWJ/ZWNJ", async () => {
    const r = await resolveFont("body", { family: "Inter", source: "google-fonts", license: "OFL-1.1" }, ".");
    if (!r.ok) throw new Error(r.message);
    expect(missingGlyphs(r.files, requiredCodePoints(["Hooks run before and after each tool call.", "Привет", "Ελληνικά"]))).toEqual([]);
    const need = requiredCodePoints(["ಕನ್ನಡ\u200Cಟೆಸ್ಟ್ \n\t", "हिंदी"]);
    expect(need.has(0x200c)).toBe(false);
    const missing = missingGlyphs(r.files, need);
    expect(missing).toEqual(expect.arrayContaining(["ಕ U+0C95", "ह U+0939"]));
  });

  it("checks text after NFC normalisation and requires every combining mark (matras, virama) separately", async () => {
    // "é" typed decomposed (e + U+0301) is checked as the precomposed U+00E9 that NFC produces.
    const nfd = "Cafe\u0301";
    const need = requiredCodePoints([nfd]);
    expect(need.has(0xe9)).toBe(true);
    expect(need.has(0x301)).toBe(false);
    // Devanagari: consonants, the vowel sign ि (U+093F) and the virama ् (U+094D) each need a glyph;
    // ZWJ/ZWNJ (format characters that steer shaping) are excluded from the glyph check.
    const hi = requiredCodePoints(["कि\u094D\u200Dष"]);
    for (const cp of [0x915, 0x93f, 0x94d, 0x937]) expect(hi.has(cp)).toBe(true);
    expect(hi.has(0x200d)).toBe(false);
    const r = await resolveFont("body", { family: "Inter", source: "google-fonts", license: "OFL-1.1" }, ".");
    if (!r.ok) throw new Error(r.message);
    expect(missingGlyphs(r.files, requiredCodePoints([nfd]))).toEqual([]);
    expect(missingGlyphs(r.files, hi).map((m) => m.split(" ")[1])).toEqual(expect.arrayContaining(["U+093F", "U+094D"]));
    // Coverage is necessary, not sufficient: correct conjunct shaping is NOT proven by this check
    // (see skills/creatorflow/references/rendering.md, "Indian-language scripts").
  });

  it("rejects fonts whose coverage cannot be verified, and never downloads", async () => {
    expect(await resolveFont("heading", { family: "Arial", source: "system", license: "x" }, ".")).toMatchObject({ ok: false, code: "FONT_UNVERIFIABLE" });
    expect(await resolveFont("heading", { family: "Nope Sans", source: "google-fonts", license: "x" }, ".")).toMatchObject({ ok: false, code: "FONT_UNAVAILABLE" });
    expect(await resolveFont("heading", { family: "X", source: "local-file", license: "x", path: "brand/x.woff2" }, ".")).toMatchObject({ ok: false, code: "FONT_UNVERIFIABLE" });
    expect(() => fontCodePoints(Buffer.from("wOF2xxxxxxxxxxxxxxxxxxxx"))).toThrow(/WOFF2/);
  });
});

function box(type: string, payload = 0): Buffer {
  const b = Buffer.alloc(8 + payload);
  b.writeUInt32BE(8 + payload, 0);
  b.write(type, 4, "latin1");
  return b;
}

describe("MP4 container check", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => (tmp = await makeTempDir()));
  afterEach(() => tmp.cleanup());
  const write = async (b: Buffer) => {
    const f = path.join(tmp.dir, "v.mp4");
    await fs.writeFile(f, b);
    return f;
  };

  it("accepts ftyp + moov + mdat that tile the file", async () => {
    expect(await inspectMp4Container(await write(Buffer.concat([box("ftyp", 8), box("moov", 16), box("mdat", 32)])))).toEqual({ ok: true, boxes: ["ftyp", "moov", "mdat"] });
  });

  it.each([
    ["missing moov", Buffer.concat([box("ftyp", 8), box("mdat", 32)]), "missing moov"],
    ["truncated (mdat overruns)", Buffer.concat([box("ftyp", 8), box("moov", 8), box("mdat", 64)]).subarray(0, 40), "overruns"],
    ["not starting with ftyp", Buffer.concat([box("moov", 8), box("ftyp", 8), box("mdat", 8)]), "ftyp"],
    ["text file", Buffer.from("hello, this is definitely not a video"), "box"],
  ])("rejects %s", async (_l, buf, msg) => {
    const r = await inspectMp4Container(await write(buf));
    expect(r.ok).toBe(false);
    expect(r.problem).toContain(msg);
  });
});

describe("asset file checks", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => (tmp = await makeTempDir()));
  afterEach(() => tmp.cleanup());

  it("accepts a real PNG with the registered hash; rejects hash, type, traversal, symlink, video and empty files", async () => {
    const png = makePng(8, 8);
    await fs.writeFile(path.join(tmp.dir, "a.png"), png);
    expect(await checkAssetFile(tmp.dir, "a.png", { kind: "diagram", expectedSha256: `sha256:${sha256Hex(png)}` })).toMatchObject({ ok: true, mediaType: "image/png" });
    expect(await checkAssetFile(tmp.dir, "a.png", { kind: "diagram", expectedSha256: `sha256:${"0".repeat(64)}` })).toMatchObject({ ok: false, code: "ASSET_INVALID" });
    await fs.writeFile(path.join(tmp.dir, "fake.jpg"), png);
    expect(await checkAssetFile(tmp.dir, "fake.jpg", { kind: "screenshot" })).toMatchObject({ ok: false, message: expect.stringContaining("image/jpeg") });
    expect(await checkAssetFile(tmp.dir, "../outside.png", { kind: "diagram" })).toMatchObject({ ok: false, code: "ASSET_INVALID" });
    expect(await checkAssetFile(tmp.dir, "missing.png", { kind: "diagram" })).toMatchObject({ ok: false, code: "ASSET_MISSING" });
    expect(await checkAssetFile(tmp.dir, "a.png", { kind: "screen-recording" })).toMatchObject({ ok: false, code: "UNSUPPORTED_ASSET_TYPE" });
    await fs.writeFile(path.join(tmp.dir, "e.png"), "");
    expect(await checkAssetFile(tmp.dir, "e.png", { kind: "diagram" })).toMatchObject({ ok: false, message: expect.stringContaining("empty") });
    await fs.writeFile(path.join(tmp.dir, "code.txt"), "npm run creatorflow -- doctor\n");
    expect(await checkAssetFile(tmp.dir, "code.txt", { kind: "code-snippet" })).toMatchObject({ ok: true, mediaType: "text/plain" });
    expect(await checkAssetFile(tmp.dir, "code.txt", { kind: "diagram" })).toMatchObject({ ok: false, code: "UNSUPPORTED_ASSET_TYPE" });
    try {
      await fs.symlink(path.join(tmp.dir, "a.png"), path.join(tmp.dir, "link.png"), "file");
      expect(await checkAssetFile(tmp.dir, "link.png", { kind: "diagram" })).toMatchObject({ ok: false, message: expect.stringContaining("symbolic") });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; // symlinks need privileges on some Windows setups
    }
  });
});

const manifestScene = (i: number, type: string, assetIds: string[] = [], frames = 60): SceneManifest["scenes"][number] => ({
  sceneId: `scn-0${i}`,
  type: type as SceneManifest["scenes"][number]["type"],
  startFrame: (i - 1) * frames,
  durationInFrames: frames,
  segmentIds: [`seg-0${i}-hook`],
  text: { primary: `Scene ${i} text`, secondary: "Source: Example" },
  captionCueIds: [],
  assetIds,
  attributionSourceIds: [],
  motion: { intent: "reveal", intensity: "medium", transitionIn: "fade" },
  safeArea: { top: 0.1, bottom: 0.2, left: 0.06, right: 0.06 },
});

describe("scene mapping and props", () => {
  it("every manifest scene type is either mapped to a component or explicitly unsupported", () => {
    for (const t of SceneType.options) expect(Boolean(SCENE_COMPONENTS[t]) !== Boolean(UNSUPPORTED_SCENES[t])).toBe(true);
  });

  const res = (assets: AssetResolution["assets"]): AssetResolution => ({ schemaVersion: 1, kind: "asset-resolution", contentId: "x", manifest: { path: "script/scene-manifest.json", sha256: `sha256:${"a".repeat(64)}` }, assets, fonts: [], narration: { mode: "none", audio: "none" }, warnings: [] });

  it("rejects unresolved required media (including a screen-capture without a validated video); records text-only fallbacks", () => {
    const m = { scenes: [manifestScene(1, "hook-typography"), manifestScene(2, "screen-capture", ["ast-scn-02-screen-recording"]), manifestScene(3, "source-quote", ["ast-scn-03-screenshot"])] } as SceneManifest;
    const r = mapScenes(m, res([
      { assetId: "ast-scn-02-screen-recording", kind: "screen-recording", required: true, status: "text-only-fallback" },
      { assetId: "ast-scn-03-screenshot", kind: "screenshot", required: false, status: "text-only-fallback" },
    ]));
    expect(r.ok).toBe(false);
    // Stage G: screen-capture has a component, but never renders without its registered video.
    expect(r.problems.join(" ")).toMatch(/scn-02: required asset ast-scn-02-screen-recording is not resolved.*scn-02: screen-capture needs a registered, validated video/);
    expect(r.scenes.map((s) => [s.component, s.fallback])).toEqual([["Hook", "none"], ["ScreenCapture", "text-only"], ["Quote", "text-only"]]);
  });

  it("builds ordered props with frame-accurate, non-overlapping captions and verbatim text", () => {
    const scenes = [manifestScene(1, "hook-typography"), manifestScene(2, "concept-explanation")];
    const inputs = {
      manifest: { scenes, narration: { language: "hi-IN" }, brand: { name: "B", colors: { primary: "#111111", secondary: "#222222", accent: "#333333", background: "#000000", text: "#FFFFFF" } } } as unknown as SceneManifest,
      captions: { tracks: [{ language: "hi-IN", cues: [{ startMs: 0, endMs: 1990, lines: ["पहली पंक्ति", "दूसरी"] }, { startMs: 1980, endMs: 3600, lines: ["तीसरी"] }] }] } as never,
      resolution: { ...res([]), fonts: (["heading", "body", "mono"] as const).map((slot) => ({ slot, family: "Inter", source: "google-fonts", license: "OFL-1.1", files: [{ root: "fontsource" as const, path: "inter/files/x.woff", sha256: `sha256:${"b".repeat(64)}`, weight: 400, unicodeRange: "U+0-FF" }], coverage: "verified" as const, checkedCharacters: 1 })) },
      refs: {} as never,
    };
    const request = { format: { width: 1080, height: 1920, fps: 30, durationInFrames: 120 }, settings: { captions: "burn-in" }, scenes: scenes.map((s) => ({ sceneId: s.sceneId, component: SCENE_COMPONENTS[s.type], fallback: "none" })) } as never;
    const { props, files } = buildRenderProps(inputs, request, () => "/root", () => undefined);
    expect(props.scenes.map((s) => [s.sceneId, s.component, s.startFrame, s.durationInFrames, s.index, s.total])).toEqual([["scn-01", "Hook", 0, 60, 0, 2], ["scn-02", "Explanation", 60, 60, 1, 2]]);
    expect(props.captions).toEqual([{ startFrame: 0, endFrame: 59, lines: ["पहली पंक्ति", "दूसरी"] }, { startFrame: 59, endFrame: 108, lines: ["तीसरी"] }]);
    expect(props.captionsTiming).toBe("estimated");
    expect(props.brand.fonts.heading.faces[0]!.file).toMatch(/^fonts\/heading-400-b{16}\.woff$/);
    expect(new Set(files.map((f) => f.name)).size).toBe(files.length);
    expect(JSON.stringify(props)).not.toMatch(/function|=>/);
  });

  it("layout helpers: captions per frame, WCAG contrast, bounded type sizes", () => {
    const caps = [{ startFrame: 0, endFrame: 30, lines: ["a"] }, { startFrame: 30, endFrame: 60, lines: ["b"] }];
    expect(captionAt(caps, 29)!.lines).toEqual(["a"]);
    expect(captionAt(caps, 30)!.lines).toEqual(["b"]);
    expect(captionAt(caps, 60)).toBeUndefined();
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
    expect(contrastRatio("#F5F7FA", "#0B0D12")).toBeGreaterThan(15);
    expect(contrastRatio("#777777", "#888888")).toBeLessThan(1.5);
    expect(headlineSize("Short", 1080, 1920, "hook")).toBeGreaterThan(headlineSize("A much longer sentence that keeps going and going for quite a while", 1080, 1920, "hook"));
    expect(headlineSize("x", 1920, 1080, "body")).toBe(headlineSize("x", 1080, 1920, "body"));
  });
});

describe("runProcess (used for the render worker)", () => {
  it("kills the whole process tree on abort, and on timeout", async () => {
    const t = await makeTempDir();
    try {
      for (const how of ["abort", "timeout"] as const) {
        const pidFile = path.join(t.dir, `${how}.pid`);
        const script = `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
        const ac = new AbortController();
        const run = runProcess(process.execPath, ["-e", script], how === "abort" ? { signal: ac.signal } : { timeoutMs: 1500 });
        for (let i = 0; i < 200 && !(await fs.stat(pidFile).catch(() => undefined)); i++) await new Promise((r) => setTimeout(r, 25));
        const grandchild = Number(await fs.readFile(pidFile, "utf8"));
        if (how === "abort") ac.abort();
        const r = await run;
        expect(r.errorCode).toBe(how === "abort" ? "ABORTED" : "TIMEOUT");
        for (let i = 0; i < 100 && isProcessAlive(grandchild); i++) await new Promise((res) => setTimeout(res, 50));
        expect(isProcessAlive(grandchild)).toBe(false);
      }
    } finally {
      await t.cleanup();
    }
  });

  it("reports exit codes, missing executables and keeps only an output tail", async () => {
    expect((await runProcess(process.execPath, ["-e", "process.exit(4)"])).exitCode).toBe(4);
    expect((await runProcess("definitely-not-here-cf", [])).errorCode).toBe("ENOENT");
    const big = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000))"]);
    expect(big.stdout.length).toBe(64 * 1024);
    const lines: string[] = [];
    await runProcess(process.execPath, ["-e", "console.log('a');console.log('b')"], { onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(["a", "b"]);
  });
});
