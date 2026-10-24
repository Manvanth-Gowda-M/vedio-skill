import { promises as fs } from "node:fs";
import {
  CreatorFlowError,
  ExitCode,
  fingerprint,
  stringifyJson,
  withLock,
  writeFileAtomic,
  writeFileExclusive,
  type LockOptions,
} from "@creatorflow/core";
import {
  PlanIndexSchema,
  PlanVersionSchema,
  WeeklyPlanContentSchema,
  WORKFLOW_SCHEMA_VERSION,
  validateArtifact,
  type PlanEvent,
  type PlanIndex,
  type PlanVersion,
  type ValidationIssue,
  type WeeklyPlanContent,
} from "@creatorflow/schemas";
import { assertWeekId, type WorkflowPaths } from "./workspace.ts";

export type VersionState = "approved" | "rejected" | "pending" | "superseded" | "invalid";

export interface VersionSummary {
  version: number;
  contentHash: string;
  createdAt: string;
  itemCount: number;
  state: VersionState;
  /** Why the version is invalid (file missing, malformed, or content changed after hashing). */
  integrityIssue?: string;
  lastDecision?: PlanEvent;
}

export interface PlanSummary {
  weekId: string;
  versions: VersionSummary[];
  /** Highest version that has not been rejected: the one production must follow. */
  effectiveVersion?: number;
  /** Set only when the effective version is approved and its content verifies. */
  approvedVersion?: number;
  /** Version files present on disk but missing from the index (interrupted write). */
  unindexedFiles: string[];
  events: PlanEvent[];
}

export interface ApprovedPlan {
  weekId: string;
  version: number;
  contentHash: string;
  content: WeeklyPlanContent;
}

/** Hash of normalised plan content (defaults applied, $schema removed). */
export function planContentHash(content: WeeklyPlanContent): string {
  const { $schema: _ignored, ...rest } = content;
  return fingerprint(rest);
}

function normalise(content: WeeklyPlanContent): WeeklyPlanContent {
  const { $schema: _ignored, ...rest } = content;
  return rest;
}

const VERSION_FILE_RE = /^v(\d{4,})\.json$/;

/**
 * Weekly plans: workspace/plans/<week>/vNNNN.json (immutable, created with a
 * no-overwrite write) plus index.json (version list + append-only approval
 * events). All writes happen under plans/<week>/plan.lock.
 *
 * Approval rules:
 * - An approval names an exact version AND its content hash; a mismatch is rejected.
 * - Only the effective version (newest not-rejected) can be approved, so a
 *   newer edit always needs its own approval; approval is never carried forward.
 * - A version whose file no longer matches its hash is "invalid" and cannot
 *   be approved or produced. Approving never authorises publishing.
 */
export class PlanStore {
  readonly paths: WorkflowPaths;
  readonly now: () => Date;
  readonly lockOptions: Omit<LockOptions, "purpose">;

  constructor(paths: WorkflowPaths, options: { now?: () => Date; lock?: Omit<LockOptions, "purpose"> } = {}) {
    this.paths = paths;
    this.now = options.now ?? (() => new Date());
    this.lockOptions = { waitMs: 10_000, pollMs: 50, ...options.lock };
  }

  async weeks(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.paths.plansDir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names) {
      try {
        assertWeekId(n);
        if ((await fs.stat(this.paths.planIndex(n)).catch(() => undefined))?.isFile()) out.push(n);
      } catch {
        // not a week directory
      }
    }
    return out.sort();
  }

  async latestWeek(): Promise<string | undefined> {
    return (await this.weeks()).at(-1);
  }

  /** Validates plan content without storing it. */
  validateContent(data: unknown): { ok: true; content: WeeklyPlanContent } | { ok: false; issues: ValidationIssue[] } {
    const v = validateArtifact(WeeklyPlanContentSchema, data);
    return v.ok ? { ok: true, content: normalise(v.value) } : { ok: false, issues: v.issues };
  }

  async loadIndex(weekId: string): Promise<PlanIndex | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.planIndex(weekId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw this.indexCorrupt(weekId, [{ path: "(file)", message: (error as Error).message }]);
    }
    const v = validateArtifact(PlanIndexSchema, data);
    if (!v.ok || v.value.weekId !== weekId) throw this.indexCorrupt(weekId, v.ok ? [{ path: "weekId", message: "mismatch" }] : v.issues);
    return v.value;
  }

  /** Loads a version file and re-verifies its content hash. */
  async loadVersion(weekId: string, version: number): Promise<{ ok: true; plan: PlanVersion } | { ok: false; issue: string }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.planVersion(weekId, version), "utf8");
    } catch {
      return { ok: false, issue: "version file is missing" };
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, issue: "version file is not valid JSON" };
    }
    const v = validateArtifact(PlanVersionSchema, data);
    if (!v.ok) return { ok: false, issue: `version file is invalid (${v.issues[0]?.path}: ${v.issues[0]?.message})` };
    if (v.value.weekId !== weekId || v.value.version !== version) return { ok: false, issue: "version file week/version does not match its location" };
    if (v.value.content.weekId !== weekId) return { ok: false, issue: "plan content weekId does not match" };
    const actual = planContentHash(v.value.content);
    if (actual !== v.value.contentHash) return { ok: false, issue: `content was modified after it was hashed (now ${actual.slice(0, 19)}…)` };
    return { ok: true, plan: v.value };
  }

  /** Stores content as the next version unless it is identical to the latest version. */
  async addVersion(data: unknown): Promise<{ status: "created" | "unchanged"; weekId: string; version: number; contentHash: string }> {
    const parsed = this.validateContent(data);
    if (!parsed.ok) {
      throw new CreatorFlowError("Plan content is invalid; no version was created.", {
        code: "PLAN_INVALID",
        exitCode: ExitCode.CHECK_FAILED,
        details: parsed.issues,
      });
    }
    const content = parsed.content;
    const weekId = content.weekId;
    const contentHash = planContentHash(content);
    await fs.mkdir(this.paths.weekDir(weekId), { recursive: true });

    return withLock(this.paths.planLock(weekId), { ...this.lockOptions, purpose: `plan add ${weekId}` }, async () => {
      const index = (await this.loadIndex(weekId)) ?? this.emptyIndex(weekId);
      const before = index.revision;
      const taken = await this.adoptUnindexed(index);
      const latest = index.versions.at(-1);
      const latestRejected = latest ? [...index.events].reverse().find((e) => e.version === latest.version)?.type === "rejected" : false;
      // Re-submitting rejected content creates a new version (a fresh proposal) instead of reviving the rejection.
      if (latest && !latestRejected && latest.contentHash === contentHash && (await this.loadVersion(weekId, latest.version)).ok) {
        if (index.revision !== before) await this.writeIndex(index);
        return { status: "unchanged" as const, weekId, version: latest.version, contentHash };
      }
      const version = Math.max(0, ...index.versions.map((v) => v.version), ...taken) + 1;
      const file: PlanVersion = {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        kind: "weekly-plan-version",
        weekId,
        version,
        createdAt: this.now().toISOString(),
        contentHash,
        content,
      };
      if (!(await writeFileExclusive(this.paths.planVersion(weekId, version), stringifyJson(file)))) {
        throw new CreatorFlowError(`Plan version ${version} already exists on disk.`, { code: "PLAN_VERSION_EXISTS", exitCode: ExitCode.CONFLICT });
      }
      index.versions.push({ version, contentHash, createdAt: file.createdAt, itemCount: content.items.length });
      index.revision++;
      await this.writeIndex(index);
      return { status: "created" as const, weekId, version, contentHash };
    });
  }

  /** Records an approval or rejection for an exact version + hash. */
  async decide(input: {
    weekId: string;
    version: number;
    hash: string;
    decision: "approved" | "rejected";
    by: string;
    note?: string;
  }): Promise<{ status: "recorded" | "already"; event: PlanEvent; summary: PlanSummary }> {
    const { weekId, version } = input;
    assertWeekId(weekId);
    const result = await withLock(this.paths.planLock(weekId), { ...this.lockOptions, purpose: `approve-plan ${weekId}` }, async () => {
      const index = await this.loadIndex(weekId);
      if (!index) throw this.notFound(`No plans exist for ${weekId}.`);
      const before = index.revision;
      await this.adoptUnindexed(index);
      const entry = index.versions.find((v) => v.version === version);
      if (!entry) throw this.notFound(`Plan ${weekId} has no version ${version} (versions: ${index.versions.map((v) => v.version).join(", ") || "none"}).`);
      const loaded = await this.loadVersion(weekId, version);
      if (!loaded.ok || loaded.plan.contentHash !== entry.contentHash) {
        throw new CreatorFlowError(`Plan ${weekId} v${version} failed its integrity check: ${loaded.ok ? "hash differs from index" : loaded.issue}.`, {
          code: "PLAN_INTEGRITY",
          hint: "Do not edit version files. Save edited content with `creatorflow plan add` to create a new version.",
          exitCode: ExitCode.CHECK_FAILED,
        });
      }
      if (!hashMatches(input.hash, entry.contentHash)) {
        throw new CreatorFlowError(`Hash ${input.hash} does not match ${weekId} v${version} (${entry.contentHash}).`, {
          code: "PLAN_HASH_MISMATCH",
          hint: "Run `creatorflow status` and review the exact version before approving.",
          exitCode: ExitCode.CONFLICT,
        });
      }
      const pre = summarise(index, await this.integrity(index));
      if (input.decision === "approved" && pre.effectiveVersion !== version) {
        throw new CreatorFlowError(`v${version} is not the current plan version (v${pre.effectiveVersion}); approving it would ignore later edits.`, {
          code: "PLAN_VERSION_SUPERSEDED",
          hint: `Approve v${pre.effectiveVersion}, or reject the newer versions first.`,
          exitCode: ExitCode.CONFLICT,
        });
      }
      const last = [...index.events].reverse().find((e) => e.version === version);
      if (last?.type === input.decision) {
        if (index.revision !== before) await this.writeIndex(index);
        return { status: "already" as const, event: last };
      }
      const event: PlanEvent = {
        type: input.decision,
        version,
        contentHash: entry.contentHash,
        at: this.now().toISOString(),
        by: input.by,
        ...(input.note ? { note: input.note } : {}),
      };
      index.events.push(event);
      index.revision++;
      await this.writeIndex(index);
      return { status: "recorded" as const, event };
    });
    return { ...result, summary: await this.summary(weekId) };
  }

  async summary(weekId: string): Promise<PlanSummary> {
    const index = await this.loadIndex(weekId);
    if (!index) throw this.notFound(`No plans exist for ${weekId}.`);
    const s = summarise(index, await this.integrity(index));
    const indexed = new Set(index.versions.map((v) => v.version));
    const files = await fs.readdir(this.paths.weekDir(weekId)).catch(() => [] as string[]);
    s.unindexedFiles = files.filter((f) => {
      const m = VERSION_FILE_RE.exec(f);
      return m && !indexed.has(Number(m[1]));
    });
    return s;
  }

  /** The approved, integrity-checked plan production must follow. */
  async approvedPlan(weekId: string): Promise<ApprovedPlan> {
    const s = await this.summary(weekId);
    const effective = s.versions.find((v) => v.version === s.effectiveVersion);
    if (!effective) {
      throw new CreatorFlowError(`Plan ${weekId} has no version awaiting production (all versions rejected).`, {
        code: "PLAN_NOT_APPROVED",
        hint: "Add a new version with `creatorflow plan add` and approve it.",
        exitCode: ExitCode.CHECK_FAILED,
      });
    }
    if (effective.state === "invalid") {
      throw new CreatorFlowError(`Plan ${weekId} v${effective.version} failed its integrity check: ${effective.integrityIssue}.`, {
        code: "PLAN_INTEGRITY",
        hint: "Restore the original file or save the edited content as a new version with `creatorflow plan add`.",
        exitCode: ExitCode.CHECK_FAILED,
      });
    }
    if (s.approvedVersion !== effective.version) {
      throw new CreatorFlowError(`Plan ${weekId} v${effective.version} is not approved.`, {
        code: "PLAN_NOT_APPROVED",
        hint: `Review it, then run \`creatorflow approve-plan --week ${weekId} --plan-version ${effective.version} --hash ${effective.contentHash}\`.`,
        exitCode: ExitCode.CHECK_FAILED,
      });
    }
    const loaded = await this.loadVersion(weekId, effective.version);
    if (!loaded.ok) throw new Error("integrity changed during load");
    return { weekId, version: effective.version, contentHash: effective.contentHash, content: loaded.plan.content };
  }

  // ------------------------------------------------------------------ internals

  private emptyIndex(weekId: string): PlanIndex {
    return { schemaVersion: WORKFLOW_SCHEMA_VERSION, kind: "weekly-plan-index", weekId, revision: 0, versions: [], events: [] };
  }

  private async writeIndex(index: PlanIndex): Promise<void> {
    const v = validateArtifact(PlanIndexSchema, index);
    if (!v.ok) throw new CreatorFlowError("Refusing to write an invalid plan index.", { code: "PLAN_INDEX_INVALID", exitCode: ExitCode.INTERNAL, details: v.issues });
    await writeFileAtomic(this.paths.planIndex(index.weekId), stringifyJson(v.value));
  }

  /**
   * Adopts valid version files that were written but not indexed (crash between
   * the two writes). Returns every version number present on disk so numbers
   * of unreadable files are never reused. Caller holds the plan lock.
   */
  private async adoptUnindexed(index: PlanIndex): Promise<number[]> {
    const files = await fs.readdir(this.paths.weekDir(index.weekId)).catch(() => [] as string[]);
    const onDisk: number[] = [];
    for (const f of files) {
      const m = VERSION_FILE_RE.exec(f);
      if (m) onDisk.push(Number(m[1]));
    }
    const indexed = new Set(index.versions.map((v) => v.version));
    for (const n of onDisk.sort((a, b) => a - b)) {
      if (indexed.has(n) || n < Math.max(0, ...index.versions.map((v) => v.version))) continue;
      const loaded = await this.loadVersion(index.weekId, n);
      if (!loaded.ok) continue;
      index.versions.push({
        version: n,
        contentHash: loaded.plan.contentHash,
        createdAt: loaded.plan.createdAt,
        itemCount: loaded.plan.content.items.length,
        recovered: true,
      });
      index.revision++;
    }
    return onDisk;
  }

  private async integrity(index: PlanIndex): Promise<Map<number, string | undefined>> {
    const out = new Map<number, string | undefined>();
    for (const v of index.versions) {
      const loaded = await this.loadVersion(index.weekId, v.version);
      out.set(v.version, loaded.ok ? (loaded.plan.contentHash === v.contentHash ? undefined : "file hash differs from index") : loaded.issue);
    }
    return out;
  }

  private notFound(message: string): CreatorFlowError {
    return new CreatorFlowError(message, { code: "PLAN_NOT_FOUND", hint: "Create one with `creatorflow plan add --file <plan.json>`.", exitCode: ExitCode.NOT_FOUND });
  }

  private indexCorrupt(weekId: string, issues: ValidationIssue[]): CreatorFlowError {
    return new CreatorFlowError(`Plan index for ${weekId} is corrupt.`, {
      code: "PLAN_INDEX_CORRUPT",
      hint: `Inspect ${this.paths.planIndex(weekId)}. Version files are intact and can be re-added with \`creatorflow plan add\`.`,
      exitCode: ExitCode.CHECK_FAILED,
      details: issues,
    });
  }
}

/** Accepts "sha256:<hex>" or bare hex; full hash or a prefix of at least 12 hex characters. */
export function hashMatches(given: string, actual: string): boolean {
  const g = given.trim().toLowerCase().replace(/^sha256:/, "");
  const a = actual.replace(/^sha256:/, "");
  return /^[0-9a-f]{12,64}$/.test(g) && a.startsWith(g);
}

export function summarise(index: PlanIndex, integrity: Map<number, string | undefined>): PlanSummary {
  const lastDecision = new Map<number, PlanEvent>();
  for (const e of index.events) lastDecision.set(e.version, e);
  const notRejected = index.versions.filter((v) => lastDecision.get(v.version)?.type !== "rejected");
  const effectiveVersion = notRejected.at(-1)?.version;

  const versions: VersionSummary[] = index.versions.map((v) => {
    const issue = integrity.get(v.version);
    const decision = lastDecision.get(v.version);
    const approvedForThisContent = decision?.type === "approved" && decision.contentHash === v.contentHash;
    let state: VersionState;
    if (issue) state = "invalid";
    else if (decision?.type === "rejected") state = "rejected";
    else if (v.version !== effectiveVersion) state = "superseded";
    else state = approvedForThisContent ? "approved" : "pending";
    return {
      version: v.version,
      contentHash: v.contentHash,
      createdAt: v.createdAt,
      itemCount: v.itemCount,
      state,
      ...(issue ? { integrityIssue: issue } : {}),
      ...(decision ? { lastDecision: decision } : {}),
    };
  });
  const approved = versions.find((v) => v.state === "approved");
  return {
    weekId: index.weekId,
    versions,
    ...(effectiveVersion !== undefined ? { effectiveVersion } : {}),
    ...(approved ? { approvedVersion: approved.version } : {}),
    unindexedFiles: [],
    events: index.events,
  };
}
