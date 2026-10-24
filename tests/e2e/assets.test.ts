// End-to-end: the real CLI launcher in child processes, a real project and REAL media files
// generated locally (no third-party content). Covers registration, provenance, duplicates, path
// safety, validation after tampering, reference-protected removal, registry recovery, Stage F
// registry migration and the voice commands. Windows SAPI is used only when it is available.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, writeJsonAtomic } from "@creatorflow/core";
import { AssetRegistryV2Schema } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { makeClip, makePng } from "../fixtures/media.ts";
import { setupProject, type FixtureProject } from "../workflow-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = path.join(repoRoot, "packages", "cli", "bin", "creatorflow.js");
interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
const cli = (args: string[]): Promise<Run> =>
  new Promise((resolve) =>
    execFile(process.execPath, [launcher, ...args], { windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0, stdout, stderr });
    }),
  );
const json = (r: Run) => JSON.parse(r.stdout) as Record<string, any>;

describe("assets and voice CLI (e2e, real processes, real media)", { timeout: 300_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  let A: string;
  const C = () => ["-C", p.dir];
  beforeAll(async () => {
    tmp = await makeTempDir("cf-e2e-assets-");
    p = await setupProject(tmp.dir);
    A = path.join(p.ws, "assets");
    await fs.mkdir(path.join(A, "img"), { recursive: true });
    await fs.writeFile(path.join(A, "img", "flow.png"), makePng(320, 180, [[255, 255, 255], [20, 90, 200]]));
    await makeClip(path.join(A, "rec.mp4"), { width: 320, height: 240, fps: 30, frames: 60, withAudio: true });
  }, 120_000);
  afterAll(() => tmp.cleanup());

  it("registers real files with measured media and provenance-as-claimed; refuses duplicates, unsafe paths and wrong content", async () => {
    const img = await cli([...C(), "--json", "assets", "register", "--file", path.join(A, "img", "flow.png"), "--type", "diagram", "--origin", "user-created", "--license", "CC-BY-4.0", "--attribution", "Diagram: Fixture", "--attest"]);
    expect(img.code, img.stderr).toBe(0);
    expect(json(img).asset).toMatchObject({ id: "ast-flow", type: "diagram", path: "img/flow.png", media: { kind: "image", width: 320, height: 180 }, provenance: { origin: "user-created", license: "CC-BY-4.0", verification: "user-attested", attributionRequired: false } });

    const vid = await cli([...C(), "--json", "assets", "register", "--file", path.join(A, "rec.mp4"), "--type", "screen-recording", "--source-url", "https://example.com/never-fetched"]);
    expect(vid.code, vid.stderr).toBe(0);
    expect(json(vid).asset).toMatchObject({ id: "ast-rec", media: { kind: "video", video: { codec: "h264", width: 320, height: 240, fps: 30, audio: { codec: "aac" } } }, provenance: { origin: "unknown", verification: "unverified", sourceUrl: "https://example.com/never-fetched" } });
    expect(vid.stderr).toContain("licence unknown");

    // Same bytes under another name: duplicate, exit 5, pointing at the existing id.
    await fs.copyFile(path.join(A, "rec.mp4"), path.join(A, "rec-copy.mp4"));
    const dup = await cli([...C(), "--json", "assets", "register", "--file", path.join(A, "rec-copy.mp4"), "--type", "b-roll"]);
    expect(dup.code).toBe(5);
    expect(json(dup)).toMatchObject({ error: "ASSET_DUPLICATE", details: { id: "ast-rec" } });

    // Outside workspace/assets, or traversing out of it: exit 4, nothing copied.
    const outside = path.join(tmp.dir, "outside.png");
    await fs.writeFile(outside, makePng(4, 4));
    expect((await cli([...C(), "assets", "register", "--file", outside, "--type", "diagram"])).code).toBe(4);
    expect((await cli([...C(), "assets", "register", "--file", path.join(A, "..", "..", "creatorflow.config.json"), "--type", "other"])).code).toBe(4);
    // Wrong content for the declared type / extension: exit 1 with the reason.
    await fs.writeFile(path.join(A, "fake.png"), "GIF89a not a png");
    const fake = await cli([...C(), "--json", "assets", "register", "--file", path.join(A, "fake.png"), "--type", "screenshot"]);
    expect(fake.code).toBe(1);
    expect(json(fake).message).toContain("does not contain image/png data");
    const asImage = await cli([...C(), "--json", "assets", "register", "--file", path.join(A, "rec.mp4"), "--type", "diagram"]);
    expect([1, 5]).toContain(asImage.code); // video content is never accepted as an image (or is a duplicate)
    await fs.writeFile(path.join(A, "notes.docx"), "x");
    expect((await cli([...C(), "assets", "register", "--file", path.join(A, "notes.docx"), "--type", "other"])).code).toBe(1);
    expect((await cli([...C(), "assets", "register", "--file", path.join(A, "missing.png"), "--type", "diagram"])).code).toBe(6);
    expect((await cli([...C(), "assets", "register", "--file", path.join(A, "img", "flow.png"), "--type", "nope"])).code).toBe(2);
    expect((await cli([...C(), "assets", "register", "--file", path.join(A, "rec-copy.mp4"), "--type", "b-roll", "--origin", "open-license-claim"])).code).toBe(2); // needs --license
    try {
      await fs.symlink(path.join(A, "img", "flow.png"), path.join(A, "link.png"), "file");
      expect((await cli([...C(), "assets", "register", "--file", path.join(A, "link.png"), "--type", "diagram"])).code).toBe(4);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
    }

    const list = json(await cli([...C(), "--json", "assets", "list"]));
    expect(list.assets.map((a: any) => a.id)).toEqual(["ast-flow", "ast-rec"]);
    const reg = AssetRegistryV2Schema.parse(JSON.parse(await fs.readFile(path.join(A, "registry.json"), "utf8")));
    expect(reg.revision).toBe(2);
  });

  it("updates keep the id and history; tampering is detected; removal is refused while used and never deletes the file", async () => {
    const upd = await cli([...C(), "--json", "assets", "update", "--id", "ast-rec", "--license", "own recording", "--origin", "user-created", "--use", "2026-w44-topic-1:ast-scn-02-screen-recording", "--start", "0.25", "--end", "1.5", "--fit", "cover"]);
    expect(upd.code, upd.stdout + upd.stderr).toBe(0);
    expect(json(upd).asset).toMatchObject({ id: "ast-rec", uses: [{ jobId: "2026-w44-topic-1", assetId: "ast-scn-02-screen-recording", clip: { startSec: 0.25, endSec: 1.5, fit: "cover" } }], provenance: { license: "own recording" } });
    expect(json(upd).slotCheck).toMatchObject({ found: false });
    const badTrim = await cli([...C(), "--json", "assets", "update", "--id", "ast-rec", "--use", "2026-w44-topic-1:ast-scn-02-screen-recording", "--end", "9"]);
    expect(badTrim.code).toBe(1);
    expect(json(badTrim).error).toBe("CLIP_INVALID");
    const taken = await cli([...C(), "--json", "assets", "update", "--id", "ast-flow", "--use", "2026-w44-topic-1:ast-scn-02-screen-recording"]);
    expect(taken.code).toBe(5);
    expect(json(taken).error).toBe("SLOT_TAKEN");

    expect((await cli([...C(), "assets", "validate"])).code).toBe(0);
    const png = path.join(A, "img", "flow.png");
    const orig = await fs.readFile(png);
    await fs.writeFile(png, makePng(320, 180, [[0, 0, 0]]));
    const v = await cli([...C(), "--json", "assets", "validate"]);
    expect(v.code).toBe(1);
    expect(json(v).results.find((r: any) => r.id === "ast-flow").problems[0]).toContain("does not match the registered");
    expect((await cli([...C(), "--json", "assets", "inspect", "--id", "ast-flow"])).code).toBe(1);
    const refresh = await cli([...C(), "--json", "assets", "update", "--id", "ast-flow", "--refresh"]);
    expect(refresh.code).toBe(0);
    expect(json(refresh).asset.sha256).toBe(`sha256:${sha256Hex(await fs.readFile(png))}`);
    expect(json(refresh).asset.id).toBe("ast-flow");
    await fs.writeFile(png, orig);
    expect((await cli([...C(), "assets", "update", "--id", "ast-flow", "--refresh"])).code).toBe(0);

    const inUse = await cli([...C(), "--json", "assets", "remove", "--id", "ast-rec"]);
    expect(inUse.code).toBe(5);
    expect(json(inUse)).toMatchObject({ error: "ASSET_IN_USE" });
    expect((await cli([...C(), "assets", "update", "--id", "ast-rec", "--unuse", "2026-w44-topic-1:ast-scn-02-screen-recording"])).code).toBe(0);
    const rm = await cli([...C(), "--json", "assets", "remove", "--id", "ast-rec"]);
    expect(rm.code).toBe(0);
    expect(json(rm).fileKept).toBe("rec.mp4");
    await fs.stat(path.join(A, "rec.mp4")); // still there
    expect((await cli([...C(), "assets", "remove", "--id", "ast-rec"])).code).toBe(6);
  });

  it("a corrupt registry is reported, never overwritten, and recovered from its backup", async () => {
    const file = path.join(A, "registry.json");
    const good = await fs.readFile(file, "utf8");
    await fs.writeFile(file, good.slice(0, 40));
    const v = await cli([...C(), "--json", "assets", "validate"]);
    expect(v.code).toBe(1);
    expect(json(v)).toMatchObject({ ok: false, backup: "valid" });
    const reg = await cli([...C(), "--json", "assets", "register", "--file", path.join(A, "rec.mp4"), "--type", "b-roll"]);
    expect(reg.code).toBe(1);
    expect(json(reg)).toMatchObject({ error: "REGISTRY_CORRUPT", hint: expect.stringContaining("assets recover") });
    expect(await fs.readFile(file, "utf8")).toBe(good.slice(0, 40));
    const rec = await cli([...C(), "--json", "assets", "recover"]);
    expect(rec.code).toBe(0);
    expect(json(rec)).toMatchObject({ status: "recovered" });
    expect((await fs.readdir(A)).some((n) => n.startsWith("registry.json.corrupt-"))).toBe(true);
    expect((await cli([...C(), "assets", "validate"])).code).toBe(0);
    expect(json(await cli([...C(), "--json", "assets", "recover"]))).toMatchObject({ status: "valid" });
  });

  it("migrates a hand-written Stage F registry on the first change, keeping the original", async () => {
    const t2 = await makeTempDir("cf-e2e-mig-");
    try {
      const q = await setupProject(t2.dir);
      const png = makePng(10, 10);
      await fs.mkdir(path.join(q.ws, "assets"), { recursive: true });
      await fs.writeFile(path.join(q.ws, "assets", "d.png"), png);
      const v1 = { schemaVersion: 1, kind: "asset-registry", assets: [{ jobId: "2026-w44-topic-1", assetId: "ast-scn-03-diagram", path: "d.png", sha256: `sha256:${sha256Hex(png)}`, license: "own work" }] };
      await writeJsonAtomic(path.join(q.ws, "assets", "registry.json"), v1);
      expect(json(await cli(["-C", q.dir, "--json", "assets", "list"]))).toMatchObject({ schemaVersion: 1, legacy: true });
      expect((await cli(["-C", q.dir, "assets", "validate"])).code).toBe(0);
      await fs.writeFile(path.join(q.ws, "assets", "e.png"), makePng(12, 12));
      const r = await cli(["-C", q.dir, "--json", "assets", "register", "--file", path.join(q.ws, "assets", "e.png"), "--type", "screenshot"]);
      expect(r.code, r.stderr).toBe(0);
      expect(json(r).migratedFromV1).toBe(true);
      const reg = AssetRegistryV2Schema.parse(JSON.parse(await fs.readFile(path.join(q.ws, "assets", "registry.json"), "utf8")));
      expect(reg.assets[0]).toMatchObject({ id: "ast-d", type: "diagram", uses: [{ jobId: "2026-w44-topic-1", assetId: "ast-scn-03-diagram" }], provenance: { origin: "unknown", license: "own work", verification: "unverified" }, media: { kind: "image", width: 10 } });
      expect(JSON.parse(await fs.readFile(path.join(q.ws, "assets", "registry.v1.json"), "utf8"))).toEqual(v1);
    } finally {
      await t2.cleanup();
    }
  });

  it("voice providers reports readiness honestly; voice test fails clearly without a provider", async () => {
    const r = await cli([...C(), "--json", "voice", "providers"]);
    expect(r.code).toBe(0);
    const v = json(r);
    expect(v.providers.map((x: any) => x.id)).toEqual(["none", "windows-sapi", "piper"]);
    expect(v.providers.find((x: any) => x.id === "none")).toMatchObject({ ready: false, code: "VOICE_PROVIDER_UNAVAILABLE", configured: true });
    expect(v.providers.find((x: any) => x.id === "piper")).toMatchObject({ ready: false, message: expect.stringContaining("not set") });
    const sapi = v.providers.find((x: any) => x.id === "windows-sapi");
    if (process.platform === "win32") expect(typeof sapi.ready).toBe("boolean");
    else expect(sapi.ready).toBe(false);
    expect(JSON.stringify(v)).not.toContain(process.env["USERPROFILE"] ?? "\u0000");
    const t = await cli([...C(), "--json", "voice", "test"]);
    expect(t.code).toBe(1);
    expect(json(t)).toMatchObject({ ok: false, provider: "none", code: "VOICE_PROVIDER_UNAVAILABLE" });
    if (sapi.ready) {
      const cfgFile = path.join(p.dir, "creatorflow.config.json");
      const cfg = JSON.parse(await fs.readFile(cfgFile, "utf8"));
      cfg.providers = { ...(cfg.providers ?? {}), tts: { id: "windows-sapi" } };
      await writeJsonAtomic(cfgFile, cfg);
      const s = await cli([...C(), "--json", "voice", "test", "--text", "Testing one two three.", "--out", path.join(tmp.dir, "t.wav")]);
      expect(s.code, s.stdout + s.stderr).toBe(0);
      expect(json(s)).toMatchObject({ ok: true, provider: "windows-sapi", sampleRate: 22050, clippedSamples: 0 });
      expect(json(s).durationMs).toBeGreaterThan(500);
      const d = json(await cli([...C(), "--json", "doctor"]));
      expect(d.checks.find((c: any) => c.id === "voice")).toBeUndefined(); // voice.mode is "none" in this profile
    }
  });
});
