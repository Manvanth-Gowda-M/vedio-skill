import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprint, readJsonFile } from "@creatorflow/core";
import { createJobRecord, JobStore, jobIdFor, workflowPaths, type WorkflowPaths } from "@creatorflow/orchestrator";
import { WeeklyPlanContentSchema, type JobRecord } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { makePlan, WEEK } from "../workflow-helpers.ts";

function sampleJob(): JobRecord {
  const content = WeeklyPlanContentSchema.parse(makePlan(1));
  return createJobRecord({ weekId: WEEK, version: 1, contentHash: fingerprint(content), content }, content.items[0]!, "2026-10-22T00:00:00.000Z");
}

describe("JobStore", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let paths: WorkflowPaths;
  let store: JobStore;
  beforeEach(async () => {
    tmp = await makeTempDir();
    paths = workflowPaths(path.join(tmp.dir, "ws"));
    store = new JobStore(paths);
  });
  afterEach(() => tmp.cleanup());

  it("derives stable ids from week + persisted content id only", () => {
    expect(jobIdFor("2026-W44", "topic-1")).toBe("2026-w44-topic-1");
    expect(() => jobIdFor("2026-W44", "../x")).toThrow(expect.objectContaining({ code: "ID_INVALID" }));
    expect(() => jobIdFor("week", "a")).toThrow(expect.objectContaining({ code: "WEEK_INVALID" }));
    expect(() => paths.jobDir("..")).toThrow();
  });

  it("creates once, loads with validation, and saves with compare-and-swap", async () => {
    const job = sampleJob();
    expect(await store.create(job)).toBe(true);
    expect(await store.create(job)).toBe(false);
    const loaded = await store.load(job.jobId);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;

    const a = loaded.job;
    const b = structuredClone(a);
    a.history.push({ at: "2026-10-22T00:00:01.000Z", type: "reused", reason: "writer a" });
    const saved = await store.save(a);
    expect(saved.revision).toBe(1);
    b.history.push({ at: "2026-10-22T00:00:02.000Z", type: "reused", reason: "stale writer b" });
    await expect(store.save(b)).rejects.toMatchObject({ code: "JOB_REVISION_CONFLICT", exitCode: 5 });
    const onDisk = (await readJsonFile(paths.jobFile(job.jobId))) as JobRecord;
    expect(onDisk.history.at(-1)!.reason).toBe("writer a");
    expect(((await readJsonFile(paths.jobBackup(job.jobId))) as JobRecord).revision).toBe(0);
  });

  it("refuses to persist an invalid record (state invariants enforced by schema)", async () => {
    const job = sampleJob();
    await store.create(job);
    const bad = { ...job, state: "FAILED" as const }; // FAILED without failure/resumeState
    await expect(store.save(bad)).rejects.toMatchObject({ code: "JOB_INVALID" });
    expect(((await readJsonFile(paths.jobFile(job.jobId))) as JobRecord).state).toBe("PLANNED");
  });

  it("flags secrets that slipped into a record", async () => {
    const job = sampleJob();
    await store.create(job);
    job.history.push({ at: "2026-10-22T00:00:01.000Z", type: "reused", reason: "key sk-abcdefghijklmnopqrstuvwx" });
    await expect(store.save(job)).rejects.toMatchObject({ code: "JOB_INVALID" });
  });

  it.each([
    ["truncated JSON", (raw: string) => raw.slice(0, raw.length / 2)],
    ["schema-invalid", (raw: string) => raw.replace('"state": "PLANNED"', '"state": "DONE"')],
    ["wrong job id", (raw: string) => raw.replace(/"jobId": "[^"]+"/, '"jobId": "2026-w44-other-topic-1"')],
  ])("detects a corrupt record (%s), never overwrites it, and recovers from backup", async (_l, corrupt) => {
    const job = sampleJob();
    await store.create(job);
    const loaded = await store.load(job.jobId);
    if (loaded.status !== "ok") throw new Error("setup");
    await store.save(loaded.job); // creates job.prev.json
    const file = paths.jobFile(job.jobId);
    const broken = corrupt(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, broken);

    const state = await store.load(job.jobId);
    expect(state).toMatchObject({ status: "corrupt", backup: "valid" });
    await expect(store.save({ ...loaded.job, revision: 1 })).rejects.toMatchObject({ code: "JOB_CORRUPT" });
    expect(await fs.readFile(file, "utf8")).toBe(broken);

    const r = await store.recover(job.jobId);
    expect(path.basename(r.quarantined)).toMatch(/^job\.json\.corrupt-/);
    expect(await fs.readFile(r.quarantined, "utf8")).toBe(broken);
    expect(r.job.history.at(-1)).toMatchObject({ type: "recovered" });
    expect((await store.load(job.jobId)).status).toBe("ok");
  });

  it("refuses recovery without a valid backup and changes nothing", async () => {
    const job = sampleJob();
    await store.create(job);
    await fs.writeFile(paths.jobFile(job.jobId), "{");
    expect(await store.load(job.jobId)).toMatchObject({ status: "corrupt", backup: "missing" });
    await expect(store.recover(job.jobId)).rejects.toMatchObject({ code: "JOB_CORRUPT" });
    expect(await fs.readFile(paths.jobFile(job.jobId), "utf8")).toBe("{");
  });
});
