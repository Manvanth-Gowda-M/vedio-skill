# ADR 0008 — Packaging, delivery manifests, and seven-video batch orchestration

Status: accepted (Stage I) · Date: 2026-10-23

## Context

Stage H introduced the technical QA and human review gates (`qa` and `review` steps), leaving approved jobs in the `REVIEWED` state with delivery status `ready-for-packaging`. However, packaging delivery artifacts and orchestrating full seven-video weekly batches remained unimplemented.

Packaging requires collecting all verified job deliverables (rendered MP4 video, subtitles, metadata, thumbnail/preview, QA report, and human review decision) into an immutable, self-contained `package/` folder with a cryptographically verifiable `manifest.json`.

Batch orchestration requires executing all planned videos for an approved weekly plan (typically 7 videos) with failure isolation, strict sequential concurrency (to preserve host memory during browser rendering), idempotent resume capability, and full batch reporting.

## Decisions

1. **Schemas in `@creatorflow/schemas`**:
   - `PackageManifestSchema`: defines `schemaVersion: 1`, `kind: "package-manifest"`, `jobId`, `contentId`, `weekId`, `itemHash`, `generatedAt`, `delivery: { status: "packaged", ... }`, `metadata: { title, category, targetDurationSec, language, tags }`, `files: Record<string, PackageFileEntry>`, and `hashes: { videoSha256, qaReportSha256, reviewDecisionSha256, manifestContentSha256 }`.
   - `BatchReportSchema`: defines `schemaVersion: 1`, `kind: "batch-report"`, `weekId`, `plan: { version, contentHash, approvedAt, approvedBy }`, `summary: { total, planned, inProgress, packaged, failed, blocked }`, and per-job statuses with step histories.
   - Built with `npm run schemas:build` into `package-manifest.schema.json` and `batch-report.schema.json`.

2. **Deterministic, Zero-Dependency ZIP Creation (`@creatorflow/core`)**:
   - Implemented `createZipArchive` in `packages/core/src/zip.ts` using Node.js built-in `zlib.deflateRawSync` and `zlib.crc32`.
   - Normalizes path separators to forward slashes, sorts entry names lexicographically, and fixes DOS timestamps (2026-01-01 00:00:00) so repeated exports of identical files produce byte-identical ZIP files.
   - Masks external file attributes with `((0o100644 << 16) >>> 0)` to avoid JavaScript 32-bit signed integer overflow.

3. **Packaging Step Execution & Verification (`@creatorflow/qa`)**:
   - `packageStepExecute`: attached to pipeline step `package` (`from: "REVIEWED"`, `to: "PACKAGE_READY"`).
   - Reads upstream outputs only through `readVerifiedOutput` and `verifiedBinaryOutput`. If review decision is not `approved` or hashes mismatch, the step blocks.
   - Staging: files are copied into `.package-staging-${process.pid}-${Date.now()}` within the job directory and verified before atomically renaming to `package`. If the target exists, it is backed up and replaced atomically.
   - Verification (`verifyPackage`): inspects all files listed in `package/manifest.json`, recomputes their SHA-256 hashes and byte sizes, and confirms zero missing, altered, or unmanifested files.
   - Export (`exportPackage`): packages the verified folder into a ZIP archive at the requested output path.

4. **Batch Orchestration (`@creatorflow/orchestrator`)**:
   - `runBatch`: synchronizes jobs from the approved weekly plan version.
   - Executes jobs sequentially (concurrency 1) to respect memory and GPU constraints under Chrome Remotion rendering.
   - Isolates failures: if a job encounters a step failure or blocking condition, `runBatch` captures the failure, continues to subsequent jobs, and records all statuses.
   - Resume capability: running batch again reuses all verified steps and resumes only incomplete or failed jobs.
   - Batch report generation: writes `batch-report.json` atomically to the week directory (`paths.weekDir(weekId)`).

5. **CLI Commands (`@creatorflow/cli`)**:
   - `creatorflow package run --job <id>`: runs packaging for a reviewed job.
   - `creatorflow package show --job <id>`: displays the package manifest.
   - `creatorflow package verify --job <id>`: independently verifies package file integrity against manifest hashes.
   - `creatorflow package export --job <id> --out <path.zip>`: creates a zip archive of the delivery package.
   - `creatorflow batch status --week <week>`: inspects batch status and prints summary.
   - `creatorflow batch run --week <week>`: triggers full batch execution.
   - `creatorflow batch resume --week <week>`: resumes batch production.
   - `creatorflow batch report --week <week>` and top-level alias `creatorflow report --week <week>`: outputs the validated `batch-report.json`.

## Consequences

- Full lifecycle from research to approved plan to rendering, QA, human review, packaging, and batch reporting is now fully operational and automated.
- Zero external native dependencies added; all ZIP and manifest operations rely entirely on standard Node.js APIs.
- The pipeline now terminates at `PACKAGE_READY` (step 10/10).
