# ADR 0003 — Research engine and weekly planner

Status: accepted (Stage D) · Date: 2026-10-22

## Decisions

1. **Offline, user-supplied research only.** The single implemented provider, `manual-sources`, imports local JSON bundles and optional HTML/text snapshots. The provider interface (`packages/research/src/provider.ts`) declares capabilities: `importLocal`, `webSearch`, `fetchUrl`, `modelAssist`. Unknown or disabled providers return typed `UNSUPPORTED` / `DISABLED` results (CLI exit 3) and are never substituted. No fake online provider exists.
2. **Evidence is stored separately from plans and scripts.** Research sessions live in `workspace/research/<session>/session.json` (locked, revisioned, previous copy kept as `session.prev.json`). Snapshot texts are content-addressed in `snapshots/`, and planning runs in `runs/<week>-vNNNN.json`.
3. **Plans link to research by hash.** Each planned item carries `research.evidenceHash`: a fingerprint of exactly the candidate, claim and source records it relies on. Unrelated record changes therefore never alter an item, and changed evidence alters only the items that cite it.
4. **Plans go through the existing `PlanStore`.** `plan-week` saves an ordinary immutable version. Approval is never created automatically. Plan content contains no timestamps, so the same inputs give the same hash, and a re-run returns `unchanged`.
5. **New plan-item fields are optional without defaults** (`workingTitle`, `aspectRatio`, `research`, `scriptRequirements`, `caveats`, `openQuestions`). Normalised Stage C plan content, and therefore its hash, is unchanged. A test pins this.
6. **The research step verifies; it does not research.** At production time it checks that the referenced session, records and snapshot texts are unchanged since planning, re-assesses facts as of the publish date, and writes `research/evidence.json` (`research-evidence.schema.json`). Changed or missing research → `BLOCKED` (the user must re-plan and re-approve; no retries are used). Facts no longer supported → permanent failure.
7. **Fingerprint scope of the research step:** `contentId`, `topic`, `sourceIds` and the research link (session, candidate, evidence hash, source and claim refs). The score, hook, publish date and other presentation fields are excluded, so re-weighting or re-wording does not redo verified research.
8. **The production pipeline moved from `packages/orchestrator` to `packages/cli/src/pipeline.ts`.** The engine stays generic and the CLI composes executors. `packages/research` depends on the orchestrator, never the reverse.
9. **Shortfalls are reported, not padded.** With some eligible candidates, `plan-week` saves the shorter plan and exits 1 with a `shortfall` block. With none, it saves nothing (`NO_ELIGIBLE_TOPICS`, exit 1). There is no evergreen fallback.

Scoring model and eligibility rules: `skills/creatorflow/references/research-standards.md`.

## Limitations

- Excerpt matching proves only that the user's saved snapshot contains the text, not that the live page does, or that the source is accurate.
- Relevance and originality are word-overlap heuristics: no synonyms, no semantics, English stopwords only.
- Free-text profile restrictions are not evaluated automatically; they appear as caveats.
- Asset availability is not checked (Stage G), so feasibility uses declared asset counts only.
- Additional profile languages are not planned as separate variants; localisation is Stage E.
- Research changes after approval do not affect production until a new plan version is generated and approved. This is deliberate: approved work follows approved content.
