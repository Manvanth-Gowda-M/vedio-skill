import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256File } from "@creatorflow/core";
import { PlanStore, syncJobs } from "@creatorflow/orchestrator";
import { recordReviewDecision } from "@creatorflow/qa";
import { QaReportSchema } from "@creatorflow/schemas";
import { main } from "../../packages/cli/src/main.ts";
import { captureStreams, makeTempDir } from "../helpers.ts";
import { fakeRenderPipeline, renderProject, resumeWith, type FakeControl } from "../render-helpers.ts";
import { FIXTURE_WEEK } from "../fixtures/research-fixture.ts";
import type { FixtureProject } from "../workflow-helpers.ts";

const KEY = "hooks-explained";
const J = `2026-w44-${KEY}`;
const jdir = (p: FixtureProject) => p.paths.jobDir(J);

describe("Stage I: Package and Batch CLI commands", { timeout: 300_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;

  beforeEach(async () => {
    tmp = await makeTempDir("cf-cli-pkg-");
    ctl = { mode: "qa-ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "pid") };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const pipe = () => fakeRenderPipeline(ctl, { qa: {} });

  it("package show, run, verify, export and batch status/report CLI workflows", async () => {
    const { p } = await renderProject(tmp.dir, { keep: [KEY] });
    const pipeline = pipe();

    const store = new PlanStore(p.paths);
    const approved = await store.approvedPlan(FIXTURE_WEEK);
    await syncJobs(p.paths, approved);

    // 1. Initial state: package show before packaging returns exit code 6 (NOT_FOUND)
    const ioShowBefore = captureStreams();
    const codeShowBefore = await main(
      ["node", "creatorflow", "-C", p.dir, "--json", "package", "show", "--job", J],
      { streams: ioShowBefore.streams, pipeline },
    );
    expect(codeShowBefore).toBe(6);
    expect(JSON.parse(ioShowBefore.stdout)).toMatchObject({ ok: false, error: "PACKAGE_NOT_FOUND" });

    // 2. Run workflow up to QA and review
    await resumeWith(p, pipeline);

    const qaReportRaw = await fs.readFile(path.join(jdir(p), "qa", "report.json"), "utf8");
    const qaReport = QaReportSchema.parse(JSON.parse(qaReportRaw));
    const qaSha = (await sha256File(path.join(jdir(p), "qa", "report.json"))).sha256;
    const revManSha = (await sha256File(path.join(jdir(p), "qa", "review-manifest.json"))).sha256;

    // Approve review
    await recordReviewDecision(jdir(p), {
      jobId: J,
      qaReportSha256: qaSha,
      reviewManifestSha256: revManSha,
      videoSha256: qaReport.render.outputSha256,
      decision: "approved",
      by: "E2E Reviewer",
      at: new Date().toISOString(),
      note: "E2E approved",
    });

    // 3. `creatorflow package run --job <id>`
    const ioPkgRun = captureStreams();
    const codePkgRun = await main(
      ["node", "creatorflow", "-C", p.dir, "--json", "package", "run", "--job", J],
      { streams: ioPkgRun.streams, pipeline },
    );
    expect(codePkgRun).toBe(0);
    const pkgRunJson = JSON.parse(ioPkgRun.stdout);
    expect(pkgRunJson.ok).toBe(true);
    expect(pkgRunJson.state).toBe("PACKAGE_READY");
    expect(pkgRunJson.verified).toBe(true);

    // 4. `creatorflow package show --job <id>`
    const ioShow = captureStreams();
    const codeShow = await main(
      ["node", "creatorflow", "-C", p.dir, "--json", "package", "show", "--job", J],
      { streams: ioShow.streams, pipeline },
    );
    expect(codeShow).toBe(0);
    const showJson = JSON.parse(ioShow.stdout);
    expect(showJson.ok).toBe(true);
    expect(showJson.manifest.jobId).toBe(J);
    expect(showJson.manifest.delivery.status).toBe("packaged");

    // 5. `creatorflow package verify --job <id>`
    const ioVerify = captureStreams();
    const codeVerify = await main(
      ["node", "creatorflow", "-C", p.dir, "--json", "package", "verify", "--job", J],
      { streams: ioVerify.streams, pipeline },
    );
    expect(codeVerify).toBe(0);
    expect(JSON.parse(ioVerify.stdout)).toMatchObject({ ok: true, verified: true });

    // 6. `creatorflow package export --job <id> --out <file.zip>`
    const zipOut = path.join(tmp.dir, "export.zip");
    const ioExport = captureStreams();
    const codeExport = await main(
      ["node", "creatorflow", "-C", p.dir, "--json", "package", "export", "--job", J, "--out", zipOut],
      { streams: ioExport.streams, pipeline },
    );
    expect(codeExport).toBe(0);
    const exportJson = JSON.parse(ioExport.stdout);
    expect(exportJson.ok).toBe(true);
    expect(exportJson.type).toBe("zip");
    expect(await fs.access(zipOut).then(() => true, () => false)).toBe(true);

    // 7. `creatorflow batch status --week <week>`
    const ioBatchStatus = captureStreams();
    const codeBatchStatus = await main(
      ["node", "creatorflow", "-C", p.dir, "--json", "batch", "status", "--week", FIXTURE_WEEK],
      { streams: ioBatchStatus.streams, pipeline },
    );
    expect(codeBatchStatus).toBe(0);
    const statusJson = JSON.parse(ioBatchStatus.stdout);
    expect(statusJson.kind).toBe("batch-report");
    expect(statusJson.summary.packaged).toBe(1);

    // 8. Top-level `creatorflow report --week <week>`
    const ioReport = captureStreams();
    const codeReport = await main(
      ["node", "creatorflow", "-C", p.dir, "--json", "report", "--week", FIXTURE_WEEK],
      { streams: ioReport.streams, pipeline },
    );
    expect(codeReport).toBe(0);
    const reportJson = JSON.parse(ioReport.stdout);
    expect(reportJson.kind).toBe("batch-report");
    expect(reportJson.weekId).toBe(FIXTURE_WEEK);
  });
});
