# Narration (voice-over) and caption timing

## Modes

Profile `voice.mode`:

| Mode | Result |
|---|---|
| `none` (default) | Intentionally silent video, burned-in captions with **estimated** timing. The render must contain no audio stream. |
| `tts` | The narrate step synthesises the verified script with `providers.tts.id`, measures it, and re-times scenes and captions. The render must contain the verified narration. If the provider is unavailable the job blocks at `narrate`; it never renders silently instead. |
| `user-recorded` | Not implemented: blocks with `VOICE_MODE_UNSUPPORTED`. |

`creatorflow voice providers` reports every provider's readiness; `creatorflow voice test [--text ...] [--out file.wav]` synthesises one sentence and measures it without touching any job.

## Providers (all local; nothing is downloaded)

| `providers.tts.id` | Engine | Status on this machine (2026-10-23) |
|---|---|---|
| `none` | – | Typed `VOICE_PROVIDER_UNAVAILABLE` for every request. |
| `windows-sapi` | Windows built-in SAPI 5 voices via .NET `System.Speech`, driven by a PowerShell bridge (`-EncodedCommand`, no script file, no execution-policy change). | **Tested for real**: Microsoft David Desktop and Zira Desktop (en-US). The newer "OneCore" voices listed in Windows Settings (e.g. Heera, Ravi en-IN) are *not* exposed to System.Speech. |
| `piper` | A Piper binary and voice model **you install** (rhasspy/piper C++ CLI contract: text on stdin, `--model`, `--output_file`, `--length_scale`). | **Not tested** (no Piper installed here). Health checks and error paths are unit-tested only. |

Capabilities reported per provider: version, offline, languages, voices, requirements (binary/model/runtime), output (16-bit mono WAV), speaking-rate support and mapping, pitch (not supported by any adapter), text limit, timestamps (none from the engine), licence notes. A requested option that cannot be honoured blocks (`VOICE_OPTION_UNSUPPORTED`, `VOICE_NOT_FOUND`, `VOICE_LANGUAGE_UNSUPPORTED`); a voice is never silently swapped.

### Windows SAPI

```json
{ "providers": { "tts": { "id": "windows-sapi" } } }
```
Profile: `"voice": { "mode": "tts", "voiceId": "Microsoft Zira Desktop", "speakingRate": 1 }` (`voiceId` optional: default is the first installed voice for the script language). Speaking rate maps to SAPI's integer Rate −10…10 (about ⅓×…3×); the applied value is recorded. Additional desktop voices come from Windows language packs; CreatorFlow does not install them. Licence: Microsoft's Windows terms; CreatorFlow has not verified whether they permit commercial publication of synthesised speech.

### Piper (manual install)

1. Download a Piper release for your OS yourself (github.com/rhasspy/piper; archived in 2025, MIT). The maintained successor `OHF-Voice/piper1-gpl` is GPL-3.0 and its Python CLI uses different flags, which this adapter does not support.
2. Download a voice: the `.onnx` model **and** its `.onnx.json` config, side by side (e.g. from the `rhasspy/piper-voices` collection). Each voice has its own licence and dataset terms in its MODEL_CARD; check them.
3. Configure:
```json
{ "providers": { "tts": { "id": "piper" } },
  "voice": { "piper": { "executable": "C:/tools/piper/piper.exe", "model": "C:/voices/en_US-lessac-medium.onnx" } } }
```
The model's language comes from its config; its sample rate is used as-is. `speakingRate` maps to `length_scale = 1/rate`. Model size and modification time are part of the fingerprint, so replacing the model regenerates narration.

## What the narrate step does

1. Reads only the verified `script.json`, storyboard, captions and scene manifest. The spoken text is the script's narration, split into sentences (Intl.Segmenter). Nothing is added. Glossary `pronunciation` respellings replace whole-word terms in the text sent to the engine only; captions keep the script text.
2. Synthesises one sentence per request (cached in `workspace/cache/voice/` by provider, engine version, voice, rate and text; unchanged sentences are not re-synthesised). Output is validated before caching: parseable 16-bit PCM, expected sample rate, audible speech.
3. Measures each sentence's speech boundaries from its short-time energy, trims surrounding silence, applies one gain so the peak is `voice.targetPeakDbfs` (−1 dBFS, at most `maxGainDb` 12 dB, never clipping), and places sentences on the video frame grid scene by scene (lead-in, sentence and segment pauses, tail, `minSceneMs`).
4. Writes `narration/voice.wav` (mono 16-bit PCM, length exactly equal to the video), `narration/narration.json` (provider, version, voice, language, requested vs applied settings, audio hash, duration, peak/RMS, clipped samples, licence notes, per-sentence times, new scene frames) and `narration/subtitles.json`.

Limits: `voice.maxSentenceChars` 600, `voice.maxTotalSec` 900. Problems: silent or invalid engine output fails (`VOICE_OUTPUT_SILENT`, `VOICE_OUTPUT_INVALID`); an engine crash is retried; an unavailable provider blocks.

## Caption timing accuracy

| Job | `timing` | Meaning |
|---|---|---|
| silent | `estimated` | From text length and speech-rate settings (Stage E). |
| narrated, canonical language | `sentence-aligned` | Each sentence's cues start at its **measured** speech start and the last cue of a sentence ends at its speech end (held up to 0.6 s, never past the next sentence). When a sentence needs several cues, the boundaries **inside** the sentence are interpolated by text length. |
| narrated, other languages | `estimated` | Not narrated; `subtitles export` maps the localized cues onto the narrated scene windows proportionally. |

`word-aligned` exists in the schema but nothing produces it: SAPI events and Piper output provide no reliable word timestamps through these adapters, and no forced aligner is bundled. Cue ids and texts are identical to the estimated track, so attribution and claim checks are unchanged. SRT/VTT exports stay UTF-8; the VTT header states the timing method.

## Rendering and verification

The render step stages the verified WAV and Remotion muxes it as AAC. A narrated render passes only if ffprobe finds exactly one AAC stream, its duration matches the video (±0.1 s), and the **decoded output audio** has speech energy (RMS ≥ −45 dBFS) in every narrated sentence window. A silent job passes only with no audio stream. These checks appear in `render/report.json` (`audio.expected`, `audio.verified`, `audio.checks`). Technical QA stays `pending` (Stage H).

## Invalidation

| Change | Re-runs |
|---|---|
| script text | script → localize → narrate → assets → queue-render → render |
| voice id, provider, engine/model version, voice config, glossary pronunciations | narrate → … → render |
| `voice.speakingRate` | script (its estimates use it) → … → render; research is reused |
| caption style (`render.captions`) | assets → queue-render → render (no synthesis) |
| narration file edited or deleted | narrate (from the sentence cache) |
| a provider becomes unavailable | only narrated jobs block, at narrate |
