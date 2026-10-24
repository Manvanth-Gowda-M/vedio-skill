# Technical QA and human review

Three milestones stay separate:

| Milestone | Who decides | Where it is recorded | State |
|---|---|---|---|
| Render verified | the render step (container + stream metadata) | `render/report.json` (`technicalQa: "pending"`) | `RENDERED` |
| Technical QA passed | the `qa` step (measurements below) | `qa/report.json`, `qa/review-manifest.json`, `qa/frames/` | `QA_PASSED` |
| Human review approved | a person, via `creatorflow review approve` | `review/decision.json` → `review/record.json` | `REVIEWED` |

Packaging and publishing (Stage I) are not implemented. "Ready for packaging" never means published or production-ready.

## Commands

```sh
creatorflow qa run --job <id>        # remaining steps up to and including QA; renders only if needed; exit 0 = QA passed
creatorflow qa show --job <id> [--all]
creatorflow review show --job <id>   # frames, scenes, questions, recorded decision, delivery readiness
creatorflow review approve --job <id> --qa-hash <16+ hex> --by "Name" [--note "..."]
creatorflow review reject  --job <id> --qa-hash <16+ hex> --note "what must change"
creatorflow resume --job <id>        # applies the decision (review step)
```

`render run` stops after the render step. `resume` runs QA and review too.

Exit codes:
- `qa run`, `qa show`, `review show`: 1 when QA failed, is blocked, stale or unverified, or review is pending.
- `review approve`: 5 when `--qa-hash` does not match the current report; 1 when there is no verified, passed QA report.

## What the QA step checks

Each check is `PASS`, `FAIL`, `BLOCKED`, `NOT_INSPECTED` (a tool is missing), `NEEDS_REVIEW` (no reliable automatic verdict) or `NOT_APPLICABLE`.

Verdict: any required `FAIL` gives **failed**. Any required `BLOCKED` or `NOT_INSPECTED` gives **blocked**. Otherwise the verdict is **passed**, and optional checks and `NEEDS_REVIEW` items become review questions.

| Check | What is measured |
|---|---|
| `file.integrity` | MP4 hash and size equal the verified render record and report; ≤ `qa.maxOutputBytes`; plausible MB/minute |
| `file.dependencies` | request, manifest, captions, asset resolution, narration and audio hashes form one current chain |
| `video.container` | ISO-BMFF box walk |
| `video.stream` | ffprobe: H.264, size, fps, frame count, duration (± `qa.durationToleranceFrames`), agreeing with the report |
| `video.decode` | **one** ffmpeg pass decodes every frame (and the audio); decoded frame count = expected; no decode errors |
| `audio.streams` | silent: no audio stream. Narrated: exactly one AAC stream, length = video ± `qa.audioDurationToleranceSec` |
| `audio.decode`, `audio.speech`, `audio.clipping`, `audio.dropouts` | decoded audio length vs video and narration timeline; RMS ≥ `qa.speechFloorDbfs` in every sentence window; clipped samples ≤ `qa.maxClippedRatio`; no silence > `qa.maxDropoutMs` inside a sentence |
| `audio.pauses` (optional) | silences > `qa.maxPauseMs` → review |
| `audio.loudness` (optional) | **NOT_INSPECTED**: no LUFS meter in the bundled FFmpeg |
| `captions.timing`, `.text`, `.coverage`, `.method`, `.lines` | ordered cues inside the video; caption text = approved script per segment; every narrated sentence has a cue while spoken; timing label honest (`sentence-aligned` only for narration, never `word-aligned`); line-length and line-count limits |
| `captions.reading-speed` (optional) | cues above `maxCps` → review |
| `visual.frames` | sampled frames decode at the output size |
| `visual.blank` | scene content area nearly uniform (σ < `qa.blankStdDev` and ≥ `qa.blankUniformFraction` at one level), except frames inside entrance/exit animation windows, which are listed |
| `visual.edges`, `visual.safe-margins` | no text-like pixels in the outer 0.5% or in `qa.safeMargins` |
| `captions.burned-in` | caption text present in every sample with an active cue, absent otherwise |
| `captions.safe-area`, `captions.contrast` | detected caption box inside the margins; measured text/box contrast ≥ `qa.minContrast` |
| `captions.layout` (optional) | caption taller than its planned lines (browser wrapping) → review |
| `visual.text-contrast`, `visual.font-size` | brand text and source-label colours vs background (WCAG); smallest font from the shared layout constants ≥ `qa.minFontFraction` of the short side |
| `visual.assets` | registered images and clips: the source's distinctive colours appear in its scene far more than in other scenes (colour-signature heuristic) |
| `content.scenes` | rendered scene order and frames = manifest/narration timeline; every scene sampled |
| `content.plan` | output belongs to this job and to the approved item (a newer plan version with the item unchanged is accepted and noted) |
| `content.claims` | the existing evidence validator (`validateScriptAgainstEvidence`) on the script |
| `content.attribution` | every required source label is in its rendered scenes; required asset attributions have text |
| `content.assets-current` | every used file re-hashed and still bound to this job in the registry |
| `content.narration-text` | narrated sentences = script text |
| `content.localization` | review states honest; only the canonical language is rendered |
| `provenance.claims` | licences and origins unchanged and still unverified or user-attested |

Frames: the start, middle and end, one frame 60% into each scene, one shortly after each scene boundary, and one every `qa.sampleEverySec` seconds. At most `qa.maxSamples` are taken, and the mandatory ones are always kept. They are extracted with accurate seeks and stored as PNGs in `qa/frames/`, each hashed in the report and manifest.

## Limits (always reviewed by a human)

- Pixel checks can miss overlapping text, typos, wrong or misleading visuals and artefacts. They also do not model platform UI overlays.
- Media visibility is colour-based. It says nothing about relevance, authenticity or licensing.
- Claim checks prove that the text comes from the recorded evidence, not that the evidence is true or current.
- Captions are at most sentence-aligned. Loudness is not measured.

These limits are listed in every report under `limitations`, and the review manifest turns them into questions.

## Failure, resume and invalidation

- A failed QA keeps the render. The failed `qa/report.json` stays on disk, and `qa show` labels it UNVERIFIED. A permanent QA failure is not retried until its inputs change, or until `--retry-failed`.
- An interrupted QA attempt is recovered on the next run. QA writes frames to a staging directory and swaps it in at the end; stale staging and temp dirs of dead processes are removed.
- These re-run QA only, never the render: an edited QA report, changed `qa.*` thresholds, `--force-step qa`, `qa run --force`, or changed tools.
- An edited MP4, a new render (any upstream change) or a changed asset of this job re-renders as needed, then re-runs QA. Assets of other jobs do not.
- A review decision is bound to the QA report, review manifest and video hashes. After any change it becomes `REVIEW_STALE` and the job waits for a new review.
- `approval.requireFinalReview: false` in the profile waives the human review. The waiver is recorded.
