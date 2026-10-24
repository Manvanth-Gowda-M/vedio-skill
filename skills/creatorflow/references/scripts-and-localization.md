# Scripts, storyboards, localization and subtitles

## What the script step produces (per job, under `workspace/jobs/<jobId>/script/`)

| File | Schema | Content |
|---|---|---|
| `script.json` | `canonical-script.schema.json` | Segments (hook, context, explanation, demonstration, takeaway, outro), each with narration, on-screen text, claim references, text origin, timing estimate, visual direction, transition, editorial notes. Also: attributions, dropped segments, and editorial status and issues. |
| `storyboard.json` | `storyboard.schema.json` | One scene per segment with contiguous estimated timing, scene type, visual hierarchy, motion intent, text layout check, safe area, and asset requirements. |
| `captions.json` | `subtitle-tracks.schema.json` | Canonical-language subtitle cues (timing estimated). |
| `scene-manifest.json` | `scene-manifest.schema.json` | Declarative render contract: plan version and hash, script/storyboard/captions paths and hashes, resolution, fps, frames per scene, cue IDs, assets, brand colours and fonts, attributions, narration requirements. It contains no code. |

## Script formats

The format is chosen from the plan item's category and platform: `news-update`, `tutorial`, `comparison`, `short-explainer` (vertical explainer), `long-explainer` (landscape explainer, adds verified source quotations), and `evergreen-explainer` (recaps and experiments).

## Where every sentence comes from (`textOrigin`)

- `claim`: the exact text of a claim from `research/evidence.json`. Facts are introduced as "According to <publisher>: …", interpretations as "One interpretation: …", and hypotheses as "An open question: …".
- `source`: names a source and the date it states, or quotes an excerpt that was found verbatim in a saved copy.
- `plan`: the creator's own hook, angle, audience problem, takeaway or call to action from the approved plan. This text is **not** checked against evidence; numbers, superlatives, "studies show" and hype wording are flagged as warnings.
- `template`: fixed connective wording that asserts nothing.

The template provider is a conservative baseline. It does not paraphrase, embellish, invent steps, results or experiences, or add context the plan does not contain. The output is evidence-consistent, but it is not necessarily engaging: review it.

`validateScriptAgainstEvidence` (used by the step and by `script validate`) rejects:
- unknown claims;
- claims whose kind, support or usage differ from the evidence;
- facts that are no longer supported;
- altered claim text;
- opinions phrased as sourced facts;
- quotes not found in a saved copy;
- unknown sources;
- missing or altered attributions and usage restrictions.

It cannot prove that free-form wording adds no facts. A future model-based provider must add a factual review step.

## Timing

Duration is `max(minSegmentSec, words ÷ wpm × 60 ÷ speakingRate) + segmentPauseSec` per segment. Words are counted with `Intl.Segmenter` for the language. Speech rates are set in `config.script.speechRateWpm` (by tag, then base language, then `default`, 150 wpm). Every duration is an estimate until real narration exists.

- **Over target** (`maxDurationRatio`, default 1.2): optional segments are dropped (quotes, then extra explanations, then outro, then context) and their IDs are recorded.
- **Under target** (`minDurationRatio`, default 0.6): `DURATION_SHORTFALL`. CreatorFlow never pads. With `onDurationShortfall: "block"`, the step blocks instead of warning.

## Assets

Assets are always declared, never assumed:
- Scenes that need real material (code or terminal capture, screen recording, diagram, optional source screenshot) get `required-unregistered` requirements.
- Plan `requiredAssets` are attached to matching scenes.
- The brand logo and fonts are `declared-unverified`.

The asset registry (a later stage) is what will verify files and licences.

## Localization

- **Targets** come from `config.localization.targetLanguages`: `"profile"` (primary + additional profile languages) or an explicit list of BCP 47 tags such as `en-IN`, `hi-IN`, `kn-IN`, `ta-IN`, `te-IN` or `ml-IN`.
- **Same language as the canonical script:** a canonical variant.
- **Same base language, different region** (e.g. `en` → `en-IN`): an `adapted` variant with identical text, marked `unreviewed` with `NO_REGIONAL_ADAPTATION`.
- **Different language:** needs an imported human translation. No machine translation provider exists; the default `import-only` provider returns `UNSUPPORTED`. The step **blocks** (`NEEDS_TRANSLATION` / `TRANSLATION_INVALID`) until every target is valid, and never copies the source text as a "translation".

```sh
creatorflow localize template --job 2026-w44-hooks-explained --lang hi-IN   # blank template with source text for reference
# a human fills in translator.name, title, and narration/onScreenText per segment
creatorflow localize import --job 2026-w44-hooks-explained --file hi-IN.json
creatorflow localize validate --job 2026-w44-hooks-explained
creatorflow resume
creatorflow subtitles export --job 2026-w44-hooks-explained --lang hi-IN --format vtt
```

**Import checks.** Errors block the import:
- schema problems;
- wrong content or language;
- stale script hash;
- missing, extra or duplicate segments;
- untranslated (identical) narration;
- placeholders;
- bidi or invisible control characters (ZWJ/ZWNJ are allowed);
- `doNotTranslate` glossary terms missing;
- `???` encoding damage.

Warnings do not block:
- text mostly not in the expected script (e.g. Devanagari for `hi`, Kannada for `kn`);
- unused preferred glossary terms;
- localized narration likely longer than its scene.

Text is stored NFC-normalised. Claim references are copied from the canonical segment, so a translation cannot change them.

**Review status** is `unreviewed` unless the import states a `review` (reviewer and date), recorded as `reviewed-claimed-by-importer`. CreatorFlow cannot judge translation quality.

**Font coverage** for non-Latin scripts is `not-verified`: check that your brand fonts cover the scripts listed in `requiredScripts` (the default Inter font covers Latin, Greek and Cyrillic).

Glossary entries live in `profile.voice.glossary`: `term`, `category` (product, technical, brand or other), `doNotTranslate`, `pronunciation`, and `preferred: { "<lang>": "<term>" }`.

## Subtitles

- Cues never cross a segment boundary and break at sentence ends where possible.
- Lines wrap at word boundaries measured in grapheme clusters (Indic conjuncts and emoji stay intact) and are never truncated. A word longer than the line limit gets its own line and a warning.
- Warnings cover reading speed (`maxCps`), short cues (`minCueMs`) and long lines.
- Export is UTF-8 SRT or WebVTT. The VTT includes a `NOTE` stating the timing is estimated. Text containing `-->` is refused rather than altered.

## Dates

`evidenceAsOf` in a script is the item's **scheduled publish date**, the date evidence must be valid on, not the time anything ran. Execution times exist only in job records (attempt `startedAt`/`endedAt`). Script artifacts contain no execution timestamps, so regenerating from the same inputs gives byte-identical files.
