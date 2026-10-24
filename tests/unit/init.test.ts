import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonAtomic } from "@creatorflow/core";
import { runInit } from "../../packages/cli/src/onboarding/init.ts";
import { deepMerge } from "../../packages/cli/src/onboarding/merge.ts";
import { createScriptedPrompter } from "../../packages/cli/src/onboarding/prompter.ts";
import { makeTempDir } from "../helpers.ts";

const FULL_FLAGS = {
  name: "Dev Shorts",
  niche: "AI coding tools",
  topics: "coding agents, LLM APIs",
  audience: "Backend developers",
  language: "en",
  platform: "youtube-shorts",
  timezone: "Asia/Kolkata",
  brandName: "DevShorts",
};

describe("deepMerge", () => {
  it("merges objects, replaces arrays, ignores undefined", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, d: undefined }, { a: { e: 2 } })).toEqual({
      a: { b: 1, c: [3], e: 2 },
      d: 1,
    });
  });

  it("does not alias source objects", () => {
    const src = { a: { list: [1] } };
    const out = deepMerge<{ a: { list: number[] } }>(src);
    out.a.list.push(2);
    expect(src.a.list).toEqual([1]);
  });
});

describe("runInit", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("fails non-interactively with the exact missing fields and writes nothing", async () => {
    await expect(runInit({ dir: tmp.dir, interactive: false, flags: { name: "X" } })).rejects.toMatchObject({
      code: "INIT_MISSING_FIELDS",
      exitCode: 2,
      details: expect.arrayContaining([expect.objectContaining({ path: "creator.niche" })]),
    });
    expect(await fs.readdir(tmp.dir)).toEqual([]);
  });

  it("creates valid profile, config and workspace from flags", async () => {
    const r = await runInit({ dir: tmp.dir, interactive: false, flags: { ...FULL_FLAGS, languages: "hi, es", weeklyTarget: "5" } });
    expect(r.profile.status).toBe("created");
    expect(r.config.status).toBe("created");
    const profile = (await readJsonFile(r.profileFile)) as any;
    expect(profile.creator.topics).toEqual(["coding agents", "LLM APIs"]);
    expect(profile.languages).toEqual({ primary: "en", additional: ["hi", "es"] });
    expect(profile.schedule.weeklyTarget).toBe(5);
    expect(profile.voice.mode).toBe("none");
    // Projects outside the repo get no brittle relative $schema path.
    expect(profile.$schema).toBeUndefined();
    await expect(fs.stat(path.join(tmp.dir, "workspace", "logs"))).resolves.toBeTruthy();
  });

  it("asks only for missing essentials, re-asks invalid answers, uses suggestions", async () => {
    const prompter = createScriptedPrompter(["Agent Weekly", "not-a-language", "pt-BR", ""]);
    const r = await runInit({
      dir: tmp.dir,
      interactive: true,
      prompter,
      preset: "ai-dev-tools",
      flags: { timezone: "Europe/Berlin" },
    });
    // Preset provides niche/topics/audience/platform; flags provide timezone. The language is re-asked once.
    expect(prompter.asked).toEqual([
      "Creator / channel display name",
      "Primary language (BCP 47, e.g. en, hi, es)",
      "Primary language (BCP 47, e.g. en, hi, es)",
      "Brand name shown in videos",
    ]);
    expect(r.asked).toEqual(["creator.displayName", "languages.primary", "brand.name"]);
    expect(prompter.warnings).toEqual(["Not a BCP 47 language tag (e.g. en, hi, pt-BR)."]);
    const profile = (await readJsonFile(r.profileFile)) as any;
    expect(profile.languages.primary).toBe("pt-BR");
    // Empty answer accepts the suggestion (display name).
    expect(profile.brand.name).toBe("Agent Weekly");
    expect(profile.platforms.primary).toBe("youtube-shorts");
  });

  it("is idempotent and preserves existing values on rerun", async () => {
    const first = await runInit({ dir: tmp.dir, interactive: false, flags: FULL_FLAGS });
    const before = await fs.readFile(first.profileFile, "utf8");
    const second = await runInit({ dir: tmp.dir, interactive: false });
    expect(second.profile.status).toBe("unchanged");
    expect(second.config.status).toBe("unchanged");
    expect(second.preserved).toContain("creator.niche");
    expect(await fs.readFile(first.profileFile, "utf8")).toBe(before);
    expect((await fs.readdir(tmp.dir)).some((f) => f.endsWith(".bak"))).toBe(false);
  });

  it("keeps user edits, applies explicit overrides, and backs up the old file", async () => {
    const r = await runInit({ dir: tmp.dir, interactive: false, flags: FULL_FLAGS });
    const edited = (await readJsonFile(r.profileFile)) as any;
    edited.brand.colors.primary = "#123456";
    edited.content.avoidTopics = ["crypto"];
    await writeJsonAtomic(r.profileFile, edited);

    const r2 = await runInit({ dir: tmp.dir, interactive: false, flags: { niche: "Developer productivity" } });
    expect(r2.profile.status).toBe("updated");
    expect(r2.profile.backup).toBe(`${r.profileFile}.bak`);
    const after = (await readJsonFile(r.profileFile)) as any;
    expect(after.creator.niche).toBe("Developer productivity");
    expect(after.brand.colors.primary).toBe("#123456");
    expect(after.content.avoidTopics).toEqual(["crypto"]);
    expect(((await readJsonFile(`${r.profileFile}.bak`)) as any).creator.niche).toBe("AI coding tools");
  });

  it("supports answers files including config, and validates them", async () => {
    const answers = path.join(tmp.dir, "answers.json");
    await writeJsonAtomic(answers, {
      profile: {
        creator: { displayName: "A", niche: "AI tools", topics: ["agents"], audience: { description: "Devs" } },
        languages: { primary: "en" },
        platforms: { primary: "instagram-reels" },
        brand: { name: "A" },
        schedule: { timezone: "UTC" },
      },
      config: { workspaceDir: "data/ws", hardware: { maxConcurrentRenders: 2 } },
    });
    const r = await runInit({ dir: tmp.dir, interactive: false, answersFile: answers });
    expect(r.workspaceDir).toBe(path.join(tmp.dir, "data", "ws"));
    expect(((await readJsonFile(r.configFile)) as any).hardware.maxConcurrentRenders).toBe(2);

    await writeJsonAtomic(answers, { config: { providers: { tts: { id: "cloud", paid: true } } } });
    await expect(runInit({ dir: tmp.dir, interactive: false, answersFile: answers })).rejects.toMatchObject({ code: "INIT_INVALID" });
  });

  it("refuses secrets in answers and writes nothing new", async () => {
    const answers = path.join(tmp.dir, "answers.json");
    await writeJsonAtomic(answers, { config: { providers: { research: { id: "web", options: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz" } } } } });
    await expect(runInit({ dir: tmp.dir, interactive: false, answersFile: answers, flags: FULL_FLAGS })).rejects.toMatchObject({
      code: "INIT_INVALID",
      details: expect.arrayContaining([expect.objectContaining({ path: "providers.research.options.apiKey" })]),
    });
    expect(await fs.readdir(tmp.dir)).toEqual(["answers.json"]);
  });

  it("dry-run validates without writing", async () => {
    const r = await runInit({ dir: tmp.dir, interactive: false, flags: FULL_FLAGS, dryRun: true });
    expect(r.profile.status).toBe("dry-run");
    expect(await fs.readdir(tmp.dir)).toEqual([]);
  });

  it("rejects unknown presets and malformed existing files", async () => {
    await expect(runInit({ dir: tmp.dir, interactive: false, preset: "nope" })).rejects.toMatchObject({ code: "USAGE" });
    await fs.writeFile(path.join(tmp.dir, "creatorflow.config.json"), "{ broken");
    await expect(runInit({ dir: tmp.dir, interactive: false, flags: FULL_FLAGS })).rejects.toMatchObject({ code: "INIT_INVALID" });
    expect(await fs.readFile(path.join(tmp.dir, "creatorflow.config.json"), "utf8")).toBe("{ broken");
  });
});
