// Asset registry and media validation. Media files are REAL (generated locally with the ffmpeg
// bundled with Remotion: coloured bands, no third-party footage); no renderer runs here.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, writeJsonAtomic } from "@creatorflow/core";
import { AssetRegistryV2Schema, CreatorFlowConfigSchema, type AssetRegistryV2 } from "@creatorflow/schemas";
import {
  checkAssetFile,
  DEFAULT_ASSET_LIMITS,
  findFfmpeg,
  findFfprobe,
  imageSize,
  migrateV1,
  mutateRegistry,
  readRegistry,
  recoverRegistry,
  resolveClip,
  slotAccepts,
  sniffContainer,
  type MediaTools,
} from "@creatorflow/video-engine";
import { makeTempDir } from "../helpers.ts";
import { makeClip, makePng } from "../fixtures/media.ts";

const cfg = CreatorFlowConfigSchema.parse({ schemaVersion: 1 });
let tools: MediaTools;
let tmp: Awaited<ReturnType<typeof makeTempDir>>;
let root: string;

beforeAll(async () => {
  tools = { ffprobe: (await findFfprobe(cfg))!, ffmpeg: (await findFfmpeg(cfg))! };
  tmp = await makeTempDir("cf-assets-unit-");
  root = path.join(tmp.dir, "assets");
  await fs.mkdir(root, { recursive: true });
  await makeClip(path.join(root, "clip.mp4"), { width: 320, height: 240, fps: 30, frames: 45, withAudio: true });
  await makeClip(path.join(root, "clip.webm"), { width: 320, height: 180, fps: 25, frames: 25, codec: "libvpx-vp9" });
  await makeClip(path.join(root, "big.mp4"), { width: 640, height: 360, fps: 30, frames: 30 });
}, 120_000);
afterAll(() => tmp.cleanup());

describe("video asset validation (real files)", () => {
  it("measures container, codec, size, fps, duration and audio from the file", async () => {
    const r = await checkAssetFile(root, "clip.mp4", { kind: "screen-recording", tools });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.media).toMatchObject({ kind: "video", mediaType: "video/mp4", width: 320, height: 240, video: { codec: "h264", width: 320, height: 240, fps: 30, rotation: 0, audio: { codec: "aac" } } });
    expect(r.media.video!.durationSec).toBeCloseTo(1.5, 1);
    expect(r.sha256).toBe(`sha256:${sha256Hex(await fs.readFile(path.join(root, "clip.mp4")))}`);
    const w = await checkAssetFile(root, "clip.webm", { kind: "b-roll", tools });
    expect(w).toMatchObject({ ok: true, media: { kind: "video", mediaType: "video/webm", video: { codec: "vp9", audio: null } } });
  });

  it("rejects truncated/corrupt files, mismatched containers, empty files and non-video content", async () => {
    const full = await fs.readFile(path.join(root, "clip.mp4"));
    await fs.writeFile(path.join(root, "trunc.mp4"), full.subarray(0, Math.floor(full.length * 0.6)));
    expect(await checkAssetFile(root, "trunc.mp4", { kind: "b-roll", tools })).toMatchObject({ ok: false, code: "ASSET_INVALID" });
    // Header intact but frame data damaged: only the decode check can see this.
    const damaged = Buffer.from(full);
    for (let i = 2000; i < Math.min(9000, damaged.length - 2000); i += 7) damaged[i] = 0xab;
    await fs.writeFile(path.join(root, "damaged.mp4"), damaged);
    expect(await checkAssetFile(root, "damaged.mp4", { kind: "b-roll", tools })).toMatchObject({ ok: false, code: "ASSET_INVALID", message: expect.stringContaining("does not decode cleanly") });
    await fs.copyFile(path.join(root, "clip.webm"), path.join(root, "webm-named.mp4"));
    expect(await checkAssetFile(root, "webm-named.mp4", { kind: "b-roll", tools })).toMatchObject({ ok: false, code: "ASSET_INVALID", message: expect.stringContaining("does not match its extension") });
    await fs.writeFile(path.join(root, "text.mp4"), "hello, definitely not a video");
    expect(await checkAssetFile(root, "text.mp4", { kind: "b-roll", tools })).toMatchObject({ ok: false, code: "ASSET_INVALID", message: expect.stringContaining("not an MP4/MOV") });
    await fs.writeFile(path.join(root, "empty.mp4"), "");
    expect(await checkAssetFile(root, "empty.mp4", { kind: "b-roll", tools })).toMatchObject({ ok: false, message: expect.stringContaining("empty") });
    // A PNG cannot fill a video slot, and a video cannot fill an image slot.
    await fs.writeFile(path.join(root, "still.png"), makePng(8, 8));
    expect(await checkAssetFile(root, "still.png", { kind: "screen-recording", tools })).toMatchObject({ ok: false, code: "UNSUPPORTED_ASSET_TYPE" });
    expect(await checkAssetFile(root, "clip.mp4", { kind: "diagram", tools })).toMatchObject({ ok: false, code: "UNSUPPORTED_ASSET_TYPE", message: expect.stringContaining("is a video") });
  });

  it("enforces configured limits (codec, size, resolution, duration) and never truncates", async () => {
    const L = DEFAULT_ASSET_LIMITS;
    expect(await checkAssetFile(root, "clip.webm", { kind: "b-roll", tools, limits: { ...L, videoCodecs: ["h264"] } })).toMatchObject({ ok: false, code: "UNSUPPORTED_ASSET_TYPE", message: expect.stringContaining("vp9") });
    expect(await checkAssetFile(root, "big.mp4", { kind: "b-roll", tools, limits: { ...L, maxVideoWidth: 320, maxVideoHeight: 240 } })).toMatchObject({ ok: false, code: "ASSET_LIMIT_EXCEEDED" });
    expect(await checkAssetFile(root, "clip.mp4", { kind: "b-roll", tools, limits: { ...L, maxVideoDurationSec: 1 } })).toMatchObject({ ok: false, code: "ASSET_LIMIT_EXCEEDED", message: expect.stringContaining("does not truncate") });
    expect(await checkAssetFile(root, "clip.mp4", { kind: "b-roll", tools, limits: { ...L, maxVideoBytes: 1024 } })).toMatchObject({ ok: false, code: "ASSET_LIMIT_EXCEEDED" });
    expect(await checkAssetFile(root, "clip.mp4", { kind: "b-roll", tools: null })).toMatchObject({ ok: false, code: "MEDIA_TOOLS_UNAVAILABLE" });
    expect(await checkAssetFile(root, "clip.mp4", { kind: "b-roll", tools, limits: { ...L, decodeCheck: "sample" } })).toMatchObject({ ok: true });
  });

  it("rejects traversal, hash mismatch and symlinks", async () => {
    expect(await checkAssetFile(root, "../outside.mp4", { kind: "b-roll", tools })).toMatchObject({ ok: false, code: "ASSET_INVALID", message: expect.stringContaining("escapes") });
    expect(await checkAssetFile(root, "clip.mp4", { kind: "b-roll", tools, expectedSha256: `sha256:${"0".repeat(64)}` })).toMatchObject({ ok: false, code: "ASSET_INVALID", message: expect.stringContaining("does not match the registered") });
    try {
      await fs.symlink(path.join(root, "clip.mp4"), path.join(root, "link.mp4"), "file");
      expect(await checkAssetFile(root, "link.mp4", { kind: "b-roll", tools })).toMatchObject({ ok: false, message: expect.stringContaining("symbolic") });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
    }
  });

  it("clip windows are validated against the measured duration, not clamped", () => {
    expect(resolveClip(undefined, 4, 30)).toEqual({ ok: true, clip: { startSec: 0, endSec: 4, fit: "contain" } });
    expect(resolveClip({ startSec: 1, endSec: 3, fit: "cover" }, 4, 30)).toEqual({ ok: true, clip: { startSec: 1, endSec: 3, fit: "cover" } });
    expect(resolveClip({ startSec: 4, fit: "contain" }, 4, 30)).toMatchObject({ ok: false, message: expect.stringContaining("at or after the end") });
    expect(resolveClip({ startSec: 0, endSec: 5, fit: "contain" }, 4, 30)).toMatchObject({ ok: false, message: expect.stringContaining("after the end") });
    expect(resolveClip({ startSec: 1, endSec: 1.1, fit: "contain" }, 4, 30)).toMatchObject({ ok: false, message: expect.stringContaining("shorter than 0.2") });
    expect(slotAccepts("screen-recording", "b-roll")).toBe(true);
    expect(slotAccepts("diagram", "screen-recording")).toBe(false);
    expect(slotAccepts("screen-recording", "screenshot")).toBe(false);
  });

  it("reads image dimensions from PNG/JPEG/WebP headers and sniffs containers from bytes", () => {
    expect(imageSize(makePng(31, 17), "image/png")).toEqual({ width: 31, height: 17 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 64, height: 32 });
    expect(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]), "image/png")).toBeUndefined();
    expect(sniffContainer(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe("iso-bmff");
    expect(sniffContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe("matroska");
    expect(sniffContainer(Buffer.from("RIFF...."))).toBeUndefined();
  });
});

describe("registry store: crash-safe writes, conflicts, corruption and migration", () => {
  let ws: string;
  const now = () => new Date("2026-10-23T10:00:00.000Z");
  const measure = async () => undefined;
  beforeEach(async () => {
    ws = path.join(tmp.dir, `ws-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(ws, "assets"), { recursive: true });
  });
  const entry = (id: string, p: string, h: string) => ({
    id,
    type: "diagram" as const,
    path: p,
    bytes: 10,
    sha256: `sha256:${h.repeat(64)}`,
    media: { kind: "image" as const, mediaType: "image/png", width: 1, height: 1 },
    provenance: { origin: "user-created" as const, attributionRequired: false, verification: "unverified" as const },
    registeredAt: now().toISOString(),
    updatedAt: now().toISOString(),
    uses: [],
  });

  it("writes atomically with a revision and a .prev backup; schema refuses duplicates and video/type mismatches", async () => {
    await mutateRegistry(ws, { purpose: "t", now, measure }, (r) => void r.assets.push(entry("ast-a", "a.png", "a")));
    await mutateRegistry(ws, { purpose: "t", now, measure }, (r) => void r.assets.push(entry("ast-b", "b.png", "b")));
    const l = await readRegistry(ws);
    expect(l).toMatchObject({ status: "ok", registry: { schemaVersion: 2, revision: 2 } });
    const prev = JSON.parse(await fs.readFile(path.join(ws, "assets", "registry.prev.json"), "utf8")) as AssetRegistryV2;
    expect(prev.revision).toBe(1);
    await expect(mutateRegistry(ws, { purpose: "t", now, measure }, (r) => void r.assets.push(entry("ast-a", "c.png", "c")))).rejects.toMatchObject({ code: "REGISTRY_INVALID" });
    await expect(mutateRegistry(ws, { purpose: "t", now, measure }, (r) => void r.assets.push(entry("ast-c", "A.PNG", "c")))).rejects.toMatchObject({ code: "REGISTRY_INVALID" });
    const bad = { ...entry("ast-v", "v.png", "d"), type: "b-roll" as const };
    expect(AssetRegistryV2Schema.safeParse({ schemaVersion: 2, kind: "asset-registry", revision: 0, assets: [bad] }).success).toBe(false);
    expect((await readRegistry(ws) as { registry: AssetRegistryV2 }).registry.revision).toBe(2); // failed writes changed nothing
  });

  it("detects a concurrent edit (compare-and-swap) and serialises parallel writers with a lock", async () => {
    await mutateRegistry(ws, { purpose: "t", now, measure }, (r) => void r.assets.push(entry("ast-a", "a.png", "a")));
    await expect(
      mutateRegistry(ws, { purpose: "t", now, measure }, async (r) => {
        // Someone edits the file by hand while the command runs.
        await fs.writeFile(path.join(ws, "assets", "registry.json"), JSON.stringify({ schemaVersion: 2, kind: "asset-registry", revision: 9, assets: [] }));
        r.assets.push(entry("ast-b", "b.png", "b"));
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_CONFLICT", exitCode: 5 });
    const ws2 = path.join(tmp.dir, "ws-par");
    await fs.mkdir(path.join(ws2, "assets"), { recursive: true });
    await Promise.all(["a", "b", "c", "d", "e"].map((h) => mutateRegistry(ws2, { purpose: "par", now, measure }, (r) => void r.assets.push(entry(`ast-${h}`, `${h}.png`, h)))));
    const l = await readRegistry(ws2);
    expect(l.status === "ok" && l.registry.schemaVersion === 2 && l.registry.assets.length).toBe(5);
    expect(l.status === "ok" && l.registry.schemaVersion === 2 && l.registry.revision).toBe(5);
  });

  it("never overwrites a corrupt registry; recover restores the backup and keeps the corrupt copy", async () => {
    await mutateRegistry(ws, { purpose: "t", now, measure }, (r) => void r.assets.push(entry("ast-a", "a.png", "a")));
    await mutateRegistry(ws, { purpose: "t", now, measure }, (r) => void r.assets.push(entry("ast-b", "b.png", "b")));
    await fs.writeFile(path.join(ws, "assets", "registry.json"), '{"schemaVersion": 2, "kind": "asset-reg');
    expect(await readRegistry(ws)).toMatchObject({ status: "corrupt", backup: "valid" });
    await expect(mutateRegistry(ws, { purpose: "t", now, measure }, () => undefined)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT", hint: expect.stringContaining("assets recover") });
    const r = await recoverRegistry(ws, now);
    expect(r).toMatchObject({ status: "recovered", revision: 1 });
    const names = await fs.readdir(path.join(ws, "assets"));
    expect(names.some((n) => n.startsWith("registry.json.corrupt-"))).toBe(true);
    expect(await readRegistry(ws)).toMatchObject({ status: "ok", registry: { revision: 1 } });
    expect(await recoverRegistry(ws, now)).toEqual({ status: "valid" });
  });

  it("migrates a Stage F registry: one entry per file, uses kept, provenance unknown and unverified", async () => {
    const png = makePng(4, 4);
    const v1 = {
      schemaVersion: 1 as const,
      kind: "asset-registry" as const,
      assets: [
        { jobId: "2026-w44-a", assetId: "ast-scn-03-diagram", path: "d.png", sha256: `sha256:${sha256Hex(png)}`, license: "own work", attribution: "By me" },
        { jobId: "2026-w44-b", assetId: "ast-scn-02-diagram", path: "d.png", sha256: `sha256:${sha256Hex(png)}`, license: "own work", source: "https://example.com/x" },
      ],
    };
    const v2 = await migrateV1(v1, async () => ({ bytes: png.length, media: { kind: "image", mediaType: "image/png", width: 4, height: 4 } }), now().toISOString());
    expect(v2.assets).toHaveLength(1);
    expect(v2.assets[0]).toMatchObject({ id: "ast-d", type: "diagram", uses: [{ jobId: "2026-w44-a", assetId: "ast-scn-03-diagram" }, { jobId: "2026-w44-b", assetId: "ast-scn-02-diagram" }], provenance: { origin: "unknown", license: "own work", verification: "unverified", attribution: "By me", attributionRequired: true } });
    expect(AssetRegistryV2Schema.safeParse(v2).success).toBe(true);
    await writeJsonAtomic(path.join(ws, "assets", "registry.json"), v1);
    const res = await mutateRegistry(ws, { purpose: "t", now, measure: async () => undefined }, () => undefined);
    expect(res.migrated).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(ws, "assets", "registry.v1.json"), "utf8"))).toEqual(v1);
    await expect(migrateV1({ ...v1, assets: [v1.assets[0]!, { ...v1.assets[1]!, sha256: `sha256:${"9".repeat(64)}` }] }, measure, "x")).rejects.toMatchObject({ code: "REGISTRY_INVALID" });
  });
});
