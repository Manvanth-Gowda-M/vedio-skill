import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, sha256File } from "@creatorflow/core";
import { recordReviewDecision, verifyPackage } from "@creatorflow/qa";
import { PackageManifestSchema, QaReportSchema, ReviewManifestSchema } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { fakeRenderPipeline, renderProject, resumeWith, type FakeControl } from "../render-helpers.ts";
import { readJob, type FixtureProject } from "../workflow-helpers.ts";

const KEY = "hooks-explained";
const J = `2026-w44-${KEY}`;
const jdir = (p: FixtureProject) => p.paths.jobDir(J);

describe("Stage I: Packaging in the Production Pipeline", { timeout: 300_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;

  beforeEach(async () => {
    tmp = await makeTempDir("cf-pkg-int-");
    ctl = { mode: "qa-ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "pid") };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const pipe = () => fakeRenderPipeline(ctl, { qa: {} });

  it("advances an approved video to PACKAGE_READY and produces a verified delivery package", async () => {
    const { p } = await renderProject(tmp.dir);

    // 1. Initial run: advances up to review gate (BLOCKED: NEEDS_HUMAN_REVIEW)
    const r1 = await resumeWith(p, pipe());
    expect(r1.jobs[0]!.state).toBe("BLOCKED");
    expect(r1.jobs[0]!.stepsRun).toContain("qa");

    let job = await readJob(p.paths, J);
    expect(job.state).toBe("BLOCKED");
    expect(job.blocked?.step).toBe("review");
    expect(job.blocked?.code).toBe("NEEDS_HUMAN_REVIEW");

    // Packaging must not happen before review approval
    expect(await fs.access(path.join(jdir(p), "package")).then(() => true, () => false)).toBe(false);

    // 2. Human reviews and approves the exact QA report
    const qaReportRaw = await fs.readFile(path.join(jdir(p), "qa", "report.json"), "utf8");
    const qaReport = QaReportSchema.parse(JSON.parse(qaReportRaw));
    const qaSha = (await sha256File(path.join(jdir(p), "qa", "report.json"))).sha256;
    const revManSha = (await sha256File(path.join(jdir(p), "qa", "review-manifest.json"))).sha256;

    await recordReviewDecision(jdir(p), {
      jobId: J,
      qaReportSha256: qaSha,
      reviewManifestSha256: revManSha,
      videoSha256: qaReport.render.outputSha256,
      decision: "approved",
      by: "Producer",
      at: new Date().toISOString(),
      note: "Packaging approved.",
    });

    // 3. Resume: review succeeds -> package succeeds -> state is PACKAGE_READY
    const r2 = await resumeWith(p, pipe());
    expect(r2.jobs[0]!.state).toBe("PACKAGE_READY");
    expect(r2.jobs[0]!.stepsRun).toEqual(["review", "package"]);

    job = await readJob(p.paths, J);
    expect(job.state).toBe("PACKAGE_READY");
    expect(job.lastSuccessfulStep).toBe("package");
    expect(job.artifacts.package).toBe(`jobs/${J}/package/manifest.json`);

    // 4. Inspect generated delivery package
    const packageDir = path.join(jdir(p), "package");
    const manifestPath = path.join(packageDir, "manifest.json");
    expect(await fs.access(manifestPath).then(() => true, () => false)).toBe(true);

    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifest = PackageManifestSchema.parse(JSON.parse(manifestRaw));
    expect(manifest.jobId).toBe(J);
    expect(manifest.delivery.status).toBe("packaged");
    expect(manifest.qa.technicalQa).toBe("passed");
    expect(manifest.review.status).toBe("approved");

    // All core deliverable files exist
    expect(await fs.access(path.join(packageDir, "video.mp4")).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(packageDir, "script", "script.json")).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(packageDir, "reports", "qa-report.json")).then(() => true, () => false)).toBe(true);
    expect(await fs.access(path.join(packageDir, "reports", "review-record.json")).then(() => true, () => false)).toBe(true);

    // 5. Independent package verification
    const verification = await verifyPackage(packageDir);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification.fileCount).toBeGreaterThanOrEqual(4);

    // 6. Idempotent resume: unchanged job reuses package without re-running any step
    const r3 = await resumeWith(p, pipe());
    expect(r3.jobs[0]!.state).toBe("PACKAGE_READY");
    expect(r3.jobs[0]!.stepsRun).toEqual([]);
    expect(r3.jobs[0]!.result).toBe("unchanged");

    // 7. Modifying video inside package is caught by verifyPackage
    await fs.writeFile(path.join(packageDir, "video.mp4"), "tampered-video-stream");
    const tamperedVerification = await verifyPackage(packageDir);
    expect(tamperedVerification.ok).toBe(false);
    expect(tamperedVerification.issues.some((i) => i.includes("hash mismatch"))).toBe(true);
  });

  it("blocks packaging if human review is rejected", async () => {
    const { p } = await renderProject(tmp.dir);
    await resumeWith(p, pipe());

    const qaReportRaw = await fs.readFile(path.join(jdir(p), "qa", "report.json"), "utf8");
    const qaReport = QaReportSchema.parse(JSON.parse(qaReportRaw));
    const qaSha = (await sha256File(path.join(jdir(p), "qa", "report.json"))).sha256;
    const revManSha = (await sha256File(path.join(jdir(p), "qa", "review-manifest.json"))).sha256;

    // Reject review
    await recordReviewDecision(jdir(p), {
      jobId: J,
      qaReportSha256: qaSha,
      reviewManifestSha256: revManSha,
      videoSha256: qaReport.render.outputSha256,
      decision: "rejected",
      by: "Director",
      at: new Date().toISOString(),
      note: "Audio needs re-balancing and scene 2 text has typos.",
    });

    const r = await resumeWith(p, pipe());
    expect(r.jobs[0]!.state).toBe("BLOCKED");
    const job = await readJob(p.paths, J);
    expect(job.blocked?.step).toBe("review");
    expect(job.blocked?.code).toBe("REVIEW_REJECTED");

    // Package directory must not exist
    expect(await fs.access(path.join(jdir(p), "package")).then(() => true, () => false)).toBe(false);
  });
});
