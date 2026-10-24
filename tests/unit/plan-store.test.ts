import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonAtomic } from "@creatorflow/core";
import { hashMatches, planContentHash, PlanStore, workflowPaths, type WorkflowPaths } from "@creatorflow/orchestrator";
import { makeTempDir } from "../helpers.ts";
import { makePlan, WEEK } from "../workflow-helpers.ts";

describe("PlanStore: versions and hashes", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let paths: WorkflowPaths;
  let store: PlanStore;
  beforeEach(async () => {
    tmp = await makeTempDir();
    paths = workflowPaths(path.join(tmp.dir, "ws"));
    store = new PlanStore(paths);
  });
  afterEach(() => tmp.cleanup());

  it("creates numbered immutable versions with canonical content hashes", async () => {
    const a = await store.addVersion(makePlan(3));
    expect(a).toMatchObject({ status: "created", weekId: WEEK, version: 1 });
    expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const file = (await readJsonFile(paths.planVersion(WEEK, 1))) as any;
    expect(file).toMatchObject({ schemaVersion: 1, kind: "weekly-plan-version", weekId: WEEK, version: 1, contentHash: a.contentHash });
    expect(Date.parse(file.createdAt)).not.toBeNaN();
    expect(planContentHash(file.content)).toBe(a.contentHash);

    const b = await store.addVersion(makePlan(3, { 1: { topic: "Changed topic" } }));
    expect(b).toMatchObject({ status: "created", version: 2 });
    expect(b.contentHash).not.toBe(a.contentHash);
    // v1 is untouched
    expect(((await readJsonFile(paths.planVersion(WEEK, 1))) as any).content.items[1].topic).toBe("Fixture topic number 2");
  });

  it("does not create a version for identical content (key order, defaults, $schema ignored)", async () => {
    const plan = makePlan(2);
    await store.addVersion(plan);
    const reordered = JSON.parse(JSON.stringify({ items: plan.items.map((i) => ({ ...i, sourceIds: [] })), weekId: plan.weekId, $schema: "x.json" }));
    expect(await store.addVersion(reordered)).toMatchObject({ status: "unchanged", version: 1 });
  });

  it("rejects invalid plans without writing", async () => {
    const dup = makePlan(2, { 1: { contentId: "topic-1" } });
    await expect(store.addVersion(dup)).rejects.toMatchObject({ code: "PLAN_INVALID", details: expect.arrayContaining([expect.objectContaining({ path: "items[1].contentId" })]) });
    await expect(store.addVersion(makePlan(1, { 0: { publishDate: "2026-11-30" } }))).rejects.toMatchObject({ code: "PLAN_INVALID" });
    await expect(store.addVersion(makePlan(1, { 0: { contentId: "../evil" } }))).rejects.toMatchObject({ code: "PLAN_INVALID" });
    await expect(store.addVersion(makePlan(1, { 0: { topic: "uses sk-abcdefghijklmnopqrstuvwx" } }))).rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(await store.weeks()).toEqual([]);
  });

  it("serialises concurrent adds without losing a version", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => store.addVersion(makePlan(n))));
    expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3, 4]);
    const s = await store.summary(WEEK);
    expect(s.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it("adopts a version file left unindexed by an interrupted write", async () => {
    await store.addVersion(makePlan(1));
    const index = (await readJsonFile(paths.planIndex(WEEK))) as any;
    await store.addVersion(makePlan(2));
    await writeJsonAtomic(paths.planIndex(WEEK), index); // simulate crash after writing v0002.json but before the index
    expect((await store.summary(WEEK)).unindexedFiles).toEqual(["v0002.json"]);
    const r = await store.addVersion(makePlan(3));
    expect(r.version).toBe(3);
    const s = await store.summary(WEEK);
    expect(s.versions.map((v) => [v.version, v.state])).toEqual([[1, "superseded"], [2, "superseded"], [3, "pending"]]);
    expect(((await readJsonFile(paths.planIndex(WEEK))) as any).versions[1].recovered).toBe(true);
  });

  it("reports a corrupt index instead of guessing", async () => {
    await store.addVersion(makePlan(1));
    await fs.writeFile(paths.planIndex(WEEK), "{ nope");
    await expect(store.summary(WEEK)).rejects.toMatchObject({ code: "PLAN_INDEX_CORRUPT", exitCode: 1 });
  });
});

describe("PlanStore: approvals", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let paths: WorkflowPaths;
  let store: PlanStore;
  beforeEach(async () => {
    tmp = await makeTempDir();
    paths = workflowPaths(path.join(tmp.dir, "ws"));
    store = new PlanStore(paths);
  });
  afterEach(() => tmp.cleanup());

  const approve = (version: number, hash: string, by = "alice") => store.decide({ weekId: WEEK, version, hash, decision: "approved", by });

  it("matches hashes by full value or a >= 12 char prefix", () => {
    const h = `sha256:${"ab".repeat(32)}`;
    expect(hashMatches(h, h)).toBe(true);
    expect(hashMatches("abababababab", h)).toBe(true);
    expect(hashMatches("ababab", h)).toBe(false);
    expect(hashMatches("ffffffffffff", h)).toBe(false);
  });

  it("requires the exact version and hash; approval is not carried to new versions", async () => {
    const v1 = await store.addVersion(makePlan(3));
    await expect(approve(1, "deadbeefdeadbeef")).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH", exitCode: 5 });
    await expect(approve(2, v1.contentHash)).rejects.toMatchObject({ code: "PLAN_NOT_FOUND", exitCode: 6 });
    await expect(store.decide({ weekId: "2026-W45", version: 1, hash: v1.contentHash, decision: "approved", by: "a" })).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });

    const r = await approve(1, v1.contentHash);
    expect(r.status).toBe("recorded");
    expect(r.summary.approvedVersion).toBe(1);
    expect((await store.approvedPlan(WEEK)).version).toBe(1);
    expect((await approve(1, v1.contentHash)).status).toBe("already");

    // Editing the plan creates v2, which is NOT approved; production must stop until it is.
    const v2 = await store.addVersion(makePlan(3, { 0: { hook: "New hook" } }));
    const s = await store.summary(WEEK);
    expect(s.versions.map((v) => v.state)).toEqual(["superseded", "pending"]);
    expect(s.approvedVersion).toBeUndefined();
    await expect(store.approvedPlan(WEEK)).rejects.toMatchObject({ code: "PLAN_NOT_APPROVED" });
    await expect(approve(1, v1.contentHash)).rejects.toMatchObject({ code: "PLAN_VERSION_SUPERSEDED", exitCode: 5 });

    await approve(2, v2.contentHash.slice(7, 23), "bob");
    expect((await store.approvedPlan(WEEK)).version).toBe(2);
    const events = (await store.summary(WEEK)).events;
    expect(events.map((e) => [e.type, e.version, e.by])).toEqual([["approved", 1, "alice"], ["approved", 2, "bob"]]);
    expect(events.every((e) => e.contentHash.startsWith("sha256:"))).toBe(true);
  });

  it("invalidates approval when an approved version file is edited in place", async () => {
    const v1 = await store.addVersion(makePlan(2));
    await approve(1, v1.contentHash);
    const file = (await readJsonFile(paths.planVersion(WEEK, 1))) as any;
    file.content.items[0].topic = "Quietly edited after approval";
    await writeJsonAtomic(paths.planVersion(WEEK, 1), file);
    const s = await store.summary(WEEK);
    expect(s.versions[0]).toMatchObject({ state: "invalid", integrityIssue: expect.stringContaining("modified") });
    expect(s.approvedVersion).toBeUndefined();
    await expect(store.approvedPlan(WEEK)).rejects.toMatchObject({ code: "PLAN_INTEGRITY" });
    await expect(approve(1, v1.contentHash)).rejects.toMatchObject({ code: "PLAN_INTEGRITY" });
  });

  it("supports rejection history; re-submitting rejected content makes a new version", async () => {
    const v1 = await store.addVersion(makePlan(2));
    await approve(1, v1.contentHash);
    const v2 = await store.addVersion(makePlan(2, { 1: { topic: "Riskier topic" } }));
    await store.decide({ weekId: WEEK, version: 2, hash: v2.contentHash, decision: "rejected", by: "alice", note: "unsourced" });
    // v2 rejected -> v1 (still approved, unchanged content) is effective again.
    const s = await store.summary(WEEK);
    expect(s.versions.map((v) => v.state)).toEqual(["approved", "rejected"]);
    expect(s.events.at(-1)).toMatchObject({ type: "rejected", note: "unsourced" });
    const again = await store.addVersion(makePlan(2, { 1: { topic: "Riskier topic" } }));
    expect(again).toMatchObject({ status: "created", version: 3 });
    expect((await store.summary(WEEK)).versions.map((v) => v.state)).toEqual(["superseded", "rejected", "pending"]);
  });

  it("rejects malformed week ids before touching the filesystem", async () => {
    await expect(store.decide({ weekId: "../../etc", version: 1, hash: "x", decision: "approved", by: "a" })).rejects.toMatchObject({ code: "WEEK_INVALID" });
  });
});
