# CreatorFlow

A portable agent skill and toolkit for planning and producing research-backed, faceless videos about AI tools and developer technology. Works with Kiro, Claude Code, OpenCode and Antigravity. Free and local by default, with optional providers you configure explicitly. It never publishes on its own.

**Status: Stage H of 10.** Setup, diagnostics, offline research with evidence tracking, explainable scoring, a seven-day planner, hash-bound plan approvals, a resumable workflow engine, evidence-grounded scripts, storyboards, scene manifests, human-translation import, subtitles, **real Remotion rendering**, an **asset registry with provenance**, **local video clips** in scenes, and **local narration** (Windows SAPI voices; a Piper adapter for a user-installed engine) with sentence-aligned captions and verified audio, plus **technical QA** (full decode, sampled-frame, audio, caption and consistency checks) and a **hash-bound human review gate**, work today. Packaging and publishing are not implemented, so approved jobs stop before packaging and nothing is production-ready or published. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

There is **no live web research**: CreatorFlow ranks only sources you supply.

## Requirements

- Node.js ≥ 22.18 (22 LTS or 24 LTS)
- Rendering: a local Chrome or Edge. Remotion and its bundled ffmpeg/ffprobe (about 90 MB) are installed by `npm install`. A system FFmpeg is optional.
- Narration (optional): Windows (built-in SAPI voices), or a Piper binary and voice model you install yourself. Nothing is downloaded automatically.

## Install

```sh
npm install
npm run creatorflow -- doctor
```

## Set up a creator profile

Interactive (asks only for missing essentials):

```sh
npm run creatorflow -- init --preset ai-dev-tools
```

Non-interactive:

```sh
npm run creatorflow -- init --non-interactive --answers skills/creatorflow/assets/answers.example.json
npm run creatorflow -- profile validate
```

Use `-C <dir>` to work on a project outside the current directory and `--json` for machine-readable output. Field reference: [skills/creatorflow/references/configuration.md](skills/creatorflow/references/configuration.md).

Secrets never go in config files. Set `apiKeyEnv` to an environment-variable name and export the variable in your shell.

## Research, plan, approve, resume

```sh
npm run creatorflow -- research --input sources/             # import your sources (JSON + optional HTML/text snapshots)
npm run creatorflow -- research --as-of 2026-10-26           # inspect evidence, unresolved claims, ranking
npm run creatorflow -- plan-week --week 2026-W44             # saves an UNAPPROVED plan version, prints its hash
npm run creatorflow -- plan add --file my-week.json          # alternative: hand-written plan
npm run creatorflow -- approve-plan --week 2026-W44 --plan-version 1 --hash <hash>
npm run creatorflow -- resume                                # continues from the last verified step
npm run creatorflow -- status                                # plan, approvals, job states, blocked/failed
```

## Scripts, storyboards, translations, subtitles

```sh
npm run creatorflow -- script show --job 2026-w44-hooks-explained          # segments, claim refs, estimated timing, sources
npm run creatorflow -- script validate                                     # re-check every artifact against evidence + hashes
npm run creatorflow -- storyboard inspect --job 2026-w44-hooks-explained   # scenes, layout checks, asset requirements
npm run creatorflow -- localize template --job 2026-w44-hooks-explained --lang hi-IN
npm run creatorflow -- localize import --job 2026-w44-hooks-explained --file hi-IN.json   # human translation
npm run creatorflow -- resume
npm run creatorflow -- subtitles export --job 2026-w44-hooks-explained --lang hi-IN --format vtt
```

Scripts use only claim text from the verified evidence, plus your own plan wording, which is flagged when it looks like an unsupported assertion. There is no machine translation. Timing is estimated unless the job is narrated. Details: [skills/creatorflow/references/scripts-and-localization.md](skills/creatorflow/references/scripts-and-localization.md).

Research format, scoring and eligibility: [skills/creatorflow/references/research-standards.md](skills/creatorflow/references/research-standards.md) (example: `skills/creatorflow/assets/research.example.json`, fictional data). Plan format: [skills/creatorflow/references/workflow.md](skills/creatorflow/references/workflow.md). State machine, recovery, locking and limits: [docs/adr/0002-workflow-engine.md](docs/adr/0002-workflow-engine.md). Approving a plan never publishes anything.

## Render

```sh
npm run creatorflow -- render config                                         # browser, ffprobe, fonts, licensing
npm run creatorflow -- render run --job 2026-w44-hooks-explained --out out/hooks.mp4
npm run creatorflow -- render status --job 2026-w44-hooks-explained
```

Rendering uses a local Chrome/Edge and fonts installed with CreatorFlow; it downloads nothing. Details, fonts for non-Latin scripts (Indic scripts are unsupported until a font is verified), audio verification and limits: [skills/creatorflow/references/rendering.md](skills/creatorflow/references/rendering.md).

## Assets and video clips

```sh
npm run creatorflow -- storyboard inspect --job 2026-w44-hooks-tutorial        # which slots need files
# copy your own file into workspace/assets/ first; CreatorFlow never downloads or copies media
npm run creatorflow -- assets register --file workspace/assets/captures/terminal.mp4 --type screen-recording \
  --job 2026-w44-hooks-tutorial --slot ast-scn-03-screen-recording --start 1.5 --end 9 \
  --origin user-created --license "own work" --attest
npm run creatorflow -- assets validate
npm run creatorflow -- assets list
```

Registration measures the file itself: content type, sha256, and for video the container, codec (H.264/VP8/VP9), size, fps, duration, audio and a full decode. Licences and origins are recorded as you state them and are not verified. Removal is refused while a scene uses an asset, and never deletes the file. Details: [skills/creatorflow/references/assets.md](skills/creatorflow/references/assets.md).

## Narration

```sh
npm run creatorflow -- voice providers        # what is installed and ready (none / windows-sapi / piper)
npm run creatorflow -- voice test --out test.wav
```

Set `"providers": { "tts": { "id": "windows-sapi" } }` in `creatorflow.config.json` and `"voice": { "mode": "tts" }` in the profile, then `resume` or `render run`. The script text is narrated as written, scenes and captions are re-timed from the measured speech (sentence-aligned, not word-aligned), and the render must contain verified narration audio. With `voice.mode: "none"` videos stay intentionally silent. Details, Piper setup and licences: [skills/creatorflow/references/voice.md](skills/creatorflow/references/voice.md).

## Technical QA and review

```sh
npm run creatorflow -- qa run --job 2026-w44-hooks-explained      # exit 0 only if technical QA passed
npm run creatorflow -- qa show --job 2026-w44-hooks-explained
npm run creatorflow -- review show --job 2026-w44-hooks-explained   # frames in qa/frames/, questions for a human
npm run creatorflow -- review approve --job 2026-w44-hooks-explained --qa-hash <hash> --by "Your Name"
npm run creatorflow -- resume
```

QA never edits the render; a failed QA keeps it for diagnosis. Checks it cannot run (for example without ffmpeg) are reported as NOT_INSPECTED and block the verdict. Passing technical QA is not approval: a person must review the frames, facts, media and licences, and approval only makes the video ready for packaging (not implemented yet). Details and limits: [skills/creatorflow/references/qa.md](skills/creatorflow/references/qa.md).

## Install the skill into an agent

```sh
npm run creatorflow -- skill validate
npm run creatorflow -- skill install --agent kiro          # or claude-code, opencode, antigravity, antigravity-cli, agents
npm run creatorflow -- skill install --agent claude-code --scope user
```

Verified compatibility and untested assumptions: [skills/creatorflow/references/agent-compatibility.md](skills/creatorflow/references/agent-compatibility.md).

## Development

```sh
npm run typecheck
npm test
npm run schemas:build   # after editing Zod schemas
```

Layout: `packages/core` (errors, atomic fs, path safety, secrets, logging, exec, fingerprints, locks), `packages/schemas` (Zod schemas + generated JSON Schema), `packages/orchestrator` (state machine, job/plan stores, runner), `packages/research` (providers, sessions, scoring, planner, research step), `packages/scriptwriter` (script provider, evidence validation, storyboard, manifest, subtitles, script step), `packages/localization` (glossary, translation validation, localize step), `packages/video-engine` (media probing, asset registry, fonts, render orchestration, audio verification), `packages/voice` (voice providers, WAV analysis, narration timeline, narrate step), `packages/qa` (technical QA measurements, QA step, review gate), `apps/remotion-studio` (Remotion composition and scene components), `packages/cli` (commands, production pipeline), `skills/creatorflow` (portable skill), `tests/` (unit, integration, e2e), `docs/` (ADRs, plan, notes).

## Licensing

CreatorFlow's code is MIT. Remotion, used for rendering from Stage F, is source-available and free only for individuals and companies of up to 3 people. FFmpeg, fonts, voices (Windows SAPI, Piper engines and models), music, B-roll and providers have their own terms. See [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md) and [docs/adr/0006-assets-video-and-narration.md](docs/adr/0006-assets-video-and-narration.md).
