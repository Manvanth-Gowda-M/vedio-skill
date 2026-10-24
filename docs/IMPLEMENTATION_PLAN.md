# Implementation plan

Each stage ends with tests run, generated files inspected, this plan and `docs/PROJECT_NOTES.md` updated. Commits only when the user asks.

| Stage | Scope | Acceptance tests | Status |
|---|---|---|---|
| A | Audit, ADR, plan, test baseline | ADR 0001 written; typecheck + vitest wired | **done** |
| B | Skill, config, schemas, CLI skeleton, diagnostics | Profile/config schema tests; secret, path-safety, atomic-write tests; init (flags, answers, prompts, preserve, idempotent, backups); doctor with injected deps; skill spec validation + install per agent; e2e CLI runs via the real launcher | **done**: 83/83 tests, typecheck clean (2026-10-22) |
| C | Orchestrator: state machine, job store, retries, resume, `status`/`resume`, plan approval + versioning | Transition table tests; bounded retries; resume after injected failure keeps successful artifacts; atomic state; dependency-aware invalidation by content hash | **done**: 285/285 tests, typecheck clean, 3 consecutive green runs (2026-10-22) |
| D | Research records, `manual-sources` provider, topic scoring, `research`, `plan-week` | Evidence-record schema; freshness flags; scoring determinism; 7-item plan with diversification and honest shortage reporting; no-provider path produces labelled backlog; research step executor attached to the pipeline | **done**: 336/336 tests, typecheck clean, 3 consecutive green runs (2026-10-22) |
| E | Script and scene-manifest schemas, script templates, localization with glossary and subtitle checks; script executor consuming `research/evidence.json` (every fact cites a pack claim) | Manifest validation; glossary preservation; subtitle CPS/line-length/timing checks; unresolved translations flagged; no uncited facts | **done**: 406/406 tests, typecheck clean, 3 consecutive green runs (2026-10-22) |
| F | `apps/remotion-studio` components and templates, `packages/video-engine`, `render` | Real short render of a fixture manifest through Remotion; output verified by exit status and file inspection | **done**: 443/443 tests, typecheck clean, 3 consecutive green runs; real 1080×1920 30 fps 648-frame H.264 render verified with ffprobe and decoded frames (2026-10-22) |
| G | Asset registration commands (on top of the Stage F `workspace/assets/registry.json`), provenance and licences, video assets for screen-capture scenes, provider-neutral TTS (local option if feasible) with narration-driven timing, optional image adapter | Contract tests per provider interface; unsupported providers return typed "unavailable"; audio stream present in renders when voice is enabled | **done** (image adapter not built): see Stage G status in PROJECT_NOTES; real 1080×1920 render with a registered clip and real Windows SAPI narration, audio verified from the decoded output (2026-10-23) |
| H | Quality gates: technical (ffprobe), editorial, research, asset; `qa` | Each check unit-tested with fixtures; real ffprobe check labelled and skipped only when FFmpeg is absent | **done** (2026-10-23): QA step + review gate; real silent and narrated Remotion renders pass real QA; defects caught with simulated renders; loudness (LUFS) not measured |
| I | Publishing packages and batch report; `report` | Package manifest links every deliverable; per-platform metadata; batch summary counts | **done** (2026-10-23): Package executor and CLI (show, run, verify, export); deterministic zip; batch orchestration with sequential concurrency 1, failure isolation, resume, and validated batch-report.json |
| J | Agent compatibility checks, security review, docs, release readiness | Definition-of-done walkthrough | |

## Stage I plan (executed)

1. Schemas (`packages/schemas/src/package.ts`):
   - PackageManifestSchema (kind: "package-manifest", delivery status: "packaged", per-platform metadata, SHA-256 and byte sizes of all deliverables).
   - BatchReportSchema (kind: "batch-report", weekId, plan content hash, summary counts, per-job state histories).
   - JSON schemas built via `npm run schemas:build`.
2. Pure utilities (`packages/core/src/zip.ts`):
   - Deterministic, zero-dependency ZIP archive creator using Node's native `zlib.deflateRawSync` and `zlib.crc32`.
   - Lexicographical entry ordering, normalized forward-slash paths, fixed timestamps for bit-for-bit reproducibility.
3. Packaging step executor (`packages/qa/src/package.ts`):
   - Attached to pipeline step `package` (from `REVIEWED` to `PACKAGE_READY`).
   - Copies verified deliverables (video, captions, subtitles, thumbnail, metadata, qa report, review decision).
   - Atomic staging directory swap into `package/`.
   - Manifest integrity verification and zip export.
4. Batch orchestration (`packages/orchestrator/src/batch.ts`):
   - Orchestrates 7-video weekly production sequentially (concurrency 1).
   - Failure isolation across jobs; resume reuses verified steps.
   - Generates validated `batch-report.json` in week directory.
5. CLI:
   - `creatorflow package run|show|verify|export`.
   - `creatorflow batch status|run|resume|report` and top-level alias `creatorflow report`.

## Stage G plan (executed)

1. Spike: SAPI voices via System.Speech (two desktop voices; OneCore voices not exposed), Piper licence/maintenance status (rhasspy archived, successor GPL-3.0; nothing installed), the bundled FFmpeg's encoders/decoders, and Remotion `OffthreadVideo`/`Audio` props.
2. Schemas:
   - registry v1|v2 union with provenance, measured media and clip uses;
   - `config.assets` / `config.voice`;
   - `NARRATED` state and new artifact roles;
   - `NarrationRecord`;
   - subtitle timing enum;
   - optional render-request/report fields for audio, clips, narration and caption validation.
3. `packages/video-engine`:
   - media probing and decode check;
   - registry store (lock, CAS, `.prev`, recovery, v1 migration);
   - video-aware asset checks, slot compatibility and clip validation;
   - narrated timeline in queue/props;
   - audio verification of the output.
4. `packages/voice` (new):
   - WAV parse/write and measurement;
   - provider interface with `none`, `windows-sapi` and `piper`;
   - timeline composition;
   - narrate executor with a sentence cache;
   - re-timing of localized tracks.
   `scriptwriter` gains aligned tracks and timing-aware VTT.
5. Remotion: ScreenCapture component, framed/backdrop clips (OffthreadVideo, muted, held last frame), attribution line, narration `<Audio>`. Worker: AAC, bounded OffthreadVideo cache.
6. Orchestrator: optional outputs; verified-output readers moved here; `runProcess` stdin.
7. CLI:
   - `assets list|inspect|register|update|validate|remove|recover`;
   - `voice providers|test`;
   - `render config/status/run` show voice, audio and clips;
   - doctor checks the bundled ffmpeg and voice readiness;
   - `subtitles export` uses aligned timing.

## Stage F plan (executed)

1. Feasibility spike: Remotion 4.0.538 bundling + render with system Chrome (`chrome-for-testing` mode, no download); bundled ffprobe inspection.
2. `apps/remotion-studio`: props contract, 9 scene components, captions, progress, font loading with verified `unicode-range`.
3. `packages/video-engine`: cmap glyph-coverage, offline font resolution, asset registry checks, MP4 container walk + ffprobe inspection, isolated render worker (process-tree kill, parent watchdog), render report.
4. Engine: `dependsOn` for non-adjacent verified inputs; core `runProcess` / `killProcessTree`.
5. Executors for `assets`, `queue-render`, `render`; CLI `render run|status|config`; doctor recognises the bundled ffprobe.

## Stage E plan (executed)

1. Schemas (`packages/schemas/src/script.ts`): canonical script, segments, claim references, visual direction, storyboard and scenes, asset requirements, subtitle tracks, scene manifest, glossary, translation import, localization variants. Optional `config.script` / `config.localization`, optional glossary `category` / `preferred`.
2. `packages/scriptwriter`: deterministic English `template` provider behind a `ScriptProvider` interface, provider-independent evidence validation, storyboard, scene manifest, Unicode-safe subtitles and SRT/VTT export, script executor (4 verified outputs).
3. `packages/localization`: glossary, human translation templates and validation, `TranslationProvider` interface (`import-only`), localize executor that blocks until every target language is valid.
4. Engine: `externalInputs` fingerprint hook, approved plan reference in the step context, reuse advances state after an upstream byte-identical re-run.
5. CLI: `script show|validate`, `storyboard inspect`, `localize template|import|validate`, `subtitles export`.

## Stage D plan (executed)

1. Schemas (`packages/schemas/src/research.ts`): user-authored research input (sources, claims with evidence, topic candidates), stored session records, planning-run record, research evidence pack. Optional `config.research` block (scoring weights, eligibility thresholds). New plan-item fields are optional **without defaults** so existing plan hashes stay valid.
2. `packages/research` (new): text utilities (safe HTML-to-text, normalisation, tokens, prompt-injection markers), provider interface + registry (`manual-sources` local provider; everything else returns a typed unsupported result), session store (locked, revisioned, no-op on identical imports), scoring (`cf-score-v1`), planner, research step executor.
3. Production pipeline moves from `packages/orchestrator` to `packages/cli/src/pipeline.ts` so the engine stays generic and the CLI composes executors; only `research` gets an executor.
4. CLI: `research` (import / inspect / rank) and `plan-week` (saves an unapproved version through the existing `PlanStore`).
5. Tests: schema + freshness, provenance, scoring determinism, eligibility, planner, executor, real-process e2e including an interrupted research step.

## Stage C plan

Smallest change set on top of Stage B (no new runtime dependencies, no database):

1. `packages/core`: canonical JSON + versioned fingerprints, `sha256File`, exclusive (no-overwrite) atomic create, PID-validated lock files, stale temp-file cleanup, `AbortSignal` support in `runCommand`, exit codes `5` (conflict) / `6` (not found) / `130` (interrupted).
2. `packages/schemas`: `workflow.ts` with weekly-plan content, plan version, plan index (versions + approval events) and job record schemas; optional `workflow` retry/timeout block in the config (defaults keep existing configs valid, so no migration).
3. `packages/orchestrator` (new, real code only): central transition rules, pipeline definitions validated against them, file-backed `JobStore` (CAS revision, `.prev` backup, corrupt-file quarantine), `PlanStore` (immutable numbered versions, hash-bound approvals), and the step runner (bounded retries with exponential backoff, timeouts via `AbortSignal`, output verification, fingerprint-based reuse and invalidation, interrupted-attempt recovery).
4. CLI: `plan add` (import an edited plan as the next version — the only way to create versions until Stage D's `plan-week`), `approve-plan`, `status`, `resume`. The production pipeline declares Stage D–I steps with no executor, so `resume` reports jobs as `BLOCKED: EXECUTOR_UNAVAILABLE` rather than pretending progress.
5. Tests: transition matrix, persistence/recovery, retries/timeouts, invalidation, plans/approvals, locks, plus a child-process acceptance test that kills a real process mid-step and resumes in a new one. Fixture step executors are injected through a test-only launcher that calls the real `main()`.

Deviations from the earlier sketch: state lives in `workspace/jobs/<jobId>/` and `workspace/plans/<week>/` (not `workspace/state/`); job IDs are `<week>-<contentId>` using the plan's persisted content ID, so they never depend on item order.
