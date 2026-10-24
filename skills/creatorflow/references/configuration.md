# Configuration reference

CreatorFlow uses two JSON files in the project directory. Both carry a `$schema` pointer for editor autocompletion; JSON Schemas live in `packages/schemas/json/` in the CreatorFlow repository.

## creator-profile.json — who the creator is

| Field | Required | Notes |
|---|---|---|
| `creator.displayName`, `niche`, `topics[]`, `audience.description` | yes | Never guess these; ask the user. |
| `creator.audience.expertise` | no | `beginner`, `intermediate`, `advanced`, `mixed` (default). |
| `languages.primary` | yes | BCP 47 tag (`en`, `hi`, `pt-BR`). |
| `languages.additional[]` | no | Extra language variants; must not repeat the primary. |
| `platforms.primary` | yes | `youtube-shorts`, `youtube-long`, `instagram-reels`, `tiktok`, `linkedin-video`. |
| `platforms.secondary[]` | no | Must not repeat the primary. |
| `brand.name`, `brand.colors.*` | yes | Colours are `#RRGGBB`. Defaults are supplied by `init`. |
| `brand.fonts.{heading,body,mono}` | yes | `family`, `source` (`bundled`, `local-file`, `system`, `google-fonts`), `license` (e.g. `OFL-1.1`). `doctor` warns on `unknown`. |
| `brand.logoPath` | no | Path relative to the profile; `doctor` checks it exists. |
| `visual.styles[]`, `visual.animationIntensity` | yes / no | Styles: `motion-typography`, `technical-diagrams`, `code-demos`, `screen-recordings`, `licensed-b-roll`, `comparison-layouts`. |
| `voice.mode` | yes | `tts` (local provider, see [voice.md](voice.md)), `user-recorded` (not implemented; blocks) or `none` (default: silent video). |
| `voice.voiceId`, `voice.speakingRate` | no | Voice id or name from `creatorflow voice providers`; rate 0.5–2 (default 1), mapped per engine and recorded as applied. |
| `voice.glossary[]` | no | `term`, optional `pronunciation` (respelling sent to the engine; captions keep the term), `doNotTranslate` (default true). |
| `schedule.weeklyTarget` | no | Default 7. A target, not a promise. |
| `schedule.timezone` | yes | IANA name. |
| `schedule.durations.{shortForm,longForm}` | yes | `{minSec, maxSec}`; defaults 30–60 s and 480–900 s. |
| `content.restrictions[]`, `avoidTopics[]`, `newsFreshnessDays` | no | Freshness default 14 days. |
| `approval.*` | no | `requirePlanApproval` and `requireFinalReview` default to true (`requireFinalReview` gates delivery readiness after technical QA; false waives it and is recorded); `publishing` is fixed to `manual-only`. |

## creatorflow.config.json — how CreatorFlow runs

| Field | Default | Notes |
|---|---|---|
| `profilePath` | `creator-profile.json` | Relative; may not escape the project directory. |
| `workspaceDir` | `workspace` | Runtime data (plans, renders, logs). Git-ignored. |
| `hardware.maxConcurrentRenders` | 1 | Keep 1 on machines with 8 GB RAM or less. |
| `hardware.browserExecutable`, `ffmpegPath`, `ffprobePath` | unset | Explicit binaries if not on PATH. |
| `providers.<kind>` | see below | Kinds: `research`, `llm`, `tts`, `image`, `video`, `storage`, `publishing`. |
| `budget.allowPaidProviders` | false | Must be true, with `monthlyLimit > 0`, for any `paid: true` provider. |
| `offline.preferOffline`, `allowNetworkResearch` | true, false | Network research is opt-in. |
| `qa.*` | see [qa.md](qa.md) | `maxOutputBytes` 4 GiB, `durationToleranceFrames` 1.5, `audioDurationToleranceSec` 0.1, `sampleEverySec` 10, `maxSamples` 60, `blankStdDev` 2.5, `blankUniformFraction` 0.995, `safeMargins` {top 0.03, bottom 0.03, left 0.04, right 0.04}, `minContrast` 4.5, `minFontFraction` 0.022, `speechFloorDbfs` −45, `silenceFloorDbfs` −50, `maxDropoutMs` 1000, `maxPauseMs` 3000, `maxClippedRatio` 0.001, `maxOutputMbPerMinute` 400, `timeoutMs` 20 min. |
| `assets.*` | see [assets.md](assets.md) | `maxImageBytes` 25 MiB, `maxVideoBytes` 512 MiB, `maxVideoDurationSec` 600, `maxVideoWidth`/`Height` 3840/2160, `maxVideoFps` 120, `videoCodecs` [h264, vp8, vp9], `decodeCheck` full, `probeTimeoutMs` 180000. |
| `voice.*` | see [voice.md](voice.md) | `sampleRate` 22050, pauses (`sentencePauseMs` 250, `segmentPauseMs` 450, `leadInMs` 200, `tailMs` 700), `minSceneMs` 1500, `maxSentenceChars` 600, `maxTotalSec` 900, `targetPeakDbfs` −1, `maxGainDb` 12, `windowsSapi.powershell`, `piper.{executable, model, extraArgs, speaker}`. |

Default providers: research `manual-sources` (user-supplied URLs), llm `agent-host` (the coding agent you are running in), storage `local-fs`, publishing `package-only`; tts, image and video are `none` (unavailable, not faked). Local voice providers: `providers.tts.id` = `windows-sapi` or `piper`.

Provider entry: `{ "id": "...", "enabled": true, "paid": false, "apiKeyEnv": "MY_KEY_ENV", "timeoutMs": 60000, "maxRetries": 2, "options": {} }`. `apiKeyEnv` is the *name* of an environment variable; the value is never stored.

## Precedence used by `init`

defaults < `--preset` < existing files < `--answers` file < command-line flags < interactive answers.

Arrays are replaced, not merged. Existing files are backed up to `<file>.bak` before being changed; unchanged files are not rewritten.
