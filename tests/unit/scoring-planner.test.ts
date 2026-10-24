// Scoring and planning over FICTIONAL fixture research. No network, no live trend data.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprint } from "@creatorflow/core";
import { PlanStore, planContentHash } from "@creatorflow/orchestrator";
import {
  importIntoSession,
  ManualSourcesProvider,
  planWeek,
  rankCandidates,
  researchPaths,
  scoreCandidate,
  SCORING_MODEL_VERSION,
  type ScoringInput,
} from "@creatorflow/research";
import { CreatorFlowConfigSchema, CreatorProfileSchema, WeeklyPlanContentSchema, type CreatorFlowConfig, type CreatorProfile, type ResearchSession } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { ELIGIBLE_KEYS, FIXTURE_WEEK, RESEARCH_PROFILE, writeResearchFixture, type FixtureOptions } from "../fixtures/research-fixture.ts";
import { setupProject, type FixtureProject } from "../workflow-helpers.ts";

const AS_OF = "2026-10-26";

describe("scoring cf-score-v1 and the seven-day planner", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  let session: ResearchSession;
  const base = (): ScoringInput => ({ session, profile: p.profile, config: p.config, asOf: AS_OF });

  async function importFixture(opts: FixtureOptions = {}, sessionId = "main"): Promise<ResearchSession> {
    const inDir = path.join(tmp.dir, `in-${sessionId}`);
    await writeResearchFixture(inDir, opts);
    const r = await new ManualSourcesProvider().importLocal({ path: inDir });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (await importIntoSession({ paths: researchPaths(p.ws), sessionId, bundle: r.value, providerId: "manual-sources" })).session;
  }

  beforeEach(async () => {
    tmp = await makeTempDir("cf-score-");
    p = await setupProject(tmp.dir, {}, RESEARCH_PROFILE);
    session = await importFixture();
  });
  afterEach(() => tmp.cleanup());

  const byKey = (ranking: ReturnType<typeof rankCandidates>, key: string) => ranking.find((r) => r.contentId === key)!;

  it("is deterministic and explainable", () => {
    const a = rankCandidates(base());
    const b = rankCandidates(base());
    expect(a).toEqual(b);
    const s = byKey(a, "subagents-release");
    expect(Object.keys(s.factors)).toEqual(["freshness", "relevance", "evidence", "originality", "feasibility"]);
    expect(s.factors.freshness).toEqual({ score: 0.786, detail: "newest supporting source is 6 day(s) old as of 2026-10-26 (horizon 28 days)" });
    expect(s.factors.evidence.score).toBe(1);
    expect(s.factors.originality).toEqual({ score: 1, detail: "no earlier approved plans to compare" });
    // 100 x (0.3*0.786 + 0.25*rel + 0.2*1 + 0.15*1 + 0.1*1)
    const w = p.config.research.weights;
    const expected = Math.round((w.freshness * 0.786 + w.relevance * s.factors.relevance.score! + w.evidence + w.originality + w.feasibility) * 1000) / 10;
    expect(s.score).toBe(expected);
    expect(s.rationale).toMatch(/^\d+(\.\d)?\/100: newest supporting source is 6 day/);
  });

  it("uses the documented default weights", () => {
    expect(p.config.research.weights).toEqual({ freshness: 0.3, relevance: 0.25, evidence: 0.2, originality: 0.15, feasibility: 0.1 });
    expect(CreatorFlowConfigSchema.safeParse({ schemaVersion: 1, research: { weights: { freshness: 0.9 } } }).success).toBe(false);
  });

  it("missing information scores 0 for that factor and is reported", () => {
    const s = byKey(rankCandidates(base()), "skills-explainer");
    expect(s.eligible).toBe(true); // evergreen topic: undated is allowed but costs the freshness weight
    expect(s.missingFactors).toEqual(["freshness"]);
    expect(s.factors.freshness.score).toBeNull();
    const withDate = rankCandidates({ ...base(), session: { ...session, sources: Object.fromEntries(Object.entries(session.sources).map(([k, v]) => [k, v.key === "s-undated" ? { ...v, publishedAt: "2026-10-01" } : v])) } });
    expect(byKey(withDate, "skills-explainer").score).toBeGreaterThan(s.score);
  });

  it.each([
    ["rumor-news", ["UNSUPPORTED_FACT", "INSUFFICIENT_EVIDENCE"]],
    ["notes-only", ["UNSUPPORTED_FACT", "INSUFFICIENT_EVIDENCE"]],
    ["mismatch-topic", ["UNSUPPORTED_FACT", "INSUFFICIENT_EVIDENCE"]],
    ["opinion-only", ["INSUFFICIENT_EVIDENCE"]],
    ["stale-launch", ["STALE_NEWS"]],
    ["undated-news", ["NEWS_UNDATED"]],
    ["crypto-agents", ["AVOIDED_TOPIC"]],
    ["french-video", ["LANGUAGE_NOT_CONFIGURED"]],
  ])("hard rule: %s is ineligible (%s)", (key, codes) => {
    const s = byKey(rankCandidates(base()), key);
    expect(s.eligible).toBe(false);
    expect(s.rejections.map((r) => r.code)).toEqual(codes);
    expect(s.rationale).toMatch(/^INELIGIBLE/);
  });

  it("a high score never overrides a hard rejection", () => {
    const ranking = rankCandidates(base());
    const crypto = byKey(ranking, "crypto-agents");
    const lowestEligible = Math.min(...ranking.filter((r) => r.eligible).map((r) => r.score));
    expect(crypto.score).toBeGreaterThan(lowestEligible);
    expect(ranking.indexOf(crypto)).toBeGreaterThan(ranking.findLastIndex((r) => r.eligible));
    const plan = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    expect(plan.content!.items.map((i) => i.contentId)).not.toContain("crypto-agents");
  });

  it("platform and blocked-term rules come from profile and config", () => {
    const cfg: CreatorFlowConfig = { ...p.config, research: { ...p.config.research, blockedTerms: ["MCP servers"] } };
    expect(byKey(rankCandidates({ ...base(), config: cfg }), "mcp-tutorial").rejections.map((r) => r.code)).toEqual(["BLOCKED_TERM"]);
    const prof: CreatorProfile = CreatorProfileSchema.parse({ ...p.profile, platforms: { primary: "youtube-shorts", secondary: [] } });
    expect(byKey(rankCandidates({ ...base(), profile: prof }), "mcp-comparison").rejections.map((r) => r.code)).toEqual(["PLATFORM_NOT_CONFIGURED"]);
  });

  it("requireSnapshotMatch turns unchecked facts into unsupported ones", () => {
    const cfg: CreatorFlowConfig = { ...p.config, research: { ...p.config.research, requireSnapshotMatch: true } };
    const s = byKey(rankCandidates({ ...base(), config: cfg }), "changelog-recap");
    expect(s.eligible).toBe(false);
    expect(s.rejections[0]!.code).toBe("UNSUPPORTED_FACT");
  });

  it("evidence dated after the planning date does not count", () => {
    const s = byKey(rankCandidates({ ...base(), asOf: "2026-10-19" }), "subagents-release");
    expect(s.eligible).toBe(false);
    expect(s.warnings.join(" ")).toContain("dated 2026-10-20, after 2026-10-19");
  });

  it("originality drops for topics repeated from earlier approved weeks", () => {
    const fresh = byKey(rankCandidates(base()), "hooks-explained");
    const repeated = byKey(rankCandidates({ ...base(), history: [{ weekId: "2026-W43", topic: "Agent hooks explained" }] }), "hooks-explained");
    expect(repeated.factors.originality.score).toBe(0);
    expect(repeated.factors.originality.detail).toContain("2026-W43");
    expect(repeated.score).toBeLessThan(fresh.score);
  });

  it("clamps durations to the profile range and defaults to the primary language/platform", () => {
    const cand = { ...session.candidates["cand-hooks-explained"]!, durationSec: 600 };
    const s = scoreCandidate(cand, base());
    expect(s).toMatchObject({ durationSec: 60, platform: "youtube-shorts", language: "en" });
    expect(s.warnings.join(" ")).toContain("outside the profile range 30-60s");
  });

  // ------------------------------------------------------------- planner

  it("plans seven diversified, sourced items and skips near-duplicates", () => {
    const r = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    expect(r.asOf).toBe("2026-10-26");
    expect(r.shortfall).toBeUndefined();
    const items = r.content!.items;
    expect(items).toHaveLength(7);
    expect(WeeklyPlanContentSchema.safeParse(r.content).success).toBe(true);
    expect(new Set(items.map((i) => i.contentId)).size).toBe(7);
    expect(items.map((i) => i.contentId).every((k) => ELIGIBLE_KEYS.includes(k))).toBe(true);
    expect(items.map((i) => i.publishDate)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(items[0]!.category).toBe("news"); // time-sensitive first
    expect(new Set(items.map((i) => i.category)).size).toBeGreaterThanOrEqual(5);
    expect(r.notSelected).toEqual(expect.arrayContaining([{ candidateId: "cand-hooks-explained-again", reason: 'near-duplicate of selected topic "Agent hooks explained"' }]));
    for (const it of items) {
      expect(it.research).toMatchObject({ sessionId: "main", scoringModel: SCORING_MODEL_VERSION, eligibility: "eligible" });
      expect(it.sourceIds.length).toBeGreaterThan(0);
      expect(it.research!.claims.length).toBeGreaterThan(0);
      expect(it.rationale).toMatch(/^score /);
      expect(it.aspectRatio).toBe(it.platform === "youtube-long" ? "16:9" : "9:16");
      expect(it.estimatedEffort).toMatch(/low|medium|high/);
      expect(it.scriptRequirements!.length).toBeGreaterThan(0);
    }
    const mcp = items.find((i) => i.contentId === "mcp-comparison")!;
    expect(mcp).toMatchObject({ platform: "youtube-long", durationSec: 690, aspectRatio: "16:9" });
    expect(mcp.caveats).toContain('Usage restriction for "Two agents compared (fictional)": Quote at most two sentences');
    const proto = items.find((i) => i.contentId === "protocols-explainer");
    if (proto) expect(proto.language).toBe("hi");
    const changelog = items.find((i) => i.contentId === "changelog-recap")!;
    expect(changelog.openQuestions).toEqual(expect.arrayContaining(['Verify claim "c-changelog" against its source (no local snapshot was checked)']));
    expect(r.content!.notes).toContain("not predictions");
  });

  it("is reproducible: the same inputs give the same content hash", async () => {
    const a = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    const reimported = await importFixture({}, "main");
    const b = planWeek({ session: reimported, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    expect(planContentHash(a.content!)).toBe(planContentHash(b.content!));
  });

  it("reports a shortfall instead of inventing topics", async () => {
    const small = await importFixture({ onlyCandidates: ["hooks-explained", "subagents-release", "mcp-comparison", "rumor-news", "stale-launch"] }, "small");
    const r = planWeek({ session: small, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    expect(r.content!.items.map((i) => i.contentId).sort()).toEqual(["hooks-explained", "mcp-comparison", "subagents-release"]);
    expect(r.shortfall).toEqual({ target: 7, selected: 3, eligible: 3, message: expect.stringContaining("Only 3 of 7") });
    expect(r.content!.notes).toContain("SHORTFALL");
    const none = await importFixture({ onlyCandidates: ["rumor-news", "stale-launch"] }, "none");
    const empty = planWeek({ session: none, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    expect(empty.content).toBeUndefined();
    expect(empty.notSelected.map((n) => n.candidateId).sort()).toEqual(["cand-rumor-news", "cand-stale-launch"]);
  });

  it("respects weeklyTarget and publishDays", () => {
    const prof = CreatorProfileSchema.parse({ ...p.profile, schedule: { ...p.profile.schedule, weeklyTarget: 3, publishDays: ["fri", "mon", "wed"] } });
    const r = planWeek({ session, profile: prof, config: p.config, weekId: FIXTURE_WEEK });
    expect(r.content!.items.map((i) => i.publishDate)).toEqual(["2026-10-26", "2026-10-28", "2026-10-30"]);
    expect(r.notSelected.filter((n) => n.reason.includes("target of 3 was reached")).length).toBeGreaterThan(0);
  });

  it("a diversity penalty of 0 allows repeated categories; the default spreads them", () => {
    const strict = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    const loose = planWeek({ session, profile: p.profile, config: { ...p.config, research: { ...p.config.research, diversityPenalty: 0 } }, weekId: FIXTURE_WEEK });
    const count = (r: typeof strict) => {
      const n = new Map<string, number>();
      for (const i of r.content!.items) n.set(i.category, (n.get(i.category) ?? 0) + 1);
      return Math.max(...n.values());
    };
    expect(count(strict)).toBeLessThanOrEqual(count(loose));
  });

  it("saves through the existing PlanStore unapproved; identical replans create no new version", async () => {
    const store = new PlanStore(p.paths);
    const r = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK });
    const v1 = await store.addVersion(r.content);
    expect(v1).toMatchObject({ status: "created", version: 1 });
    expect((await store.summary(FIXTURE_WEEK)).versions[0]!.state).toBe("pending");
    await expect(store.approvedPlan(FIXTURE_WEEK)).rejects.toMatchObject({ code: "PLAN_NOT_APPROVED" });
    expect(await store.addVersion(planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content)).toMatchObject({ status: "unchanged", version: 1 });
    expect((await store.summary(FIXTURE_WEEK)).events).toEqual([]);
  });

  it("Stage D plan-item fields are optional without defaults: earlier plan hashes are unchanged", () => {
    const legacy = { weekId: FIXTURE_WEEK, items: [{ contentId: "a-topic", publishDate: "2026-10-26", topic: "A topic", category: "news", platform: "youtube-shorts", language: "en", durationSec: 45 }] };
    const parsed = WeeklyPlanContentSchema.parse(legacy);
    expect(Object.keys(parsed.items[0]!).sort()).toEqual(["category", "contentId", "durationSec", "language", "platform", "publishDate", "qualityRequirements", "requiredAssets", "sourceIds", "topic"]);
    // Pinned value computed with the Stage C schema.
    expect(planContentHash(parsed)).toBe(fingerprint({ weekId: FIXTURE_WEEK, items: [{ ...legacy.items[0], sourceIds: [], requiredAssets: [], qualityRequirements: [] }] }));
  });
});
