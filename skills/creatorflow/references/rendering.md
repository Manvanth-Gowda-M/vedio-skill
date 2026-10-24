# Rendering, assets and fonts

## Pipeline steps

| Step | Output | What it checks |
|---|---|---|
| `narrate` (Stage G) | `narration/narration.json`, `narration/subtitles.json`, `narration/voice.wav` (narrated jobs only) | Silent jobs: records an explicitly silent, estimated timeline. Narrated jobs: synthesises the verified script locally, measures it and re-times scenes and captions. See [voice.md](voice.md). |
| `assets` | `assets/resolution.json` | Every scene-manifest asset resolves to a registered, re-measured local file (images, code text, video clips with validated trims), or (optional assets only) an explicit text-only fallback. Provenance and attribution are carried along. Brand fonts are resolved offline and their glyph coverage is read from the font files. See [assets.md](assets.md). |
| `queue-render` | `render/request.json` | Manifest, storyboard, captions, asset resolution and narration agree by sha256. Every scene type has a component. Dimensions are even. A local browser exists. Records exact settings, the scene timeline (narrated or estimated), the expected audio, caption timing and the clip plan. |
| `render` | `render/output.mp4`, `render/report.json` | Re-verifies all inputs, stages fonts, media and narration in a private temp dir (each copy re-hashed), runs Remotion in a separate worker process, checks the MP4 container, inspects streams with ffprobe and verifies the audio (see below). It replaces the previous video only after every check passes. |

Each step uses the normal workflow rules: retries, timeouts, locks, resume, and invalidation by hashes. A changed scene manifest re-renders only that video. A changed render setting re-queues and re-renders, but does not redo the script or narration.

## Scene components

hook, title, explanation, technical diagram (registered image, or explanation fallback), code demo (registered image, code text or video), comparison (text-led), **screen capture (registered video, Stage G)**, source quote, summary, outro. A screen-capture scene without a validated video blocks; it is never drawn blank. Any scene with a video slot shows the clip framed (ScreenCapture, CodeDemo) or as a dimmed backdrop (others).

## Audio verification

| Request | Passes only if |
|---|---|
| `audio.expected: "none"` (voice.mode `none`) | ffprobe finds no audio stream. |
| `audio.expected: "narration"` | exactly one AAC stream; its duration equals the video duration ±0.1 s; the decoded output audio has speech energy in every narrated sentence window. |

Without ffprobe/ffmpeg a narrated job blocks (`MEDIA_TOOLS_UNAVAILABLE`); a silent job still renders with `mediaInspection.performed: false`. Audio from video clips is muted.

## Fonts

| `source` | Resolution |
|---|---|
| `google-fonts`, `bundled` | An installed `@fontsource/<family>` npm package (Inter and JetBrains Mono ship with CreatorFlow). Fonts are never downloaded. |
| `local-file` | `path` inside the project (`.woff`, `.ttf` or `.otf`; `.woff2` cannot be checked). |
| `system` | Rejected (`FONT_UNVERIFIABLE`): coverage cannot be verified. |

Every character the video draws is checked, after NFC normalisation, against the font file's own `cmap` table: scene text, captions, brand name, attribution text and fixed labels. Combining marks (e.g. Devanagari vowel signs and virama) are checked individually; ZWJ/ZWNJ are excluded. Missing glyphs block with `FONT_GLYPHS_MISSING` and list the characters.

### Indian-language scripts: unsupported in this release

Inter covers Latin, Greek, Cyrillic and Vietnamese, **not** Devanagari, Bengali, Kannada, Tamil, Telugu, Malayalam or Gujarati. No Indic font is installed with CreatorFlow, and no Indic render has been verified, so Indian-language video text is **unsupported** here, even though translations and subtitles exist.

To try it yourself (manual, not automated):
1. Download the matching Noto Sans family yourself, e.g. *Noto Sans Devanagari* or *Noto Sans Kannada* (SIL OFL 1.1; from fonts.google.com or github.com/notofonts). Use `.ttf`/`.otf`, not `.woff2`.
2. Put it in the project and set the profile font: `{ "family": "Noto Sans Devanagari", "source": "local-file", "path": "fonts/NotoSansDevanagari-Regular.ttf", "license": "OFL-1.1" }`.
3. Render, then extract frames (`ffmpeg -ss <sec> -i output.mp4 -frames:v 1 frame.png`) and have a reader of the script check conjuncts, reph, vowel-sign order and line breaks. Glyph coverage does not prove correct shaping: Chrome shapes with HarfBuzz, but CreatorFlow's checks cannot see the result.
4. Report it as supported only after that review passed.

## Browser, media tools and settings

- **Browser:** `hardware.browserExecutable`, otherwise a local Chrome or Edge, driven in Remotion's `chrome-for-testing` (new headless) mode. Remotion's Headless Shell download is used only with `render.allowBrowserDownload: true`.
- **ffprobe / ffmpeg:** `hardware.ffprobePath`/`ffmpegPath`, then PATH, then the copies bundled in `@remotion/compositor-*` (a minimal FFmpeg 7.1 build: H.264/VP8/VP9/AV1/HEVC/ProRes decoders, AAC/Opus, no `lavfi`). Used for render inspection, video-asset decode checks and audio verification.
- **Config:** `config.render` (`crf` 18, `pixelFormat` yuv420p, `concurrency` 1, capped by `hardware.maxConcurrentRenders`, `captions` burn-in/off). Timeout: `workflow.stepTimeoutMs.render`, default 30 min. A timeout or cancellation kills the worker and the browser it started. If CreatorFlow itself dies, the worker kills itself within about a second.
- **Output:** 1080×1920 (9:16) or 1920×1080 (16:9) at the manifest fps, H.264 video, AAC audio when narrated. Video-clip frame cache: 256 MB, one extraction thread.

## Commands

```sh
creatorflow render config                                   # browser, ffprobe/ffmpeg, fonts, voice readiness, asset limits, licensing
creatorflow render run --job 2026-w44-hooks-explained --out exports/hooks.mp4
creatorflow render status --job 2026-w44-hooks-explained    # steps (narrate..render), errors, audio, caption timing
```

`render run` exits 0 only when a verified render exists, either new or reused. Otherwise it exits 1 with the blocking step and reason.

## What a render report does and does not mean

- It distinguishes requested (`narration.requested`), configured (`configuredProvider`), generated (`narration.generated`), inspected (`mediaInspection`) and verified (`audio.verified`) resources, plus the asset ids, hashes, licences and provenance used, clip windows, caption timing method and caption validation.
- `technicalQa: "pending"` in the render report means the render step itself does no QA. Technical QA is the separate `qa` step ([qa.md](qa.md)); a verified render is not a QA-passed or human-approved video.
- Nothing is uploaded or published.

## Licensing

- **Remotion:** free for individuals and companies of up to 3 people; larger organisations need a company licence (remotion.dev/docs/license/pricing). CreatorFlow sets no `licenseKey`, and per Remotion's docs server-side renders then send no telemetry.
- **Fonts:** Inter and JetBrains Mono are OFL-1.1.
- **FFmpeg/ffprobe** binaries come from Remotion's compositor package, under their own (LGPL/GPL) terms.
- **Voices:** see [voice.md](voice.md). **Your assets:** see [assets.md](assets.md).
