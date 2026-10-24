# Research standards

CreatorFlow does **no live web research** in this release. The `manual-sources` provider imports sources that you (or the agent, with the user's permission and its own browsing tools) collected and saved locally. Rankings use only that evidence; there is no trend or popularity data.

## Research input file (`research-input.schema.json`)

```json
{
  "sessionTopic": "AI coding agents",
  "sources": [
    { "key": "s-docs", "url": "https://…", "title": "…", "publisher": "…", "sourceType": "official-documentation",
      "publishedAt": "2026-10-20", "modifiedAt": "…", "retrievedAt": "2026-10-24",
      "snapshot": "snapshots/docs.html", "attribution": "…", "usageRestrictions": ["Quote at most two sentences"],
      "notes": "…", "confidenceNotes": "…" }
  ],
  "claims": [
    { "key": "c-hooks", "kind": "fact", "text": "Hooks run before and after each tool call.",
      "evidence": [{ "source": "s-docs", "kind": "quote", "excerpt": "Hooks run before and after each tool call", "locator": "#hooks" }] }
  ],
  "candidates": [
    { "key": "hooks-explained", "topic": "Agent hooks explained", "category": "explainer",
      "claims": ["c-hooks"], "workingTitle": "…", "hook": "…", "angle": "…", "audienceProblem": "…",
      "platform": "youtube-shorts", "language": "en", "durationSec": 45, "requiredAssets": [], "breaking": false }
  ]
}
```

Example: [../assets/research.example.json](../assets/research.example.json) (fictional data). Import with `creatorflow research --input <file-or-directory>`. A directory imports every `.json` file in it, in name order.

Rules:
- Only state dates the source itself states. Leave `publishedAt`, `retrievedAt` and other fields out when unknown; CreatorFlow lists them in `missingMetadata` and never fills them in.
- `sourceType`: `official-documentation`, `official-announcement`, `changelog`, `repository`, `paper` (primary); `reputable-reporting` (secondary); `community`, `user-notes`, `other` (tertiary; `other` needs `otherDescription`).
- `snapshot`: a saved `.html`, `.htm`, `.txt` or `.md` copy, relative to the input file and inside its directory (no `..`, no symlinks, 5 MB max). HTML is reduced to plain text; scripts, styles and comments are dropped. Quote excerpts are checked against it.
- Claim `kind`: `fact` (must be supported), `interpretation` (opinion), `hypothesis` (idea or prediction; never presented as fact).
- Candidate `key` becomes the plan `contentId`. Keep it stable when editing.

## What CreatorFlow records and computes

- **Source IDs** come from the canonical URL (lower-case host, no fragment, no `utm_*`/`fbclid`/`gclid`, sorted query, no trailing slash), or `src-k-<key>` when there is no URL. The same canonical URL with the same details is a duplicate and is merged; with different details it is a conflict, and the first occurrence is kept.
- **Evidence check** per excerpt: `found-in-snapshot`, `not-found-in-snapshot` (does not count) or `not-checked` (no snapshot).
- **Claim support** (facts): `supported` (a primary or secondary source, with the excerpt found in a snapshot); `supported-unchecked` (a primary or secondary source, not checked against a snapshot); `weak` (tertiary sources only); `unsupported`. With `research.requireSnapshotMatch: true`, unchecked evidence counts as `weak`.
- **Source verification**: `excerpts-found-in-snapshot`, `excerpt-mismatch`, `snapshot-without-excerpts` or `no-snapshot`. "Found in snapshot" means the saved copy contains the text. It does **not** prove the saved copy matches the live page, and schema validity never makes a source "verified".
- **Untrusted content**: text that looks like instructions to an AI is listed in `untrustedContentWarnings` and kept only as data.
- Records whose input is invalid are rejected individually, with the field and reason. A file that is not a research bundle fails the whole import, and nothing is written.
- Re-importing identical content writes nothing. Changing one source updates only that record's `lastChangedAt` and hash. `--replace` makes the session exactly match the input.

## Topic scoring (`cf-score-v1`)

Each factor is scored 0–1. `score = 100 × Σ weight × factor`, rounded to one decimal. Default weights: freshness 0.30, relevance 0.25, evidence 0.20, originality 0.15, feasibility 0.10 (`config.research.weights`, which must sum to 1).

| Factor | How it is computed |
|---|---|
| Freshness | Age of the newest dated source that supports a fact, as of the planning date: `1 − age / horizon`. Horizon is `2 × newsFreshnessDays` for news or `breaking` items, and 365 days otherwise. |
| Relevance | Best word overlap between the topic, angle, audience problem and working title and one profile topic, or 0.8 × overlap with the niche. |
| Evidence | Mean over fact claims of the best evidence value: source weight (primary 1, secondary 0.8, community 0.4, notes/other 0.3) × check (found 1, unchecked 0.7, not found 0). |
| Originality | 1 − highest topic similarity (word Jaccard) to items in up to 8 earlier **approved** weekly plans. If there is no history, this is 1. |
| Feasibility | Effort low 1 / medium 0.7 / high 0.4. Tutorials, comparisons and experiments start at medium; more than 180 s adds a level; 3+ required assets adds a level. Asset availability is not checked yet. |

**Missing information** (e.g. no dated source) scores 0 for that factor and is listed in `missingFactors`. It never raises a score.

Scores are prioritisation heuristics. They do not predict views, engagement, virality or search volume.

## Hard eligibility rules (no score overrides them)

| Code | Rule |
|---|---|
| `UNSUPPORTED_FACT` | A fact claim is `weak` or `unsupported`. Fix: add a primary or reputable source, or relabel the claim as interpretation or hypothesis. |
| `INSUFFICIENT_EVIDENCE` | Fewer than `research.minSupportedFacts` (default 1) supported facts. |
| `STALE_NEWS` | A news or `breaking` item whose newest supporting source is older than `newsFreshnessDays`. |
| `NEWS_UNDATED` | A news or `breaking` item with no dated supporting source. |
| `AVOIDED_TOPIC` / `BLOCKED_TERM` | Mentions a term in `profile.content.avoidTopics` or `config.research.blockedTerms` (whole words, case-insensitive). |
| `LANGUAGE_NOT_CONFIGURED` / `PLATFORM_NOT_CONFIGURED` | The candidate's language or platform is not in the profile. |
| `MISSING_CLAIM` | A referenced claim was removed from the session. |

Evidence from a source dated after the planning date does not count. Free-text `profile.content.restrictions` cannot be checked mechanically, so they are added to every plan item as a caveat for manual review.

## When research is unavailable

If you cannot browse and the user has no sources, say so. Do not write sources from memory. Candidates without supported facts are reported as ineligible, and `plan-week` reports a shortfall instead of inventing topics.
