// End-to-end research -> plan -> approve -> resume with REAL child processes.
// Sources are FICTIONAL fixtures read from local files; no network access and no
// live trend data are involved, so nothing here validates real-world research.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, readJsonFile, sha256File, writeJsonAtomic } from "@creatorflow/core";
import { ResearchEvidencePackSchema, ResearchSessionSchema, PlanningRunSchema } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { FIXTURE_WEEK, RESEARCH_PROFILE, writeResearchFixture } from "../fixtures/research-fixture.ts";
import { exists, readJob, setupProject, waitFor, type FixtureProject } from "../workflow-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_CLI = path.join(repoRoot, "packages", "cli", "bin", "creatorflow.js");
const FIXTURE_CLI = path.join(repoRoot, "tests", "fixtures", "fixture-cli.ts");

interface Done {
  code: number | null;
  stdout: string;
  stderr: string;
}
function start(args: string[], launcher = PROD_CLI, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [launcher, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<Done>((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  return { pid: child.pid!, done, kill: () => child.kill("SIGKILL") };
}
const run = (args: string[], launcher?: string, env?: NodeJS.ProcessEnv) => start(args, launcher, env).done;
const json = (s: string) => JSON.parse(s) as Record<string, any>;

// Every test here spawns many real CLI processes; when real Remotion renders run in parallel
// (Stage G added more of them) they can exceed the 30 s default, so the timeout is explicit.
describe("research CLI and plan-week (real processes, offline)", { timeout: 120_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  let inDir: string;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-e2e-res-");
    p = await setupProject(tmp.dir, {}, RESEARCH_PROFILE);
    inDir = path.join(tmp.dir, "sources");
    await writeResearchFixture(inDir);
  });
  afterEach(() => tmp.cleanup());

  it("imports, ranks, plans, requires explicit approval, then runs the real research step", async () => {
    // 1. Import
    const imp = await run(["-C", p.dir, "--json", "research", "--input", inDir, "--as-of", "2026-10-26"]);
    expect(imp.code, imp.stderr).toBe(0);
    const r = json(imp.stdout);
    expect(r.provider).toEqual({ id: "manual-sources", capabilities: { importLocal: true, webSearch: false, fetchUrl: false, modelAssist: false } });
    expect(r.limitation).toContain("No live web research");
    expect(r.import).toMatchObject({ status: "created", counts: { added: 39, rejected: 0 } });
    expect(r.unresolvedClaims.map((u: any) => u.claimId)).toEqual(["clm-c-mismatch", "clm-c-notes", "clm-c-rumor"]);
    expect(r.ranking.filter((x: any) => x.eligible)).toHaveLength(10);
    ResearchSessionSchema.parse(await readJsonFile(r.session.file));

    // Identical re-import: no change, exit 0, session file untouched.
    const before = await sha256File(r.session.file);
    const again = json((await run(["-C", p.dir, "--json", "research", "--input", inDir, "--as-of", "2026-10-26"])).stdout);
    expect(again.import.status).toBe("unchanged");
    expect((await sha256File(r.session.file)).sha256).toBe(before.sha256);

    // Inspect without input
    const inspect = await run(["-C", p.dir, "research", "--as-of", "2026-10-26"]);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toMatch(/INELIGIBLE .*crypto-agents/);
    expect(inspect.stdout).toContain("AVOIDED_TOPIC");

    // 2. Plan
    const plan = await run(["-C", p.dir, "--json", "plan-week", "--week", FIXTURE_WEEK]);
    expect(plan.code, plan.stderr).toBe(0);
    const pl = json(plan.stdout);
    expect(pl.plan).toMatchObject({ status: "created", version: 1, approved: false });
    expect(pl.items).toHaveLength(7);
    expect(pl.next).toBe(`creatorflow approve-plan --week ${FIXTURE_WEEK} --plan-version 1 --hash ${pl.plan.contentHash}`);
    const runRec = PlanningRunSchema.parse(await readJsonFile(pl.runFile));
    expect(runRec).toMatchObject({ weekId: FIXTURE_WEEK, asOf: "2026-10-26", scoringModel: "cf-score-v1", plan: { version: 1, contentHash: pl.plan.contentHash } });
    expect(runRec.ranking).toHaveLength(18);

    // Reproducible: same inputs -> unchanged, same hash.
    const replan = json((await run(["-C", p.dir, "--json", "plan-week", "--week", FIXTURE_WEEK])).stdout);
    expect(replan.plan).toMatchObject({ status: "unchanged", version: 1, contentHash: pl.plan.contentHash });

    // 3. Not approved -> resume refuses (exit 1); status shows pending.
    const unapproved = await run(["-C", p.dir, "--json", "resume"]);
    expect(unapproved.code).toBe(1);
    expect(json(unapproved.stdout).error).toBe("PLAN_NOT_APPROVED");
    expect(json((await run(["-C", p.dir, "--json", "status"])).stdout).plan.versions[0].state).toBe("pending");

    // 4. Approve the exact version + hash.
    expect((await run(["-C", p.dir, "approve-plan", "--week", FIXTURE_WEEK, "--plan-version", "1", "--hash", "0".repeat(16)])).code).toBe(5);
    const ok = await run(["-C", p.dir, "approve-plan", "--week", FIXTURE_WEEK, "--plan-version", "1", "--hash", pl.plan.contentHash, "--by", "e2e"]);
    expect(ok.code).toBe(0);

    // 5. Resume with the production CLI: research succeeds; later steps block honestly (Stage E: localization needs hi).
    const res = await run(["-C", p.dir, "--json", "resume"]);
    expect(res.code).toBe(1);
    const rep = json(res.stdout);
    expect(rep.summary).toMatchObject({ blocked: 7, failed: 0 });
    for (const j of rep.jobs) expect(j.stepsRun[0]).toBe("research");
    const job = await readJob(p.paths, "2026-w44-subagents-release");
    expect(job).toMatchObject({ lastSuccessfulStep: "script", blocked: { step: "localize", code: "NEEDS_TRANSLATION" } });
    ResearchEvidencePackSchema.parse(await readJsonFile(path.join(p.paths.jobDir(job.jobId), "research", "evidence.json")));
    const st = await run(["-C", p.dir, "status"]);
    expect(st.stdout).toMatch(/2026-w44-subagents-release\s+BLOCKED\s+2\/10\s+next: localize/);
  });

  it("exit codes: invalid input 1, missing input/session 6, unsupported search 3, shortfall 1, nothing eligible 1", async () => {
    const missing = await run(["-C", p.dir, "--json", "research", "--input", path.join(tmp.dir, "nope")]);
    expect(missing.code).toBe(6);
    expect(json(missing.stdout).error).toBe("RESEARCH_INPUT_NOT_FOUND");
    expect((await run(["-C", p.dir, "--json", "research", "--session", "never"])).code).toBe(6);
    expect((await run(["-C", p.dir, "--json", "plan-week", "--week", FIXTURE_WEEK, "--session", "never"])).code).toBe(6);

    const search = await run(["-C", p.dir, "--json", "research", "--query", "latest AI agents"]);
    expect(search.code).toBe(3);
    expect(json(search.stdout)).toMatchObject({ error: "PROVIDER_UNSUPPORTED", hint: expect.stringContaining("no live web research") });

    const bad = path.join(tmp.dir, "bad.json");
    await writeJsonAtomic(bad, { items: [] });
    const invalid = await run(["-C", p.dir, "--json", "research", "--input", bad]);
    expect(invalid.code).toBe(1);
    expect(json(invalid.stdout).error).toBe("RESEARCH_INPUT_INVALID");
    expect((await run(["-C", p.dir, "research", "--session", "../x", "--input", inDir])).code).toBe(2);
    expect((await run(["-C", p.dir, "research", "--input", inDir, "--as-of", "soon"])).code).toBe(2);

    // Partially invalid bundle: valid records saved, rejected ones reported, exit 1.
    const partial = path.join(inDir, "research.json");
    const b = (await readJsonFile(partial)) as any;
    b.sources.push({ key: "broken", title: "x", sourceType: "nonsense" });
    await writeJsonAtomic(partial, b);
    const part = await run(["-C", p.dir, "--json", "research", "--input", partial, "--session", "partial"]);
    expect(part.code).toBe(1);
    expect(json(part.stdout).import.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", record: "research.json:sources[9](broken)" })]));
    expect(json(part.stdout).session.sources).toBe(9);

    // Shortfall: plan saved with fewer items, exit 1, clear message.
    await writeResearchFixture(path.join(tmp.dir, "small"), { onlyCandidates: ["hooks-explained", "mcp-comparison", "rumor-news"] });
    await run(["-C", p.dir, "research", "--input", path.join(tmp.dir, "small"), "--session", "small"]);
    const short = await run(["-C", p.dir, "--json", "plan-week", "--week", "2026-W45", "--session", "small", "--as-of", "2026-10-26"]);
    expect(short.code).toBe(1);
    const sj = json(short.stdout);
    expect(sj.plan).toMatchObject({ status: "created", approved: false });
    expect(sj.items).toHaveLength(2);
    expect(sj.shortfall).toMatchObject({ target: 7, selected: 2, eligible: 2 });
    expect(short.stderr).toContain("SHORTFALL");

    await writeResearchFixture(path.join(tmp.dir, "none"), { onlyCandidates: ["rumor-news", "stale-launch"] });
    await run(["-C", p.dir, "research", "--input", path.join(tmp.dir, "none"), "--session", "none"]);
    const none = await run(["-C", p.dir, "--json", "plan-week", "--week", "2026-W46", "--session", "none"]);
    expect(none.code).toBe(1);
    expect(json(none.stdout)).toMatchObject({ error: "NO_ELIGIBLE_TOPICS" });
    expect(await exists(p.paths.weekDir("2026-W46"))).toBe(false);
  });

  it("an interrupted research step is resumed in a new process without redoing finished jobs", async () => {
    await run(["-C", p.dir, "research", "--input", inDir]);
    const pl = json((await run(["-C", p.dir, "--json", "plan-week", "--week", FIXTURE_WEEK])).stdout);
    await run(["-C", p.dir, "approve-plan", "--week", FIXTURE_WEEK, "--plan-version", "1", "--hash", pl.plan.contentHash]);
    const firstId = pl.items[0].contentId as string;
    const secondId = pl.items[1].contentId as string;
    const J2 = `2026-w44-${secondId}`;
    await fs.writeFile(path.join(p.ws, "hang.json"), JSON.stringify({ research: { jobs: [secondId], attempts: [1] } }));
    const env = { CF_FIXTURE_PIPELINE: "production" };

    const p1 = start(["-C", p.dir, "--json", "resume"], FIXTURE_CLI, env);
    await waitFor(() => exists(path.join(p.ws, `hang-${J2}-research-1.marker`)), 20_000, "research of job 2 to hang");
    p1.kill();
    await p1.done;
    await waitFor(async () => !isProcessAlive(p1.pid), 5_000, "process 1 to die");

    const j1 = await readJob(p.paths, `2026-w44-${firstId}`);
    expect(j1.steps["research"]!.status).toBe("succeeded");
    const j1Out = path.join(p.paths.jobDir(j1.jobId), "research", "evidence.json");
    const j1Hash = (await sha256File(j1Out)).sha256;
    const crashed = await readJob(p.paths, J2);
    expect(crashed.steps["research"]!.attempts.map((a) => a.outcome ?? "OPEN")).toEqual(["OPEN"]);

    const r2 = await run(["-C", p.dir, "--json", "resume"], FIXTURE_CLI, env);
    expect(r2.code).toBe(1); // every job blocks at a later step
    const rep = json(r2.stdout);
    const first = rep.jobs.find((j: any) => j.contentId === firstId);
    expect(first.stepsReused).toContain("research");
    expect(first.stepsRun).not.toContain("research");
    const second = rep.jobs.find((j: any) => j.contentId === secondId);
    expect(second.stepsRun[0]).toBe("research");
    expect(second.notes).toEqual(expect.arrayContaining([expect.stringContaining("research: attempt 1 was interrupted")]));
    const final = await readJob(p.paths, J2);
    expect(final.steps["research"]!.attempts.map((a) => a.outcome)).toEqual(["interrupted", "succeeded"]);
    expect(final.steps["research"]!.status).toBe("succeeded");
    expect(final.blocked!.step).not.toBe("research");
    expect((await sha256File(j1Out)).sha256).toBe(j1Hash);
    const execs = (await fs.readFile(path.join(p.ws, "exec.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(execs.filter((e) => e.jobId === j1.jobId && e.step === "research")).toHaveLength(1);
  });
});
