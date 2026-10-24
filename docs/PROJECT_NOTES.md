# Project notes

Persistent notes for whoever (human or agent) continues this work.

## Conventions

- TypeScript, erasable syntax only, `.ts` import specifiers; Node ≥ 22.18 runs sources directly. Typecheck with `npm run typecheck`.
- Commands return exit codes from `main()`; never call `process.exit` in library code.
- All persisted writes go through `writeFileAtomic` / `writeJsonAtomic` (`@creatorflow/core`).
- Paths from config/user input go through `resolveWithin`; IDs through `assertSafeId`.
- Subprocesses: `runCommand(file, args)` only.
- After changing Zod schemas run `npm run schemas:build` (a test checks the JSON files are current).
- Zod 4: use `.prefault()` (not `.default()`) when the default should itself be parsed (nested object defaults).
- Workflow state changes only through `applyTransition`; job writes only through `JobStore` (CAS on `revision`); never hand-edit job records to fake progress.
- New executors: attach to a step in `packages/cli/src/pipeline.ts`, declare `inputs`/`config` for fingerprints (no timestamps), pass `ctx.signal` to subprocesses, throw `StepError` with `kind` to classify failures, bump the step `version` when logic changes.
- Read upstream artifacts only via `readVerifiedOutput` / `verifiedBinaryOutput` (`@creatorflow/orchestrator`). Register media only via `creatorflow assets` / `mutateRegistry`.
- Provenance and licences are always claims: never add a "verified" licence state.

## Environment facts (2026-10-22)

- Windows 11, Node 22.20.0, 7.7 GiB RAM, Chrome present, **FFmpeg absent** (Remotion's bundled ffmpeg/ffprobe 7.1 are used instead).
- Spawning `npm.cmd` via `execFile` fails on Windows without a shell; doctor runs `node <npm-cli.js>`.

## Stage B status

Verified on 2026-10-22: `npm run check` → typecheck clean, 7 test files / 83 tests passing (about 7 s). No paid APIs or network needed.

Works (tested): init (flags / answers / preset / interactive prompts / preserve / idempotent / .bak backups / dry-run / secret refusal), doctor (injected-deps unit tests plus a real-machine e2e run), profile validate (exit codes 0/1/3, secret not echoed), skill validate (spec rules plus a check that SKILL.md only lists implemented commands), skill install for kiro, claude-code, opencode, antigravity, antigravity-cli and agents in project and user scope.

Test labelling: `tests/e2e/cli.test.ts` spawns the real launcher with no mocks. `tests/unit/main.test.ts` runs interactive init in-process with a scripted prompter because a child process has no TTY. `tests/unit/doctor.test.ts` uses a fake system; the e2e doctor test runs against the real machine.

Not verified: that each agent actually loads the installed skill in a live session (only file placement is checked). The real TTY prompt (readline) has not been tested automatically.

Not implemented yet: research, plan-week, approve-plan, produce, render, qa, status, resume, report. They are left out of the CLI on purpose rather than stubbed (`creatorflow render` → exit 2, unknown command).

## Stage C status

Verified on 2026-10-22: `npm run check` → typecheck clean, 13 files / 285 tests, green on 3 consecutive runs (~20 s). No network or paid APIs. Design and semantics: `docs/adr/0002-workflow-engine.md`.

Added: `packages/orchestrator` (transitions, pipeline definition, job store, plan store, runner, status, production pipeline), workflow schemas, `config.workflow` (optional; Stage B configs remain valid without migration), core canonical fingerprints / exclusive writes / PID-validated locks / abortable `runCommand`, exit codes 5 / 6 / 130, CLI `plan add`, `approve-plan`, `status`, `resume`.

Test labelling:
- `tests/e2e/workflow.test.ts`: real child processes. The acceptance test SIGKILLs process 1 during a hung step and resumes in process 2. It also covers concurrent processes (lock → exit 5; concurrent `plan add`), CLI exit codes, corrupt-record recovery, and the production CLI. Step executors are fixtures injected by `tests/fixtures/fixture-cli.ts`, which calls the real `main()`.
- `tests/integration/runner.test.ts`: in-process with real files and locks. One test fabricates an interrupted record and is labelled "[simulated crash record]". Cancellation is tested with an `AbortController`, not a real SIGINT.
- The symlink-output test skips itself where symlinks cannot be created (it ran here).
- Mutation check: disabling the "no recorded outputs" guard in `verifyRecordedOutputs` made 2 tests fail, so those paths are exercised.

Gotchas:
- Subcommand option `--version` collides with commander's global `--version`, hence `approve-plan --plan-version`.
- PowerShell mangles quotes in `node -e` one-liners; use a script file when computing reference hashes.
- `JobStore.save` returns a new parsed object; the runner copies `revision`/`updatedAt` back onto its in-memory record so step references stay valid.

Not verified: a real SIGINT delivered to the CLI (Windows cannot send console Ctrl+C to a child from Node); the hard-link fallback path on filesystems without hard links; behaviour on network drives shared between machines (documented as unsupported).

Production pipeline (Stage C state): every step was declared without an executor. Superseded below.

## Stage D status

Verified 2026-10-22: 17 files / 336 tests green on 3 consecutive runs. Offline. Design: `docs/adr/0003-research-and-planning.md`; scoring and eligibility: `skills/creatorflow/references/research-standards.md`.

Added: `packages/research` (text utilities, provider interface + `manual-sources`, session store, assessment, `cf-score-v1` scoring, planner, research executor), research schemas, optional `config.research`, optional Stage D plan-item fields, CLI `research` and `plan-week`, production pipeline moved to `packages/cli/src/pipeline.ts`.

Labelling: all research test data is FICTIONAL (`tests/fixtures/research-fixture.ts`, example.* domains); no test validates live research. Mutation checks: forcing `eligible: true` failed 16 tests; disabling the research-changed check failed 1.

Gotchas: `Object.groupBy` is not in the configured TS lib (es2023). 2026 has 53 ISO weeks. Plan content must stay timestamp-free so `plan-week` is reproducible.

## Stage E status

Verified 2026-10-22: `npm run check`: typecheck clean, 21 files / 406 tests, green on 3 consecutive runs (~36 s). Offline; no paid APIs. Design: `docs/adr/0004-scripts-and-localization.md`; user reference: `skills/creatorflow/references/scripts-and-localization.md`.

Production pipeline now: `research`, `script` and `localize` real; `assets` onward unavailable. Typical outcome with a profile listing additional languages: the script succeeds, localize blocks `NEEDS_TRANSLATION` until a human translation is imported, then assets blocks `EXECUTOR_UNAVAILABLE`. Items whose canonical language is not English block at script with `SCRIPT_LANGUAGE_UNSUPPORTED`. Hand-written plans without `research` links block at research with `NEEDS_RESEARCH`.

Test labelling:
- `tests/e2e/script.test.ts` (acceptance): real child processes. The real script executor is wrapped by `tests/fixtures/fixture-cli.ts` (`CF_FIXTURE_PIPELINE=production`, `hang.json`) to hang, then process 1 is SIGKILLed. Research is fictional; the Hindi text is a fixture sentence, not a real translation.
- `tests/integration/script-step.test.ts`: in-process, real production pipeline. The "evidence edited after verification" test edits a file by hand on purpose.
- `tests/unit/{script,localization}.test.ts`: fixture evidence packs and fixture sentences in hi/kn/ta/te/ml.
- Mutation checks: disabling the localize "missing/invalid → block" guard failed 7 tests; disabling the reuse-advances-state rule failed the `--force-step` runner test.

Gotchas:
- Windows PowerShell `Get-Content`/`Set-Content` round-trips can corrupt or silently skip edits of non-ASCII text (a Devanagari test edit did not apply). Edit such files with the file tool or `[IO.File]::ReadAllText/WriteAllText`.
- Grapheme counts of Indic conjuncts differ across ICU/Unicode versions; tests assert invariants (no cluster starts with a combining mark), not pinned counts.
- Invalidated outputs stay on disk but are removed from the step record; consumers must use recorded outputs and hashes (as `script validate` and `subtitles export` do), never "whatever file is there".

Not verified: real translation quality, font glyph coverage, timing against real audio, LLM providers (none exist).

## Stage F status

Verified 2026-10-22: `npm run check`: typecheck clean, 25 files / 443 tests, green on 3 consecutive runs (~160 s; the real-render tests dominate). Design: `docs/adr/0005-rendering.md`; user reference: `skills/creatorflow/references/rendering.md`.

Real render evidence (tests/integration/render-real.test.ts, every run): 1080×1920, 30 fps, 648 frames, 21.6 s, H.264 yuvj420p, no audio stream, 898,882 bytes (byte-identical across runs), inspected with Remotion's bundled ffprobe; decoded frames show the registered diagram only in its scene, captions in the lower safe area, brand background elsewhere. Render time about 47–108 s depending on load.

Production pipeline now: research, script, localize, assets, queue-render, render real; qa and package unavailable. Rendered jobs end at `BLOCKED: EXECUTOR_UNAVAILABLE` (qa) with `technicalQa: "pending"` in the report.

Environment: no system FFmpeg; Remotion's `@remotion/compositor-win32-x64-msvc` ships ffmpeg/ffprobe 7.1 (a minimal build: no `lavfi` sources, no `rawvideo` muxer). System Chrome 64-bit is driven in `chrome-for-testing` mode; no browser download happened.

Test labelling:
- REAL Remotion: `tests/integration/render-real.test.ts`, `tests/e2e/render.test.ts` (kill during render, recover in a new process, export). Serialised with a cross-file lock (`withRealRenderSlot`) so only one browser render runs at a time.
- SIMULATED renderer: `tests/integration/render-step.test.ts` uses `tests/fixtures/fake-render-worker.ts`, which writes real H.264 files with the bundled ffmpeg (looped PNG) or misbehaves on purpose (fail, empty, garbage, wrong size, hang with a grandchild).
- `tests/integration/script-step.test.ts` stubs only the render step (it tests earlier steps); `tests/e2e/script.test.ts` points the browser at a missing file so no real render runs there.
- Mutation checks: disabling the stream-mismatch guard failed the wrong-size test; disabling the missing-glyph guard failed the Devanagari font test.

Gotchas:
- Workspace packages read via `require.resolve("<pkg>/package.json")` must export `./package.json`.
- `os.tmpdir()` is shared by parallel test files: assert on temp dirs named with the owning PID (`cf-render-<pid>-*`), not on all `cf-render-*`.
- Heavy tests need explicit timeouts (180 s+) because parallel encodes and renders compete for CPU on this 12-thread / 7.7 GiB machine.

Not verified: Edge or Linux/macOS browsers; `headless-shell` download path; 16:9 long-form render (same code path, not rendered in a test); complex-script shaping (no Indic font is installed, so such renders block); screen-recording assets (unsupported by design).

## Stage G status

Verified 2026-10-23: see "Stage G results" at the end of this file. Design: `docs/adr/0006-assets-video-and-narration.md`. User references: `skills/creatorflow/references/assets.md`, `voice.md`, `rendering.md`.

Added:
- `packages/voice`: providers, WAV measurement, timeline, narrate step.
- Registry v2 with provenance, media probing and clip validation in `packages/video-engine`.
- The `NARRATED` state and the `narrate` step.
- CLI `assets …` and `voice providers|test`.
- Audio verification of rendered output; the ScreenCapture, clip and attribution components.

Production pipeline now: research, script, localize, narrate, assets, queue-render, render are real; qa and package are unavailable.

Environment facts (2026-10-23):
- System.Speech exposes only the desktop voices **Microsoft David Desktop** and **Zira Desktop** (en-US, version 11.0). The OneCore voices in Settings (Heera, Ravi en-IN, Mark) are not reachable.
- Piper is not installed. No Noto or other Indic font is installed; Nirmala UI is a system font and is rejected as unverifiable.
- Remotion's bundled ffmpeg has no `wrapped_avframe` encoder, so decode checks use `-c:v rawvideo -f null -`.
- SAPI clamps `SpeakProgress.AudioPosition` oddly at non-default formats (the reported positions exceed the file duration at 22 kHz). CreatorFlow ignores engine timestamps and measures energy instead.

Test labelling:
- REAL speech and REAL Remotion: `tests/integration/media-real.test.ts`. It falls back to a labelled silent clip render where SAPI is unavailable. `tests/e2e/assets.test.ts` runs `voice test` with SAPI only when it is ready.
- SIMULATED voice: `tests/fixtures/sim-voice.ts`, which writes tones proportional to word count or misbehaves on purpose. Used in `tests/integration/narration-step.test.ts` together with the SIMULATED renderer (fake worker modes `drop-audio`, `silent-audio`, `add-audio`).
- REAL media files are generated locally by `tests/fixtures/media.ts`: `makeClip` writes coloured bands encoded with the bundled ffmpeg (H.264/AAC, VP9). There is no third-party footage, and the provenance is stated in the file.
- Defects found by the new tests and fixed:
  - silent engine output was cached before validation and would have been reused;
  - an edited asset file was not noticed when the registry itself was unchanged. Fixed by adding size+mtime to the assets fingerprint.

Gotchas:
- PowerShell splatting (`& $cf @args`) inside a scriptblock passed no arguments to npm. Use real child processes in tests rather than ad-hoc shell loops.
- `voice.speakingRate` was already part of the Stage E script config (estimates use it), so changing it re-runs script → render. Research is reused.
- The narrate step writes only the canonical track, so a translation edit does not re-render the narrated video. `subtitles export` re-times localized tracks on the fly.

Not verified:
- Piper with a real binary or model.
- Narration in any language other than en-US.
- Word-level alignment (not implemented).
- HEVC/AV1 clips (disabled by default).
- Rotated phone videos (rotation is recorded and warned about, not corrected).
- 16:9 renders with clips.
- Indic-script rendering: still unsupported. The manual procedure is in rendering.md.
- Whether Microsoft's licence permits commercial use of SAPI voices.

## Stage G results (2026-10-23)

- Baseline before Stage G: typecheck clean, 25 files / 443 tests green (191.9 s).
- After: `npm run check` (typecheck + vitest), **3 consecutive green runs**, each typecheck clean, 30 files / 509 tests (210.7 s, 204.7 s, 195.7 s).
- No test was deleted or weakened. Changed expectations:
  - the new `narrate` step in step lists and progress counts (`/8` → `/9`);
  - `screen-capture` now maps to a component but still blocks without a video;
  - `render config` reports `voice` as an object;
  - `tests/e2e/research.test.ts` got an explicit 120 s timeout (CPU contention with parallel real renders).
- Silent regression: the Stage F real render is still byte-identical (898,882 bytes, 648 frames, no audio stream).

Real narrated render (`tests/integration/media-real.test.ts`, every run):
- Input: a 4 s 640×360 H.264+AAC clip, trimmed to 0.5–3.5 s and muted, in the screen-capture scene.
- Narration: Microsoft David Desktop, 5 sentences, 18,967 ms, peak −1 dBFS.
- Output: 1080×1920, 30 fps, 569 frames (narrated timeline; the script estimate differed), AAC 48 kHz stereo, 18.987 s audio vs 18.967 s video, 1,595,154 bytes.
- Decoded output audio: RMS −24.2 to −22.6 dBFS in all 5 sentence windows; 4 inter-sentence gaps ≥ 15 dB quieter; lead-in < −50 dBFS.
- Decoded frames show the clip's colours only in its scene.
- The exported VTT's first cue starts at the measured speech start.
- Timing: 60.6 s for the render alone in isolation. In the full suite, 96–143 s, including waiting for the shared real-render slot.

Memory and processes: render concurrency 1, video-clip frame cache capped at 256 MB with one extraction thread, asset files streamed for hashing and staging (never loaded whole). After the three runs, no `cf-render-*`, `cf-voice-*` or `cf-sapi-*` temp dirs were left behind. Peak RAM was not measured.

## Stage H status

Design: `docs/adr/0007-technical-qa-and-review.md`. User reference: `skills/creatorflow/references/qa.md`.

Baseline before Stage H (2026-10-23): `npm run check`: typecheck clean, 30 files / 509 tests green (214.2 s). This matches the Stage G report.

Added:
- `packages/qa`: PNG decoder, pixel and audio measurements, pure consistency checks, tool wrappers, the QA executor and the review step.
- Schemas `qa.ts`: QA report, review manifest, review decision, review record.
- Config `qa.*`, the `REVIEWED` state, artifact roles `qaReview` / `review`, and runner `stopAfter`.
- CLI `qa run|show` and `review show|approve|reject`.
- Shared `captionLayout()` / `FONT_UNITS` in `remotion-studio/props.ts`, used by Video.tsx and QA.
- Render reports now carry renderer stderr warnings.

Production pipeline: research … render, qa and review are real. package is unavailable.

Test labelling:
- REAL Remotion + REAL QA:
  - `tests/integration/render-real.test.ts` (silent, with a registered diagram);
  - `tests/integration/media-real.test.ts` (clip + real SAPI narration);
  - `tests/e2e/render.test.ts` (QA through the CLI, a SIGKILL during QA, review approve, a stale report after tampering).
- SIMULATED renderer + REAL QA: `tests/integration/qa-step.test.ts`. `tests/fixtures/qa-video.ts` draws QA-plausible frames (text bars in the safe area, caption boxes at `captionLayout` geometry) or exactly one defect: no captions, margin text, blank scene, low-contrast captions, damaged mdat. The old `ok` fake (uniform frames) is caught as blank / missing captions.
- [fault injection] tests rewrite an upstream artifact *and* its recorded hash, simulating a buggy upstream step. They prove QA's independent caption-text, caption-bounds and attribution checks.
- Other simulated-renderer tests use a pipeline whose QA step has no executor (as before Stage H), because their fake MP4s are uniform frames.

Findings while building:
- The bundled FFmpeg has no `select`/`signalstats`/`blackdetect`/`ebur128`. Pixel analysis is therefore done in Node on PNG frames, and LUFS is NOT_INSPECTED.
- The first caption-contrast measurement used percentiles over the whole box and read ~1:1. It now separates text pixels from box pixels and measures 20:1 on real renders.
- `MaxListenersExceededWarning`: not reproducible here. Real CLI runs of `render run`, `qa run`, `voice test` and `doctor` with `NODE_OPTIONS=--trace-warnings` printed no warnings, and the full test log contains none.
  - CreatorFlow's own listeners are removed after use: `runProcess`/`runner.execute` use `{ once: true }` and `removeEventListener`; SIGINT handlers use `once`/`off`.
  - A unit test runs 15 tool processes on one shared AbortSignal and asserts no MaxListeners warning.
  - If the warning appears in an agent session, it most likely comes from the host agent/runtime. CreatorFlow did not raise any listener limit. Warnings from the render worker are now copied into the render report, so their origin is visible.

Not verified:
- Integrated loudness.
- Text collisions inside scenes.
- Rotated clips.
- 16:9 QA.
- Review by a real person (the CLI flow is tested; judgement is human by design).
- ffmpeg child-process memory (only Node RSS is sampled).
Results:
- `npm run check`: **3 consecutive green runs**, each typecheck clean, 32 files / 566 tests (342.9 s, 327.0 s, 391.5 s). The baseline was 509 tests.
- Changed existing expectations:
  - step lists now include `qa`/`review`;
  - progress `/9` → `/10`; 13 states;
  - `render run` stops at RENDERED;
  - real-render jobs now end at `review: NEEDS_HUMAN_REVIEW` instead of `qa: EXECUTOR_UNAVAILABLE`.
  No assertion was weakened.
- Real QA, every run:
  - silent 648-frame render: 29 PASS + 6 N/A; 648 frames decoded in 1.9–3.2 s; 14 frames, 1 blank inside an entrance window; caption contrast 20:1; the registered diagram is visible (168,938 vs 3,146 matching pixels);
  - narrated 569-frame clip render: 36 PASS + `audio.loudness` NOT_INSPECTED (optional); AAC 48 kHz 2 ch, 18.987 s, peak −4.04 dBFS, RMS −24.42 dBFS, 0 clipped; 5/5 sentences voiced and captioned; the clip is visible (499,683 vs 677).
- QA wall time is 4–8 s alone and up to 24 s under suite load. Node RSS peak is 88–120 MB.
- No `cf-qa-*` temp dirs or `.frames-*` staging dirs were left after the runs.

## Stage I status

Verified on 2026-10-23: Stage I implemented and verified.
Design and semantics: `docs/adr/0008-packaging-and-batch-orchestration.md`.

Added:
- `packages/schemas/src/package.ts`: `PackageManifestSchema`, `BatchReportSchema`, `PackageFileEntrySchema`, `BatchSummarySchema`. Built JSON schemas (`package-manifest.schema.json`, `batch-report.schema.json`).
- `packages/core/src/zip.ts`: zero-dependency deterministic ZIP creator (`createZipArchive`) using Node built-in `zlib.deflateRawSync` and `zlib.crc32`, with lexicographical ordering and fixed timestamps for byte-identical determinism.
- `packages/qa/src/package.ts`: `packageStepExecute` (advances reviewed jobs to `PACKAGE_READY`), `verifyPackage` (independent hash and size verification), `exportPackage` (ZIP archive export).
- `packages/orchestrator/src/batch.ts`: `runBatch` and `generateBatchReport` coordinating seven-video weekly batches sequentially (concurrency 1), with failure isolation and idempotent resume.
- `packages/cli/src/commands/package.ts`: `creatorflow package run|show|verify|export`.
- `packages/cli/src/commands/batch.ts`: `creatorflow batch status|run|resume|report` and top-level `creatorflow report`.
- `skills/creatorflow/SKILL.md`: advertised `package`, `batch`, and `report` commands.

Test coverage:
- `tests/unit/package.test.ts`: pure ZIP creation, verification, and error paths.
- `tests/integration/package-step.test.ts`: packaging in production pipeline, atomic staging swap, verified manifest, rejection blocking.
- `tests/integration/batch.test.ts`: 7-video weekly batch orchestration, failure isolation, resume re-use, validated `batch-report.json`.
- `tests/e2e/package-batch-cli.test.ts`: CLI workflows for `package show/run/verify/export` and `batch status/report`.

