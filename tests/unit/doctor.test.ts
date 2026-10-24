import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "@creatorflow/core";
import { runDoctor, type DoctorDeps } from "../../packages/cli/src/commands/doctor.ts";
import { runInit } from "../../packages/cli/src/onboarding/init.ts";
import { makeTempDir } from "../helpers.ts";

/** Fake system: every binary present unless listed in `missing`. */
function fakeDeps(over: Partial<DoctorDeps> & { missing?: string[]; files?: string[] } = {}): DoctorDeps {
  const missing = new Set(over.missing ?? []);
  const files = new Set(over.files ?? []);
  return {
    run: async (file, args) => {
      const name = path.basename(file).replace(/\.(exe|cmd)$/i, "");
      const key = name === "node" && args[0]?.endsWith("npm-cli.js") ? "npm" : name;
      if (missing.has(key)) return { exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" };
      return { exitCode: 0, stdout: `${key} version 1.0\n`, stderr: "" };
    },
    exists: async (p) => files.has(p),
    nodeVersion: "22.20.0",
    platform: "linux",
    env: {},
    freeDiskBytes: async () => 50 * 1024 ** 3,
    resolvePackage: () => undefined,
    ...over,
  };
}

const status = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)?.status;

describe("doctor", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("passes core checks and warns (not fails) on missing optional tools and project", async () => {
    const r = await runDoctor(tmp.dir, fakeDeps({ missing: ["ffmpeg", "ffprobe"] }));
    expect(r.ok).toBe(true);
    expect(status(r, "node")).toBe("pass");
    expect(status(r, "ffmpeg")).toBe("warn");
    expect(r.checks.find((c) => c.id === "ffmpeg")?.hint).toMatch(/ffmpeg/i);
    expect(status(r, "config")).toBe("warn");
    expect(status(r, "browser")).toBe("info");
  });

  it("fails on an unsupported Node version", async () => {
    const r = await runDoctor(tmp.dir, fakeDeps({ nodeVersion: "20.11.0" }));
    expect(r.ok).toBe(false);
    expect(status(r, "node")).toBe("fail");
  });

  it("detects a system browser and low disk", async () => {
    const r = await runDoctor(tmp.dir, fakeDeps({ files: ["/usr/bin/chromium"], freeDiskBytes: async () => 1024 ** 3 }));
    expect(status(r, "browser")).toBe("pass");
    expect(status(r, "disk")).toBe("warn");
  });

  it("validates project files and reports provider env presence without values", async () => {
    await runInit({
      dir: tmp.dir,
      interactive: false,
      preset: "ai-dev-tools",
      flags: { name: "X", language: "en", timezone: "UTC", brandName: "X" },
    });
    const cfgPath = path.join(tmp.dir, "creatorflow.config.json");
    await writeJsonAtomic(cfgPath, {
      schemaVersion: 1,
      providers: { research: { id: "web-search", apiKeyEnv: "CF_TEST_RESEARCH_KEY" } },
    });
    const secret = "super-secret-value-123";
    const without = await runDoctor(tmp.dir, fakeDeps());
    expect(status(without, "config")).toBe("pass");
    expect(status(without, "profile")).toBe("pass");
    expect(status(without, "workspace")).toBe("pass");
    expect(status(without, "provider.research")).toBe("warn");
    expect(status(without, "provider.tts")).toBe("info");

    const withKey = await runDoctor(tmp.dir, fakeDeps({ env: { CF_TEST_RESEARCH_KEY: secret } }));
    expect(status(withKey, "provider.research")).toBe("info");
    expect(JSON.stringify(withKey)).not.toContain(secret);
  });

  it("fails on an invalid profile and flags TTS mode without a provider", async () => {
    await runInit({ dir: tmp.dir, interactive: false, preset: "ai-dev-tools", flags: { name: "X", language: "en", timezone: "UTC", brandName: "X" } });
    const profilePath = path.join(tmp.dir, "creator-profile.json");
    const { readJsonFile } = await import("@creatorflow/core");
    const p = (await readJsonFile(profilePath)) as any;
    p.voice.mode = "tts";
    await writeJsonAtomic(profilePath, p);
    expect(status(await runDoctor(tmp.dir, fakeDeps()), "voice")).toBe("warn");

    // Stage G: with a configured provider, doctor reports its measured readiness (injected here).
    const cfgPath = path.join(tmp.dir, "creatorflow.config.json");
    const cfg = (await readJsonFile(cfgPath)) as any;
    cfg.providers = { ...(cfg.providers ?? {}), tts: { id: "windows-sapi" } };
    await writeJsonAtomic(cfgPath, cfg);
    const ready = await runDoctor(tmp.dir, fakeDeps({ voiceHealth: async () => ({ ready: true, voices: 2 }) }));
    expect(ready.checks.find((c) => c.id === "voice")).toMatchObject({ status: "pass", detail: expect.stringContaining("windows-sapi ready") });
    const notReady = await runDoctor(tmp.dir, fakeDeps({ voiceHealth: async () => ({ ready: false, message: "no voices" }) }));
    expect(notReady.checks.find((c) => c.id === "voice")).toMatchObject({ status: "warn", detail: "windows-sapi: no voices" });
    expect(notReady.ok).toBe(true);

    p.languages.primary = "english";
    await writeJsonAtomic(profilePath, p);
    const r = await runDoctor(tmp.dir, fakeDeps());
    expect(r.ok).toBe(false);
    expect(status(r, "profile")).toBe("fail");
  });
});
