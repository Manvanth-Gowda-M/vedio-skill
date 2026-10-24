# ADR 0006 — Asset registry, video assets and local narration

Status: accepted (Stage G) · Date: 2026-10-23

## Context

Stage F rendered silent videos from a hand-edited, minimal asset registry and rejected screen recordings. The machine is Windows 11 with 7.7 GiB RAM, system Chrome, no system FFmpeg, and Remotion 4.0.538's bundled FFmpeg 7.1 (a minimal build: no `lavfi`, no `wrapped_avframe` encoder). Two desktop SAPI voices are installed (David, Zira, en-US). No Piper binary or model and no Indic fonts are installed.

Offline TTS options considered:
- **Piper:** good quality and Windows binaries exist. But `rhasspy/piper` (MIT) was archived in 2025, its maintained successor `OHF-Voice/piper1-gpl` is GPL-3.0 with a different CLI, models are large separate downloads with per-voice licences, and nothing is installed here.
- **eSpeak NG:** GPL-3.0 and robotic. Not installed.
- **Windows SAPI 5 via System.Speech:** present on every Windows install, offline, no download, and scriptable from PowerShell.

## Decisions

1. **Registry v2 in place of v1.**
   - `workspace/assets/registry.json` gets `schemaVersion: 2`. Each entry has a stable `id`, `type`, path, byte size, sha256, media measured from the bytes, provenance, timestamps, and `uses` (job + scene-slot id, optional clip window).
   - v1 is still read. The first mutating command migrates it and keeps `registry.v1.json`.
   - Writes run under a lock file with compare-and-swap on the raw bytes, keep a `.prev` backup, and are atomic. A corrupt file is never overwritten; `assets recover` quarantines it.
   - The scene-manifest schema is unchanged: slots are the existing manifest `assetId`s.
2. **Provenance is a claim.**
   - Origin is one of a fixed set. `verification` is only `unverified` or `user-attested`; it is never "verified".
   - URLs are never fetched. Required attribution without text blocks the job, and attribution is drawn verbatim.
3. **Video assets are measured, decoded, never altered.**
   - Measurement: container sniffing, ffprobe stream data (codec allow-list, size, fps, duration, rotation, audio), and a full ffmpeg decode to `-c:v rawvideo -f null`. The explicit encoder is needed because the bundled build lacks the default one.
   - Limits come from `config.assets`. Clip windows are validated against the measured duration and never clamped.
   - The assets step re-measures before every render. Clips render through `OffthreadVideo`, muted, with a held last frame when the scene is longer.
   - A `screen-capture` scene without a validated clip blocks.
4. **Provider-neutral voice in `packages/voice`.**
   - A `VoiceProvider` has `health()` (a capability report with requirements, controls, limits and licence notes), `synthesize()` (one WAV per sentence) and `describeRate()`.
   - Providers: `none` (typed unavailable), `windows-sapi` (default local choice on Windows, tested), and `piper` (adapter for a user-installed C++ CLI, untested). Nothing is downloaded or installed.
5. **New `narrate` step and `NARRATED` state** between LOCALIZED and ASSETS_READY.
   - Silent jobs record an explicit silent timeline. Narrated jobs synthesise the verified script sentence by sentence, with a content-addressed cache. Output is validated before caching.
   - Speech boundaries are measured from energy. One peak-normalising gain is applied (no clipping). Sentences are composed on the frame grid; the result is a WAV exactly as long as the video, plus a new scene timeline.
   - The engine's identity and version are an external fingerprint input, so a new model or voice regenerates narration.
   - The step writes only the canonical subtitle track. Translation edits therefore do not re-render the narrated video; localized tracks are re-timed at export.
6. **Caption timing is labelled, not overstated.**
   - `SubtitleTrack.timing` becomes `estimated | sentence-aligned | word-aligned`.
   - Sentence-aligned cues use measured speech starts and ends. Splits inside a sentence are interpolated.
   - Nothing produces `word-aligned`: neither engine offers reliable word timestamps through these adapters, and no forced aligner was added.
7. **Audio is verified in the output.**
   - Silent requests must have no audio stream.
   - Narrated requests need exactly one AAC stream, a duration within ±0.1 s of the video, and speech energy in every narrated sentence window of the decoded output.
   - Report fields separate requested, configured, generated, inspected and verified resources. `technicalQa` stays `pending`.
8. **Orchestrator additions:**
   - optional outputs (narration audio exists only when generated, but is verified and hashed when present);
   - `readVerifiedOutput` / `verifiedBinaryOutput` moved into the orchestrator;
   - `runProcess` accepts stdin input (Piper).

## Consequences

- Granular invalidation works as follows:
  - Registry bindings are fingerprinted per job, including each bound file's size and mtime, so unrelated registrations do not re-render other jobs.
  - Trims and licences re-run assets → render.
  - Voice changes re-run narrate → render.
  - Caption style changes re-run assets → render.
  - `voice.speakingRate` also re-runs the deterministic script step, because Stage E estimates already use it.
- Real narrated render on this machine: about 19 s of SAPI speech plus a 3 s clip. The render took about 60 s at concurrency 1, measured with one render at a time.
- Unsupported: user-recorded narration, word-level alignment, OneCore voices, pitch control, background music, Indic-script rendering (no verified font), HEVC/AV1 clips (off by default, untested), and Piper's GPL successor CLI.
