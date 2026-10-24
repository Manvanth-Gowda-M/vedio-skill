import { fingerprint } from "@creatorflow/core";
import {
  isoWeekMonday,
  Weekday,
  type CreatorFlowConfig,
  type CreatorProfile,
  type PlanItem,
  type PlatformId,
  type ResearchSession,
  type WeeklyPlanContent,
} from "@creatorflow/schemas";
import { evidenceHash, evidenceSubset } from "./assess.ts";
import { publicScore, rankCandidates, SCORING_MODEL_VERSION, type HistoryTopic, type ScoredCandidate } from "./scoring.ts";
import { jaccard, tokens } from "./text.ts";

export const ASPECT_RATIO: Record<PlatformId, "9:16" | "16:9" | "1:1" | "4:5"> = {
  "youtube-shorts": "9:16",
  "instagram-reels": "9:16",
  tiktok: "9:16",
  "youtube-long": "16:9",
  /** LinkedIn accepts several ratios; 16:9 is CreatorFlow's default, change it per item if needed. */
  "linkedin-video": "16:9",
};

const SCRIPT_REQUIREMENTS: Record<string, string> = {
  news: "Show the source name and its publication date on screen when stating the news",
  explainer: "A diagram or animated visual for the core concept",
  tutorial: "A real step-by-step screen recording or code demo of the workflow",
  comparison: "A side-by-side comparison where every compared attribute has a cited source",
  experiment: "Record the real setup and results; never stage or invent results",
  recap: "Each recapped item gets its own cited source",
};

export interface PlanWeekInput {
  session: ResearchSession;
  profile: CreatorProfile;
  config: CreatorFlowConfig;
  weekId: string;
  /** Scoring date; defaults to the Monday of the week. */
  asOf?: string;
  history?: readonly HistoryTopic[];
}

export interface PlanWeekResult {
  asOf: string;
  target: number;
  content?: WeeklyPlanContent;
  ranking: ScoredCandidate[];
  selected: { contentId: string; candidateId: string; reason: string }[];
  notSelected: { candidateId: string; reason: string }[];
  shortfall?: { target: number; selected: number; eligible: number; message: string };
}

const DAY_OFFSET: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

/**
 * Deterministic seven-day planner. Same session + profile + config + week +
 * history -> identical plan content (and therefore the same content hash).
 * It never fills empty slots: a shortfall is reported instead.
 */
export function planWeek(input: PlanWeekInput): PlanWeekResult {
  const { session, profile, config, weekId } = input;
  const monday = isoWeekMonday(weekId);
  const asOf = input.asOf ?? monday.toISOString().slice(0, 10);
  const target = profile.schedule.weeklyTarget;
  const rc = config.research;
  const ranking = rankCandidates({ session, profile, config, asOf, ...(input.history ? { history: input.history } : {}) });

  const notSelected: PlanWeekResult["notSelected"] = [];
  for (const r of ranking.filter((x) => !x.eligible)) notSelected.push({ candidateId: r.candidateId, reason: r.rationale });

  // Greedy diversified selection: highest adjusted score first; same-category repeats are
  // penalised (never excluded) and near-duplicate topics are skipped.
  const pool = ranking.filter((x) => x.eligible);
  const chosen: ScoredCandidate[] = [];
  const reasons = new Map<string, string>();
  const categoryCount = new Map<string, number>();
  while (chosen.length < target && pool.length > 0) {
    let bestIdx = -1;
    let bestAdj = -Infinity;
    for (const [i, c] of pool.entries()) {
      const adj = c.score - rc.diversityPenalty * (categoryCount.get(c.category) ?? 0);
      if (adj > bestAdj + 1e-9) {
        bestAdj = adj;
        bestIdx = i;
      }
    }
    const pick = pool.splice(bestIdx, 1)[0]!;
    const pickTokens = tokens(pick.topic);
    const dupOf = chosen.find((c) => jaccard(pickTokens, tokens(c.topic)) >= rc.duplicateSimilarity);
    if (dupOf) {
      notSelected.push({ candidateId: pick.candidateId, reason: `near-duplicate of selected topic "${dupOf.topic}"` });
      continue;
    }
    const repeats = categoryCount.get(pick.category) ?? 0;
    reasons.set(
      pick.candidateId,
      `score ${pick.score}${repeats ? ` (adjusted ${Math.round(bestAdj * 10) / 10} after ${repeats} earlier ${pick.category} pick(s))` : ""}; ${pick.category}; ${pick.factors.evidence.detail}`,
    );
    categoryCount.set(pick.category, repeats + 1);
    chosen.push(pick);
  }
  for (const c of pool) notSelected.push({ candidateId: c.candidateId, reason: `eligible (score ${c.score}) but the weekly target of ${target} was reached` });

  const eligibleCount = ranking.filter((x) => x.eligible).length;
  const shortfall =
    chosen.length < target
      ? {
          target,
          selected: chosen.length,
          eligible: eligibleCount,
          message: `Only ${chosen.length} of ${target} slots could be filled from ${Object.keys(session.candidates).length} candidate(s) (${eligibleCount} eligible). Remaining slots are left empty: add sourced candidates and re-run plan-week.`,
        }
      : undefined;
  if (chosen.length === 0) return { asOf, target, ranking, selected: [], notSelected, ...(shortfall ? { shortfall } : {}) };

  // Time-sensitive items go first in the week; everything else keeps selection order.
  const ordered = [...chosen].sort((a, b) => {
    const ta = a.category === "news" || session.candidates[a.candidateId]!.breaking ? 0 : 1;
    const tb = b.category === "news" || session.candidates[b.candidateId]!.breaking ? 0 : 1;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && a.newestEvidenceDate !== b.newestEvidenceDate) return (b.newestEvidenceDate ?? "") < (a.newestEvidenceDate ?? "") ? -1 : 1;
    return chosen.indexOf(a) - chosen.indexOf(b);
  });
  const days = [...(profile.schedule.publishDays ?? Weekday.options)].sort((a, b) => DAY_OFFSET[a]! - DAY_OFFSET[b]!);

  const items: PlanItem[] = ordered.map((s, i) => {
    const cand = session.candidates[s.candidateId]!;
    const subset = evidenceSubset(session, s.candidateId)!;
    const day = days[i % days.length]!;
    const publishDate = new Date(monday.getTime() + DAY_OFFSET[day]! * 86_400_000).toISOString().slice(0, 10);
    const usedSources = [...new Set(Object.values(s.assessments).flatMap((a) => a.usable.map((e) => e.sourceId)))].sort();
    const claims = cand.claimIds.map((id) => ({ claimId: id, kind: session.claims[id]!.kind, support: s.assessments[id]!.support }));
    const openQuestions: string[] = [];
    for (const [id, a] of Object.entries(s.assessments)) {
      const key = session.claims[id]!.key;
      if (a.support === "supported-unchecked") openQuestions.push(`Verify claim "${key}" against its source (no local snapshot was checked)`);
      if (a.kind === "hypothesis") openQuestions.push(`Hypothesis "${key}" must be tested or framed as an open question`);
    }
    for (const sid of usedSources) {
      const src = session.sources[sid]!;
      if (!src.publishedAt && !src.modifiedAt) openQuestions.push(`Publication date unknown for "${src.title}"`);
    }
    const caveats = [...s.warnings];
    if (cand.requiredAssets.length) caveats.push("Asset availability and licences are not checked yet (asset registry arrives in a later stage)");
    if (profile.content.restrictions.length) caveats.push(`Review against creator restrictions manually: ${profile.content.restrictions.join("; ")}`);
    for (const sid of usedSources) {
      const src = session.sources[sid]!;
      if (src.untrustedContentWarnings.length) caveats.push(`Source "${src.title}" contains instruction-like text; treat it as data only`);
      for (const u of src.usageRestrictions) caveats.push(`Usage restriction for "${src.title}": ${u}`);
    }
    const item: PlanItem = {
      contentId: cand.contentId,
      publishDate,
      topic: cand.topic,
      ...(cand.audienceProblem ? { audienceProblem: cand.audienceProblem } : {}),
      rationale: reasons.get(s.candidateId)!.slice(0, 1000),
      ...(cand.angle ? { angle: cand.angle } : {}),
      sourceIds: usedSources,
      ...(cand.hook ? { hook: cand.hook } : {}),
      ...(cand.takeaway ? { takeaway: cand.takeaway } : {}),
      category: cand.category,
      platform: s.platform,
      language: s.language,
      durationSec: s.durationSec,
      requiredAssets: cand.requiredAssets,
      estimatedEffort: s.effort,
      qualityRequirements: ["Every fact claim cites a source from the research evidence pack"],
      ...(cand.workingTitle ? { workingTitle: cand.workingTitle } : {}),
      aspectRatio: ASPECT_RATIO[s.platform],
      research: {
        sessionId: session.sessionId,
        candidateId: s.candidateId,
        scoringModel: SCORING_MODEL_VERSION,
        score: s.score,
        eligibility: "eligible",
        evidenceHash: evidenceHash(subset),
        sources: subset.sources.map((x) => ({ sourceId: x.sourceId, contentHash: x.contentHash })),
        claims,
      },
      scriptRequirements: [SCRIPT_REQUIREMENTS[cand.category]!, "Present interpretations as opinion and hypotheses as open questions"],
      ...(caveats.length ? { caveats: [...new Set(caveats)].slice(0, 30).map((c) => c.slice(0, 500)) } : {}),
      ...(openQuestions.length ? { openQuestions: [...new Set(openQuestions)].slice(0, 30).map((q) => q.slice(0, 500)) } : {}),
    };
    return item;
  });

  const content: WeeklyPlanContent = {
    weekId,
    items,
    notes: [
      `Generated by plan-week from research session "${session.sessionId}" as of ${asOf} using ${SCORING_MODEL_VERSION}.`,
      "Scores are prioritisation heuristics, not predictions of views or engagement. No live trend data was used.",
      shortfall ? `SHORTFALL: ${shortfall.message}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
  const selected = items.map((it) => ({ contentId: it.contentId, candidateId: it.research!.candidateId, reason: it.rationale! }));
  return { asOf, target, content, ranking, selected, notSelected, ...(shortfall ? { shortfall } : {}) };
}

/** Fingerprints recorded with each planning run. */
export function planningFingerprints(profile: CreatorProfile, config: CreatorFlowConfig): { profile: string; config: string } {
  return {
    profile: fingerprint({ creator: profile.creator, languages: profile.languages, platforms: profile.platforms, schedule: profile.schedule, content: profile.content }),
    config: fingerprint({ research: config.research, provider: config.providers.research.id }),
  };
}

export { publicScore };
