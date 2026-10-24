# ADR 0007 — Technical QA and human review gate

Status: accepted (Stage H) · Date: 2026-10-23

## Context

Stage G rendered verified MP4s. "Verified" there means only that the container is complete and the stream metadata matches the request; the render report says `technicalQa: "pending"`. The only media tools are Remotion's bundled FFmpeg/ffprobe 7.1. This is a minimal build: it has no `select`, `signalstats`, `blackdetect` or `ebur128` filters, no `lavfi` sources and no `wrapped_avframe` encoder. It does have `scale`, `silencedetect`, the `concat` demuxer, the PNG/rawvideo/PCM encoders and `-progress`. Profiles already carry `approval.requireFinalReview` (default true).

## Decisions

1. **New package `packages/qa`.** Pure measurements (`analyze.ts`, `checks.ts`, `png.ts`) sit apart from tool invocation (`inspect.ts`) and from the steps (`executor.ts`, `review.ts`). The pure parts are unit-tested on synthetic pixels and samples.
2. **`qa` step (RENDERED → QA_PASSED).**
   - Inputs: the verified outputs of research, script, localize, narrate, assets, queue-render and render, read only through `readVerifiedOutput` / `verifiedBinaryOutput` / `loadRenderInputs`. If any is missing or changed, QA blocks with that reason. QA writes only under `qa/`.
   - Fingerprint: QA version, `config.qa`, subtitle limits, caption mode, this job's registry bindings and the tool identities.
   - Outcomes: passed → succeeded; any required FAIL → permanent `QA_FAILED` (render kept, failed report left on disk unverified); required checks NOT_INSPECTED/BLOCKED → blocked (`QA_TOOLS_UNAVAILABLE` / `QA_BLOCKED`).
3. **One full decode.** A single ffmpeg pass decodes every video frame to the null muxer (via the rawvideo encoder) and the first audio stream to 16 kHz mono WAV, and counts frames with `-progress`. Sample frames are extracted with accurate seeks, which decode from the nearest keyframe only. Header metadata comes from ffprobe. The existing `inspectRender` is reused for the stream comparison.
4. **Deterministic sampling.** Samples: start, middle, end, 60% into each scene, ten frames after each boundary, and an interval grid, with a cap that keeps the mandatory ones. Entrance and exit animation windows are the only permitted blank frames, and they are listed explicitly.
5. **Measurements, not judgements.**
   - Measured: uniformity of the scene area; text-like pixels in the edges and safe margins; caption box detection in the caption-only zone (below the scene safe area); caption presence matched to the active cue; measured caption contrast; colour-signature visibility of registered media compared with other scenes; speech energy per narrated sentence; dropouts inside sentences; clipping; durations.
   - Taken from the layout: font sizes. `captionLayout()` and `FONT_UNITS` in `props.ts` are now shared by Video.tsx and QA. The render output is unchanged (the Stage F render stays byte-identical).
   - Not measured: loudness (NOT_INSPECTED, optional), text collisions, relevance, truthfulness and platform overlays. These become review items.
6. **Consistency through the existing validators.**
   - Reused: `validateScriptAgainstEvidence` for claims; the hash chain via `loadRenderInputs`; the registry for asset currency.
   - New pure checks: caption text vs script, narration text vs script, attribution labels, scene order, plan binding.
   - Plan binding follows the engine's rule: the approved item hash, not the plan version.
7. **Review step (QA_PASSED → REVIEWED), new state `REVIEWED`.**
   - QA writes `qa/review-manifest.json` with frames, scenes, questions and instructions. There is no GUI.
   - `creatorflow review approve|reject` writes `review/decision.json` (plus an append-only `decisions.jsonl`), bound to the QA report, manifest and video hashes.
   - The review step only reads that decision. It never decides. It blocks with `NEEDS_HUMAN_REVIEW`, `REVIEW_STALE` or `REVIEW_REJECTED`, and records a waiver when `requireFinalReview` is false.
   - Delivery readiness becomes `ready-for-packaging` only after QA passes and review is approved or waived. Packaging stays unimplemented.
8. **`stopAfter` in the runner**, so `render run` stops after rendering and `qa run` after QA. `resume` still runs everything.
9. **Observability.** Warnings printed by the render worker (e.g. `MaxListenersExceededWarning`) are copied into the render report instead of being dropped.

## Consequences

- QA of a 20 s 1080×1920 video takes about 4–6 s here: one full decode ~1–1.2 s, 11–14 frame extractions ~3.5 s. Node RSS peaks at about 110–120 MB; ffmpeg child memory is not measured.
- Existing simulated-renderer tests run with the QA step declared without an executor (as before Stage H). QA itself is tested with a simulated renderer that draws QA-plausible frames or one deliberate defect, and with real Remotion renders.
- Every new pipeline state shifted progress counts in tests again (`/9` → `/10`).
