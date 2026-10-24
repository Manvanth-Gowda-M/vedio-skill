// In-process integration of the REAL research -> script -> localize steps (production pipeline),
// with real files, locks and fingerprints. FICTIONAL research and FIXTURE translations; no network.
// Cross-process behaviour (kill + resume) is covered in tests/e2e/script.test.ts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, sha256File, writeJsonAtomic } from "@creatorflow/core";
import { PlanStore, resumeWorkflow } from "@creatorflow/orchestrator";
import { translationPath, translationTemplate } from "@creatorflow/localization";
import { importIntoSession, ManualSourcesProvider, planWeek, researchPaths } from "@creatorflow/research";
import { CanonicalScriptSchema, LocalizationSetSchema, SceneManifestSchema, type CreatorFlowConfig, type WeeklyPlanContent } from "@creatorflow/schemas";
import { buildProductionPipeline } from "../../packages/cli/src/pipeline.ts";

// The REAL pipeline, except that the (slow) Remotion render step is replaced by a blocking stub:
// these tests cover research/script/localize/assets only. Real rendering: tests/integration/render.test.ts.
const productionPipeline = buildProductionPipeline({
  wrap: (id, real) => (id === "render" ? async () => ({ status: "blocked", code: "TEST_RENDER_DISABLED", reason: "render disabled in this test" }) : real),
});
import { makeTempDir } from "../helpers.ts";
import { FIXTURE_WEEK, RESEARCH_PROFILE, writeResearchFixture, type FixtureOptions } from "../fixtures/research-fixture.ts";
import { readJob, setupProject, type FixtureProject } from "../workflow-helpers.ts";

const KEEP = ["hooks-explained", "subagents-release", "mcp-comparison"];
const job = (contentId: string) => `2026-w44-${contentId}`;

describe("script and localize steps in the production pipeline", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;

  async function importFixture(opts: FixtureOptions = {}) {
    const inDir = path.join(tmp.dir, "in");
    await writeResearchFixture(inDir, opts);
    const r = await new ManualSourcesProvider().importLocal({ path: inDir });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (await importIntoSession({ paths: researchPaths(p.ws), sessionId: "main", bundle: r.value, providerId: "manual-sources" })).session;
  }
  async function approve(content: WeeklyPlanContent) {
    const store = new PlanStore(p.paths);
    const v = await store.addVersion(content);
    await store.decide({ weekId: content.weekId, version: v.version, hash: v.contentHash, decision: "approved", by: "test" });
    return v;
  }
  function plan(session: Awaited<ReturnType<typeof importFixture>>, edit?: (c: WeeklyPlanContent) => void) {
    const content = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    content.items = content.items.filter((i) => KEEP.includes(i.contentId));
    edit?.(content);
    return content;
  }
  const resume = (config: CreatorFlowConfig = p.config, profile = p.profile) => resumeWorkflow({ paths: p.paths, pipeline: productionPipeline, profile, config });
  const runs = (r: Awaited<ReturnType<typeof resume>>) => Object.fromEntries(r.jobs.map((j) => [j.contentId, j.stepsRun]));
  async function writeHindi(contentId: string, edit?: (t: any) => void) {
    const scriptFile = path.join(p.paths.jobDir(job(contentId)), "script", "script.json");
    const script = CanonicalScriptSchema.parse(await readJsonFile(scriptFile));
    const t: any = translationTemplate(script, (await sha256File(scriptFile)).sha256, "hi");
    t.translator.name = "Fixture translator";
    t.segments = t.segments.map((s: any, i: number) => ({ segmentId: s.segmentId, narration: `यह खंड ${i + 1} का परीक्षण अनुवाद है।`, onScreenText: `खंड ${i + 1}` }));
    delete t.instructions;
    edit?.(t);
    await writeJsonAtomic(translationPath(p.ws, job(contentId), "hi"), t);
  }

  beforeEach(async () => {
    tmp = await makeTempDir("cf-sstep-");
    p = await setupProject(tmp.dir, {}, RESEARCH_PROFILE);
  });
  afterEach(() => tmp.cleanup());

  it("writes verified script artifacts whose cross-references and hashes agree; resume reuses them", async () => {
    const session = await importFixture();
    const v = await approve(plan(session));
    const r1 = await resume();
    for (const id of KEEP) {
      expect(runs(r1)[id]).toEqual(["research", "script", "localize"]);
      const j = await readJob(p.paths, job(id));
      expect(j).toMatchObject({ lastSuccessfulStep: "script", state: "BLOCKED", blocked: { step: "localize", code: "NEEDS_TRANSLATION" } });
      expect(j.blocked!.reason).toContain(`creatorflow localize template --job ${job(id)} --lang hi`);
      const outs = j.steps["script"]!.outputs;
      expect(outs.map((o) => o.path)).toEqual(["script/script.json", "script/storyboard.json", "script/captions.json", "script/scene-manifest.json"]);
      const dir = p.paths.jobDir(job(id));
      for (const o of outs) expect((await sha256File(path.join(dir, o.path))).sha256).toBe(o.sha256);
      const manifest = SceneManifestSchema.parse(await readJsonFile(path.join(dir, "script", "scene-manifest.json")));
      const sha = Object.fromEntries(outs.map((o) => [o.path, o.sha256]));
      expect(manifest.script.sha256).toBe(sha["script/script.json"]);
      expect(manifest.storyboard.sha256).toBe(sha["script/storyboard.json"]);
      expect(manifest.subtitles.canonical.sha256).toBe(sha["script/captions.json"]);
      expect(manifest.plan).toMatchObject({ weekId: FIXTURE_WEEK, version: v.version, contentHash: v.contentHash });
      const script = CanonicalScriptSchema.parse(await readJsonFile(path.join(dir, "script", "script.json")));
      expect(script.evidence.sha256).toBe(j.steps["research"]!.outputs[0]!.sha256);
      expect(j.artifacts).toMatchObject({ script: `jobs/${job(id)}/script/script.json`, storyboard: `jobs/${job(id)}/script/storyboard.json`, sceneManifest: `jobs/${job(id)}/script/scene-manifest.json` });
    }
    const r2 = await resume();
    for (const id of KEEP) {
      expect(r2.jobs.find((j) => j.contentId === id)!.stepsReused).toEqual(["research", "script"]);
      expect(runs(r2)[id]).toEqual(["localize"]); // blocked step re-checked; no new verified work
    }
  });

  it("changing only one item's hook reruns that script only; research is reused everywhere", async () => {
    const session = await importFixture();
    await approve(plan(session));
    await resume();
    await approve(plan(session, (c) => (c.items.find((i) => i.contentId === "hooks-explained")!.hook = "A different opening line for this video.")));
    const r = await resume();
    expect(runs(r)).toEqual({ "hooks-explained": ["script", "localize"], "subagents-release": ["localize"], "mcp-comparison": ["localize"] });
    expect(r.jobs.every((j) => j.stepsReused.includes("research"))).toBe(true);
    const j = await readJob(p.paths, job("hooks-explained"));
    expect(j.steps["script"]!.attempts.filter((a) => a.outcome === "succeeded")).toHaveLength(2);
    expect(j.history.some((h) => h.type === "invalidated" && h.step === "script" && h.reason === "step inputs changed")).toBe(true);
  });

  it("changing a research source reruns research and script only for the items citing it", async () => {
    let session = await importFixture();
    await approve(plan(session));
    await resume();
    session = await importFixture({ sourceOverrides: { "s-release": { title: "Version 2.0 released (fictional, corrected)" } } });
    await approve(plan(session));
    const r = await resume();
    expect(runs(r)["subagents-release"]).toEqual(["research", "script", "localize"]);
    expect(runs(r)["hooks-explained"]).toEqual(["localize"]);
    expect(runs(r)["mcp-comparison"]).toEqual(["localize"]);
    const j = await readJob(p.paths, job("subagents-release"));
    expect(j.history.filter((h) => h.type === "invalidated").map((h) => h.step)).toEqual(["research", "script"]);
  });

  it("a relevant profile change reruns scripts but not research", async () => {
    const session = await importFixture();
    await approve(plan(session));
    await resume();
    const profile = { ...p.profile, brand: { ...p.profile.brand, name: "Renamed Brand" } };
    const r = await resume(p.config, profile);
    for (const id of KEEP) expect(runs(r)[id]).toEqual(["script", "localize"]);
    expect((await readJob(p.paths, job("mcp-comparison"))).history.some((h) => h.type === "invalidated" && h.reason === "relevant configuration changed")).toBe(true);
  });

  it("localization: blocked without a translation, succeeds after import, reruns on edit, becomes stale on script change", async () => {
    const session = await importFixture();
    await approve(plan(session));
    await resume();
    await writeHindi("hooks-explained");
    let r = await resume();
    expect(runs(r)).toEqual({ "hooks-explained": ["localize", "narrate", "assets", "queue-render", "render"], "subagents-release": ["localize"], "mcp-comparison": ["localize"] });
    let j = await readJob(p.paths, job("hooks-explained"));
    // Stage F: assets and queue-render now run for real; the render step is stubbed in this file.
    expect(j).toMatchObject({ state: "BLOCKED", lastSuccessfulStep: "queue-render", blocked: { step: "render", code: "TEST_RENDER_DISABLED" } });
    const set = LocalizationSetSchema.parse(await readJsonFile(path.join(p.paths.jobDir(job("hooks-explained")), "localize", "variants.json")));
    expect(set.variants.map((v) => [v.language, v.provider, v.status, v.review])).toEqual([["en", "canonical", "source", "not-applicable"], ["hi", "human-import", "translated", "unreviewed"]]);
    expect(set.variants[1]!.segments.every((s, i) => s.claimIds.join() === set.variants[0]!.segments[i]!.claimIds.join())).toBe(true);
    expect(set.fontCoverage).toBe("not-verified");
    const subs = (await readJsonFile(path.join(p.paths.jobDir(job("hooks-explained")), "localize", "subtitles.json"))) as any;
    expect(subs.tracks.map((t: any) => [t.language, t.timing, t.source])).toEqual([["en", "estimated", "canonical"], ["hi", "estimated", "localized"]]);

    // Unchanged: reused. Edited translation: only localize reruns.
    r = await resume();
    expect(r.jobs.find((x) => x.contentId === "hooks-explained")!.stepsReused).toEqual(["research", "script", "localize", "narrate", "assets", "queue-render"]);
    await writeHindi("hooks-explained", (t) => (t.segments[0].narration = "एक बदला हुआ परीक्षण वाक्य।"));
    r = await resume();
    // narrate re-checks (its upstream changed) and reproduces byte-identical output (only the canonical
    // language is narrated), so assets and queue-render are reused and the English video is not re-rendered.
    expect(runs(r)["hooks-explained"]).toEqual(["localize", "narrate", "render"]);
    expect((await readJob(p.paths, job("hooks-explained"))).history.some((h) => h.type === "invalidated" && h.step === "localize" && h.reason === "step inputs changed")).toBe(true);

    // Script change: the translation is now stale, so localization blocks instead of using it.
    await approve(plan(session, (c) => (c.items.find((i) => i.contentId === "hooks-explained")!.hook = "A brand new hook for this video.")));
    r = await resume();
    expect(runs(r)["hooks-explained"]).toEqual(["script", "localize"]);
    j = await readJob(p.paths, job("hooks-explained"));
    expect(j.blocked).toMatchObject({ step: "localize", code: "TRANSLATION_INVALID" });
    expect(j.blocked!.reason).toContain("stale");
    // The old variants.json stays on disk but is no longer a recorded output, so nothing treats it as current.
    expect(j.steps["localize"]!.outputs).toEqual([]);
    expect(j.lastSuccessfulStep).toBe("script");
  });

  it("same-language targets need no import; an invalid translation blocks with the reason", async () => {
    const session = await importFixture();
    await approve(plan(session));
    const enOnly = { ...p.config, localization: { ...p.config.localization, targetLanguages: ["en", "en-IN"] } } as CreatorFlowConfig;
    await resume(enOnly);
    const set = LocalizationSetSchema.parse(await readJsonFile(path.join(p.paths.jobDir(job("mcp-comparison")), "localize", "variants.json")));
    expect(set.variants.map((v) => [v.language, v.provider, v.review])).toEqual([["en", "canonical", "not-applicable"], ["en-IN", "same-language", "unreviewed"]]);
    expect(set.variants[1]!.issues[0]!.code).toBe("NO_REGIONAL_ADAPTATION");

    await writeHindi("hooks-explained", (t) => t.segments.pop());
    await resume();
    const j = await readJob(p.paths, job("hooks-explained"));
    expect(j.blocked).toMatchObject({ step: "localize", code: "TRANSLATION_INVALID", reason: expect.stringContaining("TRANSLATION_MISSING_SEGMENT") });
  });

  it("an evidence file edited after verification is caught before scripting", async () => {
    const session = await importFixture();
    await approve(plan(session));
    await resume();
    const ev = path.join(p.paths.jobDir(job("mcp-comparison")), "research", "evidence.json");
    const data = (await readJsonFile(ev)) as any;
    data.claims[0].text = "Both tools support MCP servers and are free forever.";
    await writeJsonAtomic(ev, data);
    const r = await resume();
    // The runner notices the research output changed and re-runs research, which rewrites the
    // verified evidence byte-for-byte; the script built from that evidence is therefore reused.
    expect(runs(r)["mcp-comparison"]).toEqual(["research", "localize"]);
    expect(r.jobs.find((x) => x.contentId === "mcp-comparison")!.stepsReused).toContain("script");
    expect((await readJob(p.paths, job("mcp-comparison"))).history.some((h) => h.type === "invalidated" && h.step === "research" && /modified after verification/.test(h.reason ?? ""))).toBe(true);
    const script = CanonicalScriptSchema.parse(await readJsonFile(path.join(p.paths.jobDir(job("mcp-comparison")), "script", "script.json")));
    expect(JSON.stringify(script)).not.toContain("free forever");
  });
});
