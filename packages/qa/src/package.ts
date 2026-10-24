import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  assertSafeId,
  copyDir,
  createZipArchive,
  CreatorFlowError,
  ExitCode,
  fingerprint,
  resolveWithin,
  sha256File,
  sha256Hex,
  stringifyJson,
  writeFileAtomic,
  writeJsonAtomic,
} from "@creatorflow/core";
import {
  readVerifiedOutput,
  StepError,
  verifiedBinaryOutput,
  type FingerprintContext,
  type StepContext,
  type StepResult,
} from "@creatorflow/orchestrator";
import {
  PackageFileRole,
  PackageManifestSchema,
  QaReportSchema,
  ReviewDecisionSchema,
  ReviewRecordSchema,
  validateArtifact,
  type PackageFileEntry,
  type PackageManifest,
  type PackageOmission,
  type ReviewRecord,
  type QaReport,
} from "@creatorflow/schemas";
import { QA_OUTPUTS } from "./executor.ts";
import { REVIEW_DECISION, REVIEW_OUTPUTS } from "./review.ts";

export const PACKAGE_OUTPUTS = { manifest: "package/manifest.json" } as const;

export const packageStepInputs = (ctx: FingerprintContext): unknown => ({
  contentId: ctx.item.contentId,
  title: ctx.item.topic,
});

export const packageStepConfig = (ctx: FingerprintContext): unknown => ({
  brand: ctx.profile.brand,
  platforms: ctx.profile.platforms,
  languages: ctx.profile.languages,
});

export async function packageStepExternalInputs(_ctx: FingerprintContext & { workspaceDir: string }): Promise<unknown> {
  return {};
}

interface StagedFile {
  relPath: string;
  role: PackageFileRole;
  contentType: string;
  absPath: string;
}

/**
 * Packaging executor (REVIEWED -> PACKAGE_READY).
 * Packages all verified deliverables into an immutable delivery bundle under `package/`.
 */
export async function packageStepExecute(ctx: StepContext): Promise<StepResult> {
  // 1. Verify upstream review record
  const rr = await readVerifiedOutput(ctx, "review", REVIEW_OUTPUTS.record);
  if (!rr.ok) return { status: "blocked", code: rr.code, reason: rr.reason };
  const rrv = validateArtifact(ReviewRecordSchema, JSON.parse(rr.file.raw));
  if (!rrv.ok) throw new StepError("review/record.json is invalid", { kind: "permanent", code: "REVIEW_RECORD_INVALID" });
  const reviewRecord = rrv.value;
  if (reviewRecord.deliveryReadiness.status !== "ready-for-packaging") {
    return {
      status: "blocked",
      code: "NOT_READY_FOR_PACKAGING",
      reason: `job is not ready for packaging: ${reviewRecord.deliveryReadiness.notes.join("; ")}`,
    };
  }

  // 2. Verify upstream QA report
  const qr = await readVerifiedOutput(ctx, "qa", QA_OUTPUTS.report);
  if (!qr.ok) return { status: "blocked", code: qr.code, reason: qr.reason };
  const qrv = validateArtifact(QaReportSchema, JSON.parse(qr.file.raw));
  if (!qrv.ok) throw new StepError("qa/report.json is invalid", { kind: "permanent", code: "QA_REPORT_INVALID" });
  const qaReport = qrv.value;
  if (qaReport.technicalQa.status !== "passed") {
    return {
      status: "blocked",
      code: "QA_NOT_PASSED",
      reason: `technical QA status is ${qaReport.technicalQa.status}; only passed jobs can be packaged`,
    };
  }

  // Confirm review record matches current QA report
  if (reviewRecord.qaReport.sha256 !== qr.file.sha256) {
    return {
      status: "blocked",
      code: "REVIEW_STALE",
      reason: "the reviewed QA report hash does not match the current QA report",
    };
  }

  // 3. Verify final render output
  const vr = await verifiedBinaryOutput(ctx, "render", "render/output.mp4");
  if (!vr.ok) return { status: "blocked", code: vr.code, reason: vr.reason };
  if (vr.sha256 !== qaReport.render.outputSha256) {
    return {
      status: "blocked",
      code: "RENDER_OUTPUT_MISMATCH",
      reason: `rendered video hash (${vr.sha256.slice(0, 16)}) does not match QA report video hash (${qaReport.render.outputSha256.slice(0, 16)})`,
    };
  }
  if (vr.sha256 !== reviewRecord.video.sha256) {
    return {
      status: "blocked",
      code: "REVIEW_VIDEO_MISMATCH",
      reason: "rendered video hash does not match the reviewed video hash",
    };
  }

  // 4. Verify render report
  const rrr = await readVerifiedOutput(ctx, "render", "render/report.json");
  if (!rrr.ok) return { status: "blocked", code: rrr.code, reason: rrr.reason };

  // 5. Verify script & scene manifest
  const sr = await readVerifiedOutput(ctx, "script", "script/script.json");
  if (!sr.ok) return { status: "blocked", code: sr.code, reason: sr.reason };
  const smr = await readVerifiedOutput(ctx, "script", "script/scene-manifest.json");
  if (!smr.ok) return { status: "blocked", code: smr.code, reason: smr.reason };

  // 6. Setup Staging Directory
  const stagingName = `.package.staging.${process.pid}.${randomBytes(4).toString("hex")}`;
  const stagingDir = ctx.outputPath(stagingName);
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    const stagedFiles: StagedFile[] = [];
    const omissions: PackageOmission[] = [];

    // Helper: copy an external file safely into staging
    async function stageFile(srcAbs: string, relDest: string, role: PackageFileRole, contentType: string): Promise<void> {
      const destAbs = resolveWithin(stagingDir, relDest);
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.copyFile(srcAbs, destAbs);
      stagedFiles.push({ relPath: relDest, role, contentType, absPath: destAbs });
    }

    // Helper: write JSON safely into staging
    async function stageJson(relDest: string, role: PackageFileRole, data: unknown): Promise<void> {
      const destAbs = resolveWithin(stagingDir, relDest);
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.writeFile(destAbs, stringifyJson(data), "utf8");
      stagedFiles.push({ relPath: relDest, role, contentType: "application/json", absPath: destAbs });
    }

    // Copy Final Video
    await stageFile(vr.abs, "video.mp4", "video", "video/mp4");

    // Copy Subtitles
    let hasSubtitles = false;
    // Check narration subtitles or localization subtitles or captions
    const subOutputs = [
      "narration/subtitles.vtt",
      "subtitles/en.vtt",
      "script/captions.vtt",
    ];
    for (const rel of subOutputs) {
      const abs = resolveWithin(ctx.jobDir, rel);
      try {
        await fs.access(abs);
        await stageFile(abs, "subtitles/en.vtt", "subtitles", "text/vtt");
        hasSubtitles = true;
        break;
      } catch {}
    }

    // Also look for .srt
    for (const rel of ["narration/subtitles.srt", "subtitles/en.srt", "script/captions.srt"]) {
      const abs = resolveWithin(ctx.jobDir, rel);
      try {
        await fs.access(abs);
        await stageFile(abs, "subtitles/en.srt", "subtitles", "application/x-subrip");
        break;
      } catch {}
    }

    // Check localized subtitles if any
    try {
      const localizedDir = resolveWithin(ctx.jobDir, "subtitles");
      const entries = await fs.readdir(localizedDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && (e.name.endsWith(".vtt") || e.name.endsWith(".srt"))) {
          const destRel = `subtitles/${e.name}`;
          if (!stagedFiles.some((f) => f.relPath === destRel)) {
            await stageFile(path.join(localizedDir, e.name), destRel, "subtitles", e.name.endsWith(".vtt") ? "text/vtt" : "application/x-subrip");
            hasSubtitles = true;
          }
        }
      }
    } catch {}

    if (!hasSubtitles) {
      omissions.push({ role: "subtitles", reason: "no standalone VTT/SRT subtitle files present in job outputs" });
    }

    // Copy Script & Scene Manifest
    await stageFile(resolveWithin(ctx.jobDir, "script/script.json"), "script/script.json", "script", "application/json");
    await stageFile(resolveWithin(ctx.jobDir, "script/scene-manifest.json"), "script/scene-manifest.json", "sceneManifest", "application/json");

    // Copy Storyboard if available
    const storyboardAbs = resolveWithin(ctx.jobDir, "script/storyboard.json");
    try {
      await fs.access(storyboardAbs);
      await stageFile(storyboardAbs, "script/storyboard.json", "storyboard", "application/json");
    } catch {}

    // Extract & Stage Attribution Metadata
    const scriptObj = JSON.parse(sr.file.raw) as { title?: string; segments?: Array<{ references?: unknown[] }> };
    let evidenceObj: { sources?: unknown[]; claims?: unknown[] } | undefined;
    try {
      const rawEvidence = await fs.readFile(resolveWithin(ctx.jobDir, "research/evidence.json"), "utf8");
      evidenceObj = JSON.parse(rawEvidence);
    } catch {}

    const attribution = {
      schemaVersion: 1,
      kind: "source-attribution",
      jobId: ctx.jobId,
      contentId: ctx.item.contentId,
      title: ctx.item.topic,
      sources: evidenceObj?.sources ?? [],
      claims: evidenceObj?.claims ?? [],
      segmentReferences: scriptObj.segments?.flatMap((s) => s.references ?? []) ?? [],
    };
    await stageJson("metadata/attribution.json", "attribution", attribution);

    // Extract & Stage Asset Provenance
    let assetProvenance: unknown[] = [];
    try {
      const regRaw = await fs.readFile(resolveWithin(ctx.workspaceDir, "assets/registry.json"), "utf8");
      const reg = JSON.parse(regRaw);
      const sceneManifest = JSON.parse(smr.file.raw) as { scenes?: Array<{ assets?: string[] }> };
      const usedAssetIds = new Set(sceneManifest.scenes?.flatMap((s) => s.assets ?? []) ?? []);
      assetProvenance = (reg.assets as Array<{ id: string }> ?? []).filter((a) => usedAssetIds.has(a.id));
    } catch {}

    await stageJson("metadata/assets.json", "provenance", {
      schemaVersion: 1,
      kind: "asset-provenance",
      jobId: ctx.jobId,
      assets: assetProvenance,
    });

    // Copy Reports
    await stageFile(resolveWithin(ctx.jobDir, "render/report.json"), "reports/render-report.json", "renderReport", "application/json");
    await stageFile(resolveWithin(ctx.jobDir, "qa/report.json"), "reports/qa-report.json", "qaReport", "application/json");
    await stageFile(resolveWithin(ctx.jobDir, "review/record.json"), "reports/review-record.json", "reviewRecord", "application/json");

    // Copy Review Decision if present
    const decisionAbs = resolveWithin(ctx.jobDir, REVIEW_DECISION);
    try {
      await fs.access(decisionAbs);
      await stageFile(decisionAbs, "reports/review-decision.json", "reviewDecision", "application/json");
    } catch {}

    // Copy Thumbnail / Preview if available
    let hasThumbnail = false;
    if (qaReport.frames && qaReport.frames.samples && qaReport.frames.samples.length > 0) {
      const sample = qaReport.frames.samples[0]!;
      const frameAbs = resolveWithin(ctx.jobDir, sample.path);
      try {
        await fs.access(frameAbs);
        await stageFile(frameAbs, "preview/thumbnail.png", "thumbnail", "image/png");
        hasThumbnail = true;
      } catch {}
    }
    if (!hasThumbnail) {
      omissions.push({ role: "thumbnail", reason: "no verified preview frame or thumbnail image available in QA report" });
    }

    // Hash and build file entries
    const fileEntries: PackageFileEntry[] = [];
    for (const staged of stagedFiles) {
      const h = await sha256File(staged.absPath);
      fileEntries.push({
        path: staged.relPath,
        sha256: h.sha256,
        bytes: h.bytes,
        role: staged.role,
        contentType: staged.contentType,
      });
    }

    // Sort files deterministically by relative path
    fileEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // Construct PackageManifest
    const manifest: PackageManifest = {
      schemaVersion: 1,
      kind: "package-manifest",
      jobId: ctx.jobId,
      contentId: ctx.item.contentId,
      weekId: ctx.plan.weekId,
      plan: {
        version: ctx.plan.version,
        planHash: ctx.plan.contentHash,
        itemHash: fingerprint(ctx.item),
      },
      packagedAt: new Date().toISOString(),
      delivery: {
        status: "packaged",
        notes: [
          `packaged from approved plan ${ctx.plan.weekId} v${ctx.plan.version}`,
          `technical QA passed, review status: ${reviewRecord.review.status}`,
        ],
      },
      metadata: {
        title: ctx.item.topic,
        category: ctx.item.category,
        primaryLanguage: ctx.profile.languages.primary,
        platform: ctx.profile.platforms.primary,
        durationSec: qaReport.media.video?.durationSec ?? 30,
        tags: [ctx.item.topic],
      },
      qa: {
        reportSha256: qr.file.sha256,
        technicalQa: "passed",
      },
      review: reviewRecord.review,
      files: fileEntries,
      omissions,
    };

    // Validate PackageManifest against schema
    const mv = validateArtifact(PackageManifestSchema, manifest);
    if (!mv.ok) {
      throw new StepError(`Generated package manifest is invalid: ${mv.issues[0]?.message}`, {
        kind: "permanent",
        code: "PACKAGE_MANIFEST_INVALID",
      });
    }

    // Write manifest.json into staging directory
    await writeJsonAtomic(resolveWithin(stagingDir, "manifest.json"), mv.value);

    // Atomic directory swap
    const targetDir = ctx.outputPath("package");
    const oldDir = ctx.outputPath(`.package.old.${process.pid}.${randomBytes(4).toString("hex")}`);

    const targetExists = await fs.access(targetDir).then(() => true, () => false);
    if (targetExists) {
      await fs.rename(targetDir, oldDir);
    }
    try {
      await fs.rename(stagingDir, targetDir);
      if (targetExists) {
        await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (swapErr) {
      if (targetExists) {
        await fs.rename(oldDir, targetDir).catch(() => {});
      }
      throw swapErr;
    }

    const totalBytes = fileEntries.reduce((acc, f) => acc + f.bytes, 0);
    return {
      status: "succeeded",
      metadata: {
        fileCount: fileEntries.length,
        totalBytes,
        videoBytes: vr.bytes,
      },
    };
  } finally {
    // Clean up temporary staging dir if it still exists
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface PackageVerificationResult {
  ok: boolean;
  issues: string[];
  manifest?: PackageManifest;
  fileCount?: number;
  totalBytes?: number;
}

/**
 * Independently verifies an existing package bundle against its manifest and integrity rules.
 */
export async function verifyPackage(packageDir: string): Promise<PackageVerificationResult> {
  const issues: string[] = [];
  const manifestFile = resolveWithin(packageDir, "manifest.json");

  let rawManifest: string;
  try {
    rawManifest = await fs.readFile(manifestFile, "utf8");
  } catch {
    return { ok: false, issues: ["manifest.json not found in package directory"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch (err) {
    return { ok: false, issues: [`manifest.json is not valid JSON: ${(err as Error).message}`] };
  }

  const v = validateArtifact(PackageManifestSchema, parsed);
  if (!v.ok) {
    return { ok: false, issues: v.issues.map((i) => `schema error at ${i.path}: ${i.message}`) };
  }
  const manifest = v.value;

  // Scan all files physically in packageDir
  const diskFiles = new Set<string>();
  async function walk(dir: string, prefix = ""): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, rel);
      } else if (e.isFile()) {
        diskFiles.add(rel);
      } else {
        issues.push(`non-regular file found in package: ${rel}`);
      }
    }
  }
  await walk(packageDir);

  // Check manifest files
  const manifestFileSet = new Set<string>();
  let totalBytes = 0;

  for (const entry of manifest.files) {
    manifestFileSet.add(entry.path);
    if (entry.path.split("/").includes("..")) {
      issues.push(`path traversal detected in manifest: ${entry.path}`);
      continue;
    }
    const full = resolveWithin(packageDir, entry.path);
    try {
      const stat = await fs.stat(full);
      if (stat.size !== entry.bytes) {
        issues.push(`size mismatch for ${entry.path}: expected ${entry.bytes} bytes, found ${stat.size}`);
      }
      const h = await sha256File(full);
      if (h.sha256 !== entry.sha256) {
        issues.push(`hash mismatch for ${entry.path}: expected ${entry.sha256}, calculated ${h.sha256}`);
      }
      totalBytes += entry.bytes;
    } catch {
      issues.push(`missing packaged file: ${entry.path}`);
    }
  }

  // Check for untracked files on disk (excluding manifest.json)
  for (const diskFile of diskFiles) {
    if (diskFile === "manifest.json") continue;
    if (!manifestFileSet.has(diskFile)) {
      issues.push(`extraneous file found in package: ${diskFile}`);
    }
  }

  // Review & QA integrity check
  if (manifest.qa.technicalQa !== "passed") {
    issues.push(`manifest records QA as ${manifest.qa.technicalQa}, expected passed`);
  }
  const reviewStatus = (manifest.review as { status: string }).status;
  if (reviewStatus !== "approved" && reviewStatus !== "not-required") {
    issues.push(`manifest records review status as ${reviewStatus}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    manifest,
    fileCount: manifest.files.length,
    totalBytes,
  };
}

export interface PackageExportResult {
  type: "dir" | "zip";
  outPath: string;
  files: number;
  bytes: number;
}

/**
 * Exports a verified delivery package to a target directory or a .zip archive.
 * Rejects corrupt, tampered or unverified packages.
 */
export async function exportPackage(packageDir: string, outPath: string): Promise<PackageExportResult> {
  const verification = await verifyPackage(packageDir);
  if (!verification.ok) {
    throw new CreatorFlowError(`Cannot export unverified or defective package: ${verification.issues.join("; ")}`, {
      code: "PACKAGE_VERIFICATION_FAILED",
      exitCode: ExitCode.CHECK_FAILED,
    });
  }

  const manifest = verification.manifest!;
  const isZip = outPath.toLowerCase().endsWith(".zip");

  if (isZip) {
    const entries: Array<{ path: string; data: Uint8Array; date?: Date }> = [];
    const manifestBuf = await fs.readFile(resolveWithin(packageDir, "manifest.json"));
    entries.push({ path: "manifest.json", data: manifestBuf, date: new Date(manifest.packagedAt) });

    for (const f of manifest.files) {
      const fileBuf = await fs.readFile(resolveWithin(packageDir, f.path));
      entries.push({ path: f.path, data: fileBuf, date: new Date(manifest.packagedAt) });
    }

    const zipBuffer = createZipArchive(entries);
    await writeFileAtomic(outPath, zipBuffer);

    return {
      type: "zip",
      outPath,
      files: entries.length,
      bytes: zipBuffer.length,
    };
  } else {
    await fs.mkdir(outPath, { recursive: true });
    await copyDir(packageDir, outPath);
    return {
      type: "dir",
      outPath,
      files: manifest.files.length + 1,
      bytes: (verification.totalBytes ?? 0) + (await fs.stat(resolveWithin(packageDir, "manifest.json"))).size,
    };
  }
}
