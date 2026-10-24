# ADR 0005 — Remotion rendering engine

Status: accepted (Stage F) · Date: 2026-10-22

## Context

The Stage E scene manifest is the render contract. The machine has 7.7 GiB of RAM, system Chrome, and no system FFmpeg. Remotion 4.0.538 ships `ffmpeg.exe` and `ffprobe.exe` inside `@remotion/compositor-win32-x64-msvc`. A spike rendered 30 frames with system Chrome in `chrome-for-testing` mode with no download.

## Decisions

1. **Code layout:**
   - `apps/remotion-studio`: the composition and components (TSX, bundled by Remotion's webpack). Its `props.ts` is the plain-JSON props contract plus pure layout helpers.
   - `packages/video-engine`: Node-side code: fonts, assets, inspection, render orchestration and the worker.

   Upstream schemas are unchanged. The renderer consumes `scene-manifest.json`, `storyboard.json` and `captions.json` exactly as Stage E writes them.
2. **The previously unimplemented `assets` and `queue-render` steps get executors.**
   - **assets:** asset and font resolution. Voice is still Stage G; `voice.mode` other than `none` blocks.
   - **queue-render:** cheap, complete validation before the expensive render.

   The render step re-verifies everything at render time.
3. **New engine feature: `StepDefinition.dependsOn`.** A step may read verified outputs of earlier non-adjacent steps (render reads the script artifacts and the asset resolution). Their hashes join the input fingerprint, and `ctx.verified` exposes them. Pipelines validate that dependencies are earlier steps.
4. **The worker process is isolated.** `runProcess` (core) spawns without a shell and kills the whole process tree (`taskkill /T /F` on Windows, process group on POSIX) on timeout or abort. The worker also polls its parent PID and kills itself if CreatorFlow dies. Each render uses a private temp dir `cf-render-<pid>-*` that is always removed, and dirs of dead owners are swept before the next render.
5. **No network:**
   - Fonts come from installed `@fontsource` packages or project files.
   - The browser is local unless `render.allowBrowserDownload` is set.
   - No Remotion `licenseKey`, so no telemetry per Remotion's documentation.
   - Assets come only from the local registry.
6. **Glyph coverage is measured, not assumed.** A small cmap parser (TrueType/OpenType/WOFF1) collects code points per file. The resolution records a CSS `unicode-range` per face, so the browser never falls back silently to another font for covered text, and anything uncovered blocks the render before it starts.
7. **Verification layers:**
   - the worker's exit code plus an explicit result line;
   - a non-empty output file;
   - ISO-BMFF box walk (`ftyp`, `moov`, `mdat`, exact tiling);
   - ffprobe codec, dimensions, fps, frame count and duration compared with the request.

   Container or exit failures are retryable. A dimension or frame mismatch is permanent. Output replaces the previous video atomically only after verification.
8. **Report** (QA is ADR 0007): `render/report.json` is the only Stage F artifact with real execution timestamps. It always records `technicalQa: "pending"` and `captions.timing: "estimated"`.

## Consequences

- A 21.6 s 1080×1920 video takes about 45–65 s to bundle and render on this machine (concurrency 1).
- Each render re-bundles (about 15 s). Webpack's own cache helps; a persistent bundle cache is future work.
- Supported scene types: hook, title, explanation, technical diagram (registered image, or explanation fallback), code demo (registered image or text), comparison (text-led), source quote, summary, outro. `screen-capture` needs video assets and is rejected. (Superseded by ADR 0006: screen-capture renders registered, validated video clips.)
- Silent output: no narration or music until Stage G. Captions are burned in with estimated timing. (Superseded by ADR 0006 for narrated jobs.)
- Comparison scenes render the claim as a labelled card. The manifest has no structured two-sided comparison data, and the renderer does not invent any.
