import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringifyJson as stringifyJsonForTest } from "@creatorflow/core";
import {
  CreatorProfileSchema,
  JSON_SCHEMA_EXPORTS,
  toJsonSchema,
  validateConfig,
  validateProfile,
} from "@creatorflow/schemas";
import { validProfile } from "../helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const paths = (r: { ok: boolean; issues: { path: string }[] }) => r.issues.map((i) => i.path);

describe("creator profile schema", () => {
  it("accepts a valid profile and applies defaults", () => {
    const r = validateProfile(validProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schedule.weeklyTarget).toBe(7);
    expect(r.value.approval.publishing).toBe("manual-only");
    expect(r.value.content.requireSourcesForClaims).toBe(true);
    expect(r.value.voice.glossary).toEqual([]);
  });

  it("rejects unknown keys (typos do not silently pass)", () => {
    const r = validateProfile(validProfile({ shedule: {} }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes("shedule"))).toBe(true);
  });

  it.each([
    ["languages.primary", { languages: { primary: "english" } }],
    ["platforms.primary", { platforms: { primary: "myspace" } }],
    ["schedule.timezone", { schedule: { ...validProfile().schedule, timezone: "Mars/Olympus" } }],
    ["brand.colors.primary", { brand: { ...validProfile().brand, colors: { ...validProfile().brand.colors, primary: "red" } } }],
    ["approval.publishing", { approval: { publishing: "auto" } }],
  ])("rejects invalid %s", (p, override) => {
    const r = validateProfile(validProfile(override));
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain(p);
  });

  it("rejects duplicates and contradictions", () => {
    const r = validateProfile(
      validProfile({
        languages: { primary: "en", additional: ["en"] },
        platforms: { primary: "youtube-shorts", secondary: ["youtube-shorts"] },
        schedule: { ...validProfile().schedule, durations: { shortForm: { minSec: 90, maxSec: 30 }, longForm: { minSec: 480, maxSec: 900 } } },
      }),
    );
    expect(paths(r)).toEqual(expect.arrayContaining(["languages.additional", "platforms.secondary", "schedule.durations.shortForm.minSec"]));
  });

  it("rejects path traversal in logoPath", () => {
    expect(paths(validateProfile(validProfile({ brand: { ...validProfile().brand, logoPath: "../../secret.png" } })))).toContain("brand.logoPath");
    expect(paths(validateProfile(validProfile({ brand: { ...validProfile().brand, logoPath: "C:/x.png" } })))).toContain("brand.logoPath");
  });

  it("rejects secrets embedded anywhere", () => {
    const r = validateProfile(validProfile({ creator: { ...validProfile().creator, niche: "AI sk-abcdefghijklmnopqrstuvwxyz" } }));
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain("creator.niche");
  });
});

describe("config schema", () => {
  it("fills free/local provider defaults from a minimal config", () => {
    const r = validateConfig({ schemaVersion: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.fromEntries(Object.entries(r.value.providers).map(([k, v]) => [k, v.id]))).toEqual({
      research: "manual-sources",
      llm: "agent-host",
      tts: "none",
      image: "none",
      video: "none",
      storage: "local-fs",
      publishing: "package-only",
    });
    expect(r.value.budget).toEqual({ currency: "USD", monthlyLimit: 0, allowPaidProviders: false });
    expect(r.value.offline.allowNetworkResearch).toBe(false);
  });

  it("blocks paid providers unless explicitly allowed with a budget", () => {
    const paid = { schemaVersion: 1, providers: { tts: { id: "cloud-tts", paid: true, apiKeyEnv: "CLOUD_TTS_KEY" } } };
    expect(paths(validateConfig(paid))).toEqual(expect.arrayContaining(["providers.tts.paid", "budget.monthlyLimit"]));
    expect(validateConfig({ ...paid, budget: { allowPaidProviders: true, monthlyLimit: 10 } }).ok).toBe(true);
  });

  it("allows paid providers to exist while disabled", () => {
    expect(validateConfig({ schemaVersion: 1, providers: { tts: { id: "cloud-tts", paid: true, enabled: false } } }).ok).toBe(true);
  });

  it("rejects public publishing integrations", () => {
    expect(paths(validateConfig({ schemaVersion: 1, providers: { publishing: { id: "youtube-upload" } } }))).toContain("providers.publishing.id");
  });

  it("rejects inline API keys and malformed env names", () => {
    const r = validateConfig({ schemaVersion: 1, providers: { research: { id: "x", apiKeyEnv: "lowercase", options: { apiKey: "abc" } } } });
    expect(paths(r)).toEqual(expect.arrayContaining(["providers.research.apiKeyEnv", "providers.research.options.apiKey"]));
  });

  it("rejects workspace paths that escape the project", () => {
    expect(paths(validateConfig({ schemaVersion: 1, workspaceDir: "../elsewhere" }))).toContain("workspaceDir");
  });

  it("Stage B configs (no workflow block) stay valid and get bounded retry defaults", () => {
    const r = validateConfig({ schemaVersion: 1, profilePath: "creator-profile.json", workspaceDir: "workspace", providers: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.workflow).toEqual({ maxAttempts: 3, backoffBaseMs: 2000, backoffMaxMs: 60000, defaultStepTimeoutMs: 1_800_000, stepTimeoutMs: {} });
    expect(paths(validateConfig({ schemaVersion: 1, workflow: { maxAttempts: 0 } }))).toContain("workflow.maxAttempts");
    expect(paths(validateConfig({ schemaVersion: 1, workflow: { maxAttempts: 11 } }))).toContain("workflow.maxAttempts");
  });
});

describe("generated JSON Schemas", () => {
  it("are up to date with the Zod sources (run `npm run schemas:build` if this fails)", async () => {
    for (const [file, schema] of Object.entries(JSON_SCHEMA_EXPORTS)) {
      const onDisk = await fs.readFile(path.join(repoRoot, "packages", "schemas", "json", file), "utf8");
      expect(onDisk.replace(/\r\n/g, "\n")).toBe(stringifyJsonForTest(toJsonSchema(schema, file)));
    }
  });

  it("describe required essentials", () => {
    const json = toJsonSchema(CreatorProfileSchema, "p.json") as { required: string[]; $schema: string };
    expect(json.$schema).toContain("2020-12");
    expect(json.required).toEqual(expect.arrayContaining(["schemaVersion", "creator", "languages", "platforms"]));
  });
});
