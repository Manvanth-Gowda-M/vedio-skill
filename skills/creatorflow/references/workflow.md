# Workflow reference

## Video lifecycle

```
PLANNED -> RESEARCHED -> SCRIPTED -> LOCALIZED -> NARRATED -> ASSETS_READY -> RENDER_QUEUED -> RENDERED -> QA_PASSED -> REVIEWED -> PACKAGE_READY
```

- A job's state is the last milestone whose step outputs were **verified** (files exist, regular, non-empty, inside the workspace, hashed). Starting a step never changes the state.
- `BLOCKED`: waiting on something outside CreatorFlow (user sources, an unimplemented capability). Re-checked on every `resume`; does not use retries.
- `FAILED`: a permanent failure, or the retry budget is used up. Not retried automatically unless the step's inputs change; `resume --retry-failed` grants a fresh budget.
- If an input changes (plan item, relevant profile/config, an upstream output), the job moves back to the affected step. Unaffected steps and other videos are reused.

## Steps and implementation status

| # | Step | CLI | Status |
|---|---|---|---|
| 1–3 | Profile, diagnostics, validation | `init`, `doctor`, `profile validate` | implemented |
| 4 | Research import, scoring, plan generation | `research`, `plan-week` | implemented (offline, user-supplied sources only) |
| 5 | Plan versions and approval | `plan add`, `approve-plan` | implemented |
| 6 | Workflow state, resume, status; research step | `resume`, `status` | implemented |
| 7 | Scripts, storyboards, captions, scene manifest; localization and subtitles | `resume`, `script show/validate`, `storyboard inspect`, `localize template/import/validate`, `subtitles export` | implemented (English template scripts; human-imported translations only) |
| 8 | Asset resolution, render queue, Remotion render | `resume`, `render run/status/config` | implemented (verified fonts, registered images/code/video clips, burned-in captions) |
| 9 | Narration, asset registration, video assets | `resume`, `assets …`, `voice providers/test` | implemented: local voices (Windows SAPI tested; Piper adapter untested), sentence-aligned captions, verified audio in renders, video clips with validated trims. No image-generation adapters. |
| 10 | Technical QA and human review gate | `qa run/show`, `review show/approve/reject`, `resume` | implemented: measured file/stream/decode/frame/audio/caption/content/provenance checks; review manifest; hash-bound human decisions (see [qa.md](qa.md)) |
| 11 | Publishing package and report (no upload) | step executor, `report` | not implemented (Stage I) |

The research step re-verifies each approved item's evidence and writes `research/evidence.json`. Items without a research link (hand-written plans) are `BLOCKED: NEEDS_RESEARCH`. After research, the script step writes the script, storyboard, captions and scene manifest; the localize step then needs a valid translation for every target language (`BLOCKED: NEEDS_TRANSLATION` otherwise). After localization, the narrate step records a silent timeline or generates narration (`BLOCKED: VOICE_PROVIDER_UNAVAILABLE` when `voice.mode` is `tts` and no local provider is ready; see [voice.md](voice.md)). The assets step then needs every required asset registered (`BLOCKED: ASSETS_MISSING` otherwise; see [assets.md](assets.md)), then the video is rendered and inspected by technical QA (`FAILED: QA_FAILED` on a defect, `BLOCKED: QA_TOOLS_UNAVAILABLE` without ffmpeg/ffprobe). A passed job waits for a person (`BLOCKED: NEEDS_HUMAN_REVIEW`); approved jobs stop at `BLOCKED: EXECUTOR_UNAVAILABLE` (package). See [qa.md](qa.md). See [rendering.md](rendering.md). See [scripts-and-localization.md](scripts-and-localization.md).

## Examples

```sh
creatorflow research --input sources/ --session main            # import user-supplied sources
creatorflow --json research --session main --as-of 2026-10-26   # inspect evidence, unresolved claims, ranking
creatorflow plan-week --week 2026-W44 --session main            # saves an UNAPPROVED version, prints hash
creatorflow status --week 2026-W44                              # review versions and items
creatorflow approve-plan --week 2026-W44 --plan-version 1 --hash <hash>
creatorflow resume
```

Fewer than seven items: `plan-week` exits 1 and prints `SHORTFALL`. Run `creatorflow research --as-of <Monday of the week>` to see each ineligible candidate's rejection codes (for example `UNSUPPORTED_FACT`, `STALE_NEWS`), then add sourced candidates and re-run. Re-running with changed research creates a new version that needs its own approval.

## Weekly plan file

```json
{
  "weekId": "2026-W44",
  "items": [
    {
      "contentId": "claude-code-hooks",
      "publishDate": "2026-10-26",
      "topic": "Claude Code hooks explained",
      "category": "explainer",
      "platform": "youtube-shorts",
      "language": "en",
      "durationSec": 55,
      "hook": "...", "takeaway": "...", "angle": "...", "audienceProblem": "...",
      "sourceIds": [], "requiredAssets": [], "qualityRequirements": []
    }
  ]
}
```

`contentId` is the stable identity of a video: keep it when editing an item, or the job is treated as new. Items generated by `plan-week` also carry `workingTitle`, `aspectRatio`, `research` (session, candidate, score, evidence hash, source and claim references), `scriptRequirements`, `caveats` and `openQuestions`. Dates must fall inside the ISO week. Production status is not stored in the plan, so status changes never alter its hash.

## Planning rules (apply to drafts you write)

- Default seven items, each with a unique `contentId`, topic, audience problem, research-backed angle, source IDs, hook, takeaway, category, platform, language and duration.
- Diversify across news, explainers, tutorials, comparisons, experiments and recaps where the evidence supports it. Do not force a category to fill a quota.
- If there are not enough well-sourced topics, return fewer items and state the shortage.
- Topic scores are prioritisation heuristics, not engagement predictions.

## Approval boundary

1. `plan add` prints a version number and content hash. The user reviews that exact version.
2. Only the user approves (`approve-plan --plan-version N --hash H`). Editing the plan creates a new version that needs its own approval; approvals are never carried forward. Editing a version file in place voids its approval.
3. Approval authorises production only. Nothing is published automatically.
