# ADR 0004 — Evidence-grounded scripts, storyboards and localization

Status: accepted (Stage E) · Date: 2026-10-22

## Decisions

1. **Two new packages with real code**:
   - `packages/scriptwriter`: Unicode text utilities, the script provider interface plus the deterministic `template` provider, the evidence validator, the storyboard, the scene manifest, subtitle cues and SRT/VTT export, and the script executor.
   - `packages/localization`: glossary, translation validation, the translation provider interface plus `import-only`, and the localize executor.

   The CLI composes them in `packages/cli/src/pipeline.ts`.
2. **The script step (v2) produces four outputs** (`script.json`, `storyboard.json`, `captions.json`, `scene-manifest.json`), all verified and hashed by the runner. The manifest and storyboard reference the script (and the manifest the captions) by sha256, so any edit is detectable (`creatorflow script validate`).
3. **Provider-independent validation.** The step validates every generated script with `validateScriptAgainstEvidence` and fails permanently (`SCRIPT_INVALID`) if it does not hold. Each segment records where its words come from (`textOrigin`). Claim-origin text must contain the claim verbatim; plan-origin text is flagged heuristically. A future LLM provider plugs into `ScriptProvider` and must add a factual review step, because a claim ID cannot prove a free-form sentence is supported.
4. **No padding, no invention.**
   - Duration shortfalls are reported (warning by default, block if configured).
   - Missing context is omitted, with an info issue.
   - Assets are declared requirements, never assumed to exist.
   - Non-English canonical scripts block with `SCRIPT_LANGUAGE_UNSUPPORTED`.
5. **Localization is honest by construction.** The localize step (v2) succeeds only when every target language has a canonical, same-language or valid imported human variant. The default `import-only` provider cannot translate. Imported translations live at `workspace/localization/<jobId>/<lang>.json`, validated against the current script hash, and stay `unreviewed` unless the importer states a review.
6. **New engine hook: `StepDefinition.externalInputs`.** It is an async, deterministic function whose result (here: the hashes of imported translation files) is folded into the step's input fingerprint, so importing or editing a translation invalidates exactly that job's localize step. The runner also passes the approved plan reference (`ctx.plan`) to executors. It is not part of any fingerprint.
7. **Engine fix:** when a step's verified outputs are reused while the job sits at that step's start state, the runner now advances the state. This happens when an upstream step re-ran and reproduced byte-identical outputs. Previously the next step threw `JOB_STATE_INCONSISTENT`. It was found by the Stage E integration tests and is covered by a mutation-checked test.
8. **Deterministic artifacts.** Scripts, storyboards, captions and manifests contain no execution timestamps. `evidenceAsOf` is the scheduled publish date. The same inputs give byte-identical files, so downstream steps are reused.
9. **Schema additions are backward compatible:**
   - new artifact roles (`storyboard`, `captions`, `localization`, `subtitles`);
   - optional glossary fields `category` and `preferred` (no defaults);
   - optional `config.script` and `config.localization` blocks.

## Fingerprint scopes

| Step | Inputs | Config | External |
|---|---|---|---|
| research | contentId, topic, sourceIds, research link | research rules, provider | – |
| script | topic, workingTitle, audienceProblem, angle, hook, takeaway, category, platform, aspectRatio, language, durationSec, requiredAssets, plus the evidence pack hash (upstream) | `config.script`, subtitle rules, target languages, brand, visual style, voice and glossary | – |
| localize | contentId, language, plus the script/storyboard/captions/manifest hashes (upstream) | targets, provider, subtitle rules, speech rates, glossary | hash of each imported translation |

## Limitations

- English-only script templates. The writing is plain and formulaic by design.
- Timing, captions and scene durations are estimates from word counts. There is no audio alignment.
- Translation quality, cultural adaptation and font glyph coverage are not verified.
- The unsupported-assertion check for creator-written text is a keyword heuristic (English).
- Re-planning that changes one item's script makes its imported translations stale; they must be updated by a human.
