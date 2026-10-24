// In-process integration: real research executor in the real production pipeline,
// real files and locks, FICTIONAL fixture research. Cross-process behaviour is in tests/e2e/research.test.ts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile } from "@creatorflow/core";
import { PlanStore, resumeWorkflow } from "@creatorflow/orchestrator";
import { importIntoSession, ManualSourcesProvider, planWeek, researchPaths } from "@creatorflow/research";
import { ResearchEvidencePackSchema, type WeeklyPlanContent } from "@creatorflow/schemas";
import { productionPipeline } from "../../packages/cli/src/pipeline.ts";
import { makeTempDir } from "../helpers.ts";
import { FIXTURE_WEEK, RESEARCH_PROFILE, writeResearchFixture, type FixtureOptions } from "../fixtures/research-fixture.ts";
import { readJob, setupProject, type FixtureProject } from "../workflow-helpers.ts";

describe("research step in the production pipeline", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;

  async function importFixture(opts: FixtureOptions = {}) {
    const inDir = path.join(tmp.dir, "in");
    await writeResearchFixture(inDir, opts);
    const r = await new ManualSourcesProvider().importLocal({ path: inDir });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (await importIntoSession({ paths: researchPaths(p.ws), sessionId: "main", bundle: r.value, providerId: "manual-sources" })).session;
  }
  async function saveAndApprove(content: WeeklyPlanContent) {
    const store = new PlanStore(p.paths);
    const v = await store.addVersion(content);
    await store.decide({ weekId: content.weekId, version: v.version, hash: v.contentHash, decision: "approved", by: "test" });
    return v;
  }
  const resume = () => resumeWorkflow({ paths: p.paths, pipeline: productionPipeline, profile: p.profile, config: p.config });
  const attempts = async (jobId: string) => (await readJob(p.paths, jobId)).steps["research"]!.attempts.length;

  beforeEach(async () => {
    tmp = await makeTempDir("cf-rstep-");
    p = await setupProject(tmp.dir, {}, RESEARCH_PROFILE);
  });
  afterEach(() => tmp.cleanup());

  it("verifies research, writes a schema-valid evidence pack, and later steps block honestly", async () => {
    const session = await importFixture();
    const plan = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    await saveAndApprove(plan);
    const r1 = await resume();
    expect(r1.jobs).toHaveLength(7);
    for (const j of r1.jobs) {
      expect(j).toMatchObject({ result: "blocked" });
      expect(j.stepsRun[0]).toBe("research");
      const job = await readJob(p.paths, j.jobId);
      expect(job.state).toBe("BLOCKED");
      // Stage E: English items get a script, then need a Hindi translation; the Hindi item has no script provider.
      expect([`script:SCRIPT_LANGUAGE_UNSUPPORTED`, `localize:NEEDS_TRANSLATION`]).toContain(`${job.blocked!.step}:${job.blocked!.code}`);
      expect(job.steps["research"]).toMatchObject({ status: "succeeded", outputs: [{ path: "research/evidence.json", role: "research" }] });
      expect(job.artifacts.research).toBe(`jobs/${j.jobId}/research/evidence.json`);
      const pack = ResearchEvidencePackSchema.parse(await readJsonFile(path.join(p.paths.jobDir(j.jobId), "research", "evidence.json")));
      const item = plan.items.find((i) => i.contentId === job.contentId)!;
      expect(pack).toMatchObject({ contentId: item.contentId, evidenceHash: item.research!.evidenceHash, asOf: item.publishDate });
      expect(pack.sources.map((s) => s.sourceId)).toEqual(item.research!.sources.map((s) => s.sourceId));
      expect(pack.claims.every((c) => c.kind !== "fact" || c.support === "supported" || c.support === "supported-unchecked")).toBe(true);
    }
    const hooks = ResearchEvidencePackSchema.parse(await readJsonFile(path.join(p.paths.jobDir("2026-w44-hooks-explained"), "research", "evidence.json")));
    expect(hooks.claims.map((c) => [c.kind, c.usage])).toEqual([["fact", "state-as-fact-with-citation"], ["interpretation", "present-as-opinion"]]);

    // Unchanged inputs: research is reused, nothing re-runs.
    const r2 = await resume();
    expect(r2.jobs.every((j) => j.stepsReused.includes("research") && !j.stepsRun.includes("research"))).toBe(true);
    for (const j of r2.jobs) expect(await attempts(j.jobId)).toBe(1);
  });

  it("a changed source re-runs research only for the items that depend on it (after re-planning)", async () => {
    let session = await importFixture();
    const v1 = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    await saveAndApprove(v1);
    await resume();

    session = await importFixture({ sourceOverrides: { "s-release": { title: "Version 2.0 released (fictional, corrected)" } } });
    // Approved work is tied to the approved plan: research changes do nothing until a new version is approved.
    // (Blocked steps are re-checked on every resume, so only verified steps are asserted here.)
    const unchanged = await resume();
    expect(unchanged.jobs.every((j) => !j.stepsRun.includes("research"))).toBe(true);
    expect(unchanged.jobs.filter((j) => j.contentId !== "protocols-explainer").every((j) => j.stepsReused.includes("script"))).toBe(true);

    const v2 = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    const changed = v2.items.filter((it) => it.research!.evidenceHash !== v1.items.find((o) => o.contentId === it.contentId)?.research!.evidenceHash).map((i) => i.contentId).sort();
    expect(changed).toEqual(["changelog-recap", "subagent-experiment", "subagents-release"]); // the items citing s-release
    expect(v2.items.map((i) => i.contentId)).toEqual(v1.items.map((i) => i.contentId));
    await saveAndApprove(v2);
    const r = await resume();
    for (const j of r.jobs) {
      const affected = changed.includes(j.contentId);
      expect(j.stepsRun.includes("research"), j.jobId).toBe(affected);
      expect(await attempts(j.jobId)).toBe(affected ? 2 : 1);
      if (affected) expect((await readJob(p.paths, j.jobId)).history.some((h) => h.type === "invalidated" && h.step === "research" && h.reason === "step inputs changed")).toBe(true);
    }
  });

  it("changing only the hook (not the research) keeps verified research", async () => {
    const session = await importFixture();
    const plan = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    await saveAndApprove(plan);
    await resume();
    const edited = structuredClone(plan);
    edited.items[0]!.hook = "A completely new opening line";
    edited.items[0]!.publishDate = "2026-10-27";
    await saveAndApprove(edited);
    const r = await resume();
    expect(r.jobs.every((j) => !j.stepsRun.includes("research") && j.stepsReused.includes("research"))).toBe(true);
  });

  it("blocks (no retries used) when research changed or vanished before the step ran", async () => {
    const session = await importFixture();
    const plan = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    const tampered = structuredClone(plan);
    tampered.items = tampered.items.slice(0, 3);
    tampered.items[0]!.research!.evidenceHash = `sha256:${"0".repeat(64)}`;
    tampered.items[1]!.research!.sessionId = "deleted-session";
    await saveAndApprove(tampered);
    await importFixture({ sourceOverrides: { "s-docs": { publisher: "Example Tools Inc." } } });
    const r = await resume();
    const codes = await Promise.all(r.jobs.map(async (j) => (await readJob(p.paths, j.jobId)).blocked?.code));
    const byId = Object.fromEntries(r.jobs.map((j, i) => [j.contentId, codes[i]]));
    expect(byId[tampered.items[0]!.contentId]).toBe("RESEARCH_CHANGED");
    expect(byId[tampered.items[1]!.contentId]).toBe("RESEARCH_SESSION_MISSING");
    const third = tampered.items[2]!;
    const reliesOnDocs = third.research!.sources.some((s) => session.sources[s.sourceId]!.key === "s-docs");
    if (reliesOnDocs) expect(byId[third.contentId]).toBe("RESEARCH_CHANGED");
    else expect(byId[third.contentId]).not.toMatch(/RESEARCH/);
    for (const j of r.jobs) {
      const job = await readJob(p.paths, j.jobId);
      if (job.blocked?.step === "research") expect(job.steps["research"]!.attempts.map((a) => a.outcome)).toEqual(["blocked"]);
    }
  });

  it("blocks when a stored snapshot text was modified after import", async () => {
    const session = await importFixture();
    const plan = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    const hooks = plan.items.find((i) => i.contentId === "hooks-explained")!;
    await saveAndApprove({ ...plan, items: [hooks] });
    const docs = Object.values(session.sources).find((s) => s.key === "s-docs")!;
    await fs.appendFile(path.join(p.ws, docs.provenance.snapshot!.textPath), "\ntampered");
    await resume();
    expect((await readJob(p.paths, "2026-w44-hooks-explained")).blocked).toMatchObject({ step: "research", code: "SNAPSHOT_MODIFIED" });
  });

  it("fails permanently (not retried) when evidence post-dates the publish date", async () => {
    const session = await importFixture();
    const plan = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    const news = plan.items.find((i) => i.contentId === "subagents-release")!;
    // Hand-built W43 plan reusing the W44 research link, published before the source existed.
    await saveAndApprove({ weekId: "2026-W43", items: [{ ...news, publishDate: "2026-10-19" }] });
    const r = await resumeWorkflow({ paths: p.paths, pipeline: productionPipeline, profile: p.profile, config: p.config, weekId: "2026-W43" });
    expect(r.jobs[0]).toMatchObject({ result: "failed", message: expect.stringContaining("EVIDENCE_INSUFFICIENT") });
    const job = await readJob(p.paths, "2026-w43-subagents-release");
    expect(job).toMatchObject({ state: "FAILED", failure: { kind: "permanent", code: "EVIDENCE_INSUFFICIENT" } });
    expect(job.failure!.message).toContain("as of 2026-10-19");
    expect(job.steps["research"]!.attempts).toHaveLength(1);
    expect(await fs.stat(path.join(p.paths.jobDir(job.jobId), "research", "evidence.json")).catch(() => null)).toBeNull();
  });
});
