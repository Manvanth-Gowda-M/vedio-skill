import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createZipArchive, sha256Hex, sha256File } from "@creatorflow/core";
import {
  PackageManifestSchema,
  BatchReportSchema,
  validateArtifact,
  type PackageManifest,
  type BatchReport,
} from "@creatorflow/schemas";
import { exportPackage, verifyPackage } from "@creatorflow/qa";
import { makeTempDir } from "../helpers.ts";

describe("Stage I: Packaging & Batch Unit Tests", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-pkg-unit-");
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  const dummyHash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("PackageManifestSchema validates a well-formed delivery manifest", () => {
    const manifest: PackageManifest = {
      schemaVersion: 1,
      kind: "package-manifest",
      jobId: "2026-w44-test-video",
      contentId: "test-video",
      weekId: "2026-W44",
      plan: {
        version: 1,
        planHash: dummyHash,
        itemHash: dummyHash,
      },
      packagedAt: new Date().toISOString(),
      delivery: {
        status: "packaged",
        notes: ["ready for delivery"],
      },
      metadata: {
        title: "Test Video",
        category: "explainer",
        primaryLanguage: "en",
        platform: "youtube-shorts",
        durationSec: 25.5,
        tags: ["ai", "agents"],
      },
      qa: {
        reportSha256: dummyHash,
        technicalQa: "passed",
      },
      review: {
        status: "approved",
        by: "Lead Reviewer",
        at: new Date().toISOString(),
        note: "looks great",
        decisionSha256: dummyHash,
      },
      files: [
        {
          path: "video.mp4",
          sha256: dummyHash,
          bytes: 1048576,
          role: "video",
          contentType: "video/mp4",
        },
        {
          path: "subtitles/en.vtt",
          sha256: dummyHash,
          bytes: 1200,
          role: "subtitles",
          contentType: "text/vtt",
        },
      ],
      omissions: [{ role: "thumbnail", reason: "no preview frame available" }],
    };

    const res = validateArtifact(PackageManifestSchema, manifest);
    expect(res.ok).toBe(true);
  });

  it("BatchReportSchema validates a weekly batch summary report", () => {
    const report: BatchReport = {
      schemaVersion: 1,
      kind: "batch-report",
      weekId: "2026-W44",
      generatedAt: new Date().toISOString(),
      plan: {
        version: 2,
        contentHash: dummyHash,
        approvedAt: new Date().toISOString(),
        approvedBy: "Editor in Chief",
      },
      summary: {
        total: 7,
        planned: 0,
        inProgress: 0,
        rendered: 1,
        qaPassed: 1,
        reviewPending: 1,
        reviewed: 1,
        packaged: 4,
        blocked: 0,
        failed: 0,
      },
      jobs: [
        {
          jobId: "2026-w44-item-1",
          contentId: "item-1",
          title: "Topic 1",
          category: "news",
          state: "PACKAGE_READY",
          stepsCompleted: ["research", "script", "localize", "render", "qa", "review", "package"],
          stepsReused: [],
          qaVerdict: "passed",
          reviewStatus: "approved",
          packageStatus: "packaged",
          packagePath: "jobs/2026-w44-item-1/package",
          packageManifestSha256: dummyHash,
        },
      ],
      notes: ["4/7 packaged"],
    };

    const res = validateArtifact(BatchReportSchema, report);
    expect(res.ok).toBe(true);
  });

  it("createZipArchive generates a valid, standard ZIP buffer and rejects path traversal", () => {
    const file1Data = Buffer.from("Hello CreatorFlow video package!\n", "utf8");
    const file2Data = Buffer.from("Second file in zip package\n", "utf8");

    const zipBuf = createZipArchive([
      { path: "manifest.json", data: file1Data },
      { path: "subtitles/en.vtt", data: file2Data },
    ]);

    expect(zipBuf.length).toBeGreaterThan(0);
    // Standard zip signature check 0x04034b50 -> 'PK\x03\x04'
    expect(zipBuf[0]).toBe(0x50);
    expect(zipBuf[1]).toBe(0x4b);
    expect(zipBuf[2]).toBe(0x03);
    expect(zipBuf[3]).toBe(0x04);

    // Rejection of traversal
    expect(() =>
      createZipArchive([{ path: "../outside.txt", data: Buffer.from("bad", "utf8") }]),
    ).toThrow(/traversal/i);
  });

  it("verifyPackage and exportPackage enforce integrity checks", async () => {
    const pkgDir = path.join(tmp.dir, "pkg");
    await fs.mkdir(pkgDir, { recursive: true });

    const videoData = Buffer.from("fake-mp4-data-bytes-for-package-test", "utf8");
    const videoSha = `sha256:${sha256Hex(videoData)}`;
    await fs.writeFile(path.join(pkgDir, "video.mp4"), videoData);

    const manifest: PackageManifest = {
      schemaVersion: 1,
      kind: "package-manifest",
      jobId: "2026-w44-unit-pkg",
      contentId: "unit-pkg",
      weekId: "2026-W44",
      plan: { version: 1, planHash: dummyHash, itemHash: dummyHash },
      packagedAt: new Date().toISOString(),
      delivery: { status: "packaged", notes: [] },
      metadata: {
        title: "Unit Pkg",
        category: "tutorial",
        primaryLanguage: "en",
        platform: "youtube-shorts",
        durationSec: 10,
        tags: [],
      },
      qa: { reportSha256: dummyHash, technicalQa: "passed" },
      review: { status: "not-required", reason: "waived by profile" },
      files: [
        {
          path: "video.mp4",
          sha256: videoSha,
          bytes: videoData.length,
          role: "video",
          contentType: "video/mp4",
        },
      ],
      omissions: [],
    };

    await fs.writeFile(path.join(pkgDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    // 1. Initial valid package verification
    const v1 = await verifyPackage(pkgDir);
    expect(v1.ok).toBe(true);
    expect(v1.issues).toEqual([]);
    expect(v1.fileCount).toBe(1);

    // 2. Export to Directory
    const exportDir = path.join(tmp.dir, "exported-dir");
    const expDirRes = await exportPackage(pkgDir, exportDir);
    expect(expDirRes.type).toBe("dir");
    expect(await fs.readFile(path.join(exportDir, "video.mp4"))).toEqual(videoData);

    // 3. Export to Zip
    const exportZip = path.join(tmp.dir, "exported-pkg.zip");
    const expZipRes = await exportPackage(pkgDir, exportZip);
    expect(expZipRes.type).toBe("zip");
    const zipStat = await fs.stat(exportZip);
    expect(zipStat.size).toBeGreaterThan(0);

    // 4. Tampered file is detected
    await fs.writeFile(path.join(pkgDir, "video.mp4"), "tampered-content-bytes");
    const vTampered = await verifyPackage(pkgDir);
    expect(vTampered.ok).toBe(false);
    expect(vTampered.issues.some((i) => i.includes("hash mismatch"))).toBe(true);

    // Exporting tampered package must fail
    await expect(exportPackage(pkgDir, path.join(tmp.dir, "fail.zip"))).rejects.toThrow(
      /Cannot export unverified or defective package/,
    );

    // Restore video, add untracked extra file
    await fs.writeFile(path.join(pkgDir, "video.mp4"), videoData);
    await fs.writeFile(path.join(pkgDir, "untracked-rogue.txt"), "untracked file");
    const vUntracked = await verifyPackage(pkgDir);
    expect(vUntracked.ok).toBe(false);
    expect(vUntracked.issues.some((i) => i.includes("extraneous file"))).toBe(true);
  });
});
