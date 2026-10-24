import type {
  CandidateRecord,
  CandidateScore,
  CreatorFlowConfig,
  CreatorProfile,
  PlatformId,
  ResearchSession,
} from "@creatorflow/schemas";
import { assessClaim, sourceDate, SOURCE_TIER, type ClaimAssessment } from "./assess.ts";
import { daysBetween, jaccard, mentionsTerm, tokens } from "./text.ts";

/**
 * Scoring model cf-score-v1. Every factor is 0..1; the score is
 * 100 x sum(weight x factor), rounded to one decimal. Missing information
 * scores 0 for that factor (never raises a score) and is listed in
 * `missingFactors`. Scores are prioritisation heuristics only: they do not
 * predict views, engagement or search volume, and no trend data is used.
 * Hard eligibility rules are evaluated separately; a high score never
 * overrides a rejection.
 */
export const SCORING_MODEL_VERSION = "cf-score-v1";

export const SHORT_FORM_PLATFORMS: ReadonlySet<PlatformId> = new Set(["youtube-shorts", "instagram-reels", "tiktok", "linkedin-video"]);
const EVERGREEN_HORIZON_DAYS = 365;

export interface HistoryTopic {
  weekId: string;
  topic: string;
}

export interface ScoringInput {
  session: ResearchSession;
  profile: CreatorProfile;
  config: CreatorFlowConfig;
  /** Planning date (YYYY-MM-DD). Evidence dated after it is ignored. */
  asOf: string;
  /** Topics from earlier approved weekly plans (for originality). */
  history?: readonly HistoryTopic[];
}

export interface ScoredCandidate extends CandidateScore {
  /** Assessment of each claim as of `asOf`, keyed by claim id. */
  assessments: Record<string, ClaimAssessment & { kind: string }>;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function isTimeSensitive(c: Pick<CandidateRecord, "category" | "breaking">): boolean {
  return c.category === "news" || c.breaking;
}

export function effortFor(c: Pick<CandidateRecord, "category" | "requiredAssets">, durationSec: number): "low" | "medium" | "high" {
  const levels = ["low", "medium", "high"] as const;
  let level = c.category === "tutorial" || c.category === "comparison" || c.category === "experiment" ? 1 : 0;
  if (durationSec > 180) level++;
  if (c.requiredAssets.length >= 3) level++;
  return levels[Math.min(level, 2)]!;
}

export function candidateText(c: CandidateRecord, session: ResearchSession): string {
  return [c.topic, c.workingTitle, c.angle, c.audienceProblem, c.hook, c.takeaway, ...c.claimIds.map((id) => session.claims[id]?.text)].filter(Boolean).join(" \n");
}

export function scoreCandidate(c: CandidateRecord, input: ScoringInput): ScoredCandidate {
  const { session, profile, config, asOf } = input;
  const rc = config.research;
  const rejections: { code: string; message: string }[] = [];
  const warnings: string[] = [];
  const missingFactors: string[] = [];
  const reject = (code: string, message: string) => rejections.push({ code, message });

  // ---------------- claims as of the planning date
  const assessments: ScoredCandidate["assessments"] = {};
  for (const id of c.claimIds) {
    const claim = session.claims[id];
    if (!claim) {
      reject("MISSING_CLAIM", `Claim ${id} is no longer in the session`);
      continue;
    }
    const a = assessClaim(claim, session.sources, { asOf, requireSnapshotMatch: rc.requireSnapshotMatch });
    assessments[id] = { ...a, kind: claim.kind };
    for (const n of a.notes) warnings.push(`${claim.key}: ${n}`);
  }
  const facts = Object.entries(assessments).filter(([, a]) => a.kind === "fact");
  const strongFacts = facts.filter(([, a]) => a.support === "supported" || a.support === "supported-unchecked");
  for (const [id, a] of facts) {
    if (a.support === "weak" || a.support === "unsupported") {
      reject("UNSUPPORTED_FACT", `Fact "${session.claims[id]!.key}" is ${a.support}; add a primary/reputable source or relabel it as interpretation or hypothesis`);
    } else if (a.support === "supported-unchecked") {
      warnings.push(`${session.claims[id]!.key}: evidence not checked against a snapshot`);
    }
  }
  if (strongFacts.length < rc.minSupportedFacts) {
    reject("INSUFFICIENT_EVIDENCE", `${strongFacts.length} supported fact(s); at least ${rc.minSupportedFacts} required`);
  }

  // ---------------- platform, language, duration
  const allLanguages = [profile.languages.primary, ...profile.languages.additional];
  const language = c.language ?? profile.languages.primary;
  if (!allLanguages.includes(language)) reject("LANGUAGE_NOT_CONFIGURED", `Language ${language} is not in the creator profile (${allLanguages.join(", ")})`);
  const platforms = [profile.platforms.primary, ...profile.platforms.secondary];
  const platform = c.platform ?? profile.platforms.primary;
  if (!platforms.includes(platform)) reject("PLATFORM_NOT_CONFIGURED", `Platform ${platform} is not in the creator profile (${platforms.join(", ")})`);
  const range = SHORT_FORM_PLATFORMS.has(platform) ? profile.schedule.durations.shortForm : profile.schedule.durations.longForm;
  let durationSec = c.durationSec ?? Math.round((range.minSec + range.maxSec) / 2);
  if (durationSec < range.minSec || durationSec > range.maxSec) {
    const clamped = Math.min(range.maxSec, Math.max(range.minSec, durationSec));
    warnings.push(`duration ${durationSec}s is outside the profile range ${range.minSec}-${range.maxSec}s for ${platform}; using ${clamped}s`);
    durationSec = clamped;
  }

  // ---------------- content restrictions
  const textTokens = tokens(candidateText(c, session));
  for (const t of profile.content.avoidTopics) if (mentionsTerm(textTokens, t)) reject("AVOIDED_TOPIC", `Mentions "${t}", which the creator profile avoids`);
  for (const t of rc.blockedTerms) if (mentionsTerm(textTokens, t)) reject("BLOCKED_TERM", `Mentions blocked term "${t}"`);

  // ---------------- freshness
  const usableSourceIds = new Set(facts.flatMap(([, a]) => a.usable.map((e) => e.sourceId)));
  const dates = [...usableSourceIds].map((id) => session.sources[id]).flatMap((s) => (s && sourceDate(s) ? [sourceDate(s)!] : []));
  const newest = dates.sort().at(-1);
  const timeSensitive = isTimeSensitive(c);
  const freshnessDays = profile.content.newsFreshnessDays;
  let freshness: CandidateScore["factors"]["freshness"];
  if (!newest) {
    missingFactors.push("freshness");
    freshness = { score: null, detail: "no supporting source states a publication or modification date" };
    if (timeSensitive) reject("NEWS_UNDATED", "Time-sensitive topic but no supporting source is dated; it cannot be presented as new");
  } else {
    const age = daysBetween(newest, asOf);
    const horizon = timeSensitive ? 2 * freshnessDays : EVERGREEN_HORIZON_DAYS;
    freshness = { score: r3(Math.max(0, Math.min(1, 1 - age / horizon))), detail: `newest supporting source is ${age} day(s) old as of ${asOf} (horizon ${horizon} days)` };
    if (timeSensitive && age > freshnessDays) {
      reject("STALE_NEWS", `Newest supporting source is ${age} days old; news must be at most ${freshnessDays} days old (profile.content.newsFreshnessDays)`);
    }
  }

  // ---------------- relevance
  const topicTokens = tokens(c.topic + " " + (c.angle ?? "") + " " + (c.audienceProblem ?? "") + " " + (c.workingTitle ?? ""));
  let bestTopic = { score: 0, label: "" };
  for (const t of profile.creator.topics) {
    const tt = tokens(t);
    if (tt.size === 0) continue;
    let hit = 0;
    for (const x of tt) if (topicTokens.has(x)) hit++;
    const s = hit / tt.size;
    if (s > bestTopic.score) bestTopic = { score: s, label: `${t}" (${hit}/${tt.size} words)` };
  }
  const nicheTokens = tokens(profile.creator.niche);
  let nicheHits = 0;
  for (const x of nicheTokens) if (topicTokens.has(x)) nicheHits++;
  const nicheScore = nicheTokens.size ? (0.8 * nicheHits) / nicheTokens.size : 0;
  const relevanceScore = r3(Math.min(1, Math.max(bestTopic.score, nicheScore)));
  const relevance = {
    score: relevanceScore,
    detail: bestTopic.score >= nicheScore && bestTopic.score > 0 ? `matches profile topic "${bestTopic.label}` : nicheScore > 0 ? `matches ${nicheHits} niche word(s)` : "no overlap with profile topics or niche",
  };

  // ---------------- evidence quality
  const evidenceScore = facts.length ? r3(facts.reduce((sum, [, a]) => sum + a.quality, 0) / facts.length) : 0;
  const primary = [...usableSourceIds].filter((id) => session.sources[id] && SOURCE_TIER[session.sources[id]!.sourceType].tier === "primary").length;
  const evidence = { score: evidenceScore, detail: `${strongFacts.length}/${facts.length} fact(s) supported; ${usableSourceIds.size} source(s), ${primary} primary` };

  // ---------------- originality
  const ownTopic = tokens(c.topic);
  let similar = { s: 0, label: "" };
  for (const h of input.history ?? []) {
    const s = jaccard(ownTopic, tokens(h.topic));
    if (s > similar.s) similar = { s, label: `"${h.topic}" (${h.weekId})` };
  }
  const originality = input.history?.length
    ? { score: r3(1 - similar.s), detail: similar.s > 0 ? `most similar earlier topic ${similar.label}, similarity ${r3(similar.s)}` : "no similar topic in earlier approved plans" }
    : { score: 1, detail: "no earlier approved plans to compare" };

  // ---------------- feasibility
  const effort = effortFor(c, durationSec);
  const feasibility = { score: { low: 1, medium: 0.7, high: 0.4 }[effort], detail: `${effort} effort (${c.category}, ${durationSec}s, ${c.requiredAssets.length} required asset(s)); asset availability not checked yet` };

  const factors = { freshness, relevance, evidence, originality, feasibility };
  const w = rc.weights;
  const total = w.freshness * (freshness.score ?? 0) + w.relevance * relevance.score + w.evidence * evidence.score + w.originality * originality.score + w.feasibility * feasibility.score;
  const score = Math.round(total * 1000) / 10;

  const rationale = rejections.length
    ? `INELIGIBLE (${rejections.map((r) => r.code).join(", ")}): ${rejections[0]!.message}`
    : `${score}/100: ${freshness.detail}; ${relevance.detail}; ${evidence.detail}; ${originality.detail}; ${effort} effort`;

  return {
    candidateId: c.candidateId,
    contentId: c.contentId,
    topic: c.topic,
    category: c.category,
    factors,
    missingFactors,
    score,
    eligible: rejections.length === 0,
    rejections,
    warnings: [...new Set(warnings)],
    rationale,
    effort,
    platform,
    language,
    durationSec,
    ...(newest ? { newestEvidenceDate: newest } : {}),
    assessments,
  };
}

/** Scores every candidate; order: eligible first, then score desc, then candidate id (deterministic). */
export function rankCandidates(input: ScoringInput): ScoredCandidate[] {
  return Object.values(input.session.candidates)
    .map((c) => scoreCandidate(c, input))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || (a.candidateId < b.candidateId ? -1 : 1));
}

/** Strips the internal assessments for persistence/output. */
export function publicScore(s: ScoredCandidate): CandidateScore {
  const { assessments: _a, ...rest } = s;
  return rest;
}
