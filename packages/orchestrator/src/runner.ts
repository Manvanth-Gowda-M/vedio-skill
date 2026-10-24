import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLock,
  cleanupStaleTempFiles,
  createLogger,
  CreatorFlowError,
  ExitCode,
  fingerprint,
  isCreatorFlowError,
  isWithin,
  redact,
  resolveWithin,
  sha256File,
  toPosix,
  type Logger,
} from "@creatorflow/core";
import {
  WORKFLOW_SCHEMA_VERSION,
  type AttemptOutcome,
  type CreatorFlowConfig,
  type CreatorProfile,
  type JobRecord,
  type OutputRecord,
  type PlanItem,
  type StepRecord,
} from "@creatorflow/schemas";
import { JobStore } from "./job-store.ts";
import type { OutputSpec, Pipeline, StepContext, StepDefinition } from "./pipeline.ts";
import type { ApprovedPlan } from "./plan-store.ts";
import { applyTransition, isLifecycle, rank } from "./transitions.ts";
import { jobIdFor, type WorkflowPaths } from "./workspace.ts";

export interface RetryPolicy {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  defaultStepTimeoutMs: number;
  stepTimeoutMs: Record<string, number>;
}

/** Attempt outcomes that consume the retry budget. Blocked and cancelled attempts do not. */
export const COUNTED_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set([
  "failed-retryable",
  "failed-permanent",
  "timeout",
  "verification-failed",
  "interrupted",
]);

export interface RunJobOptions {
  paths: WorkflowPaths;
  pipeline: Pipeline;
  plan: ApprovedPlan;
  item: PlanItem;
  profile: CreatorProfile;
  config: CreatorFlowConfig;
  policy?: RetryPolicy;
  /** Grant a fresh retry budget to steps that FAILED (permanent or exhausted). */
  retryFailed?: boolean;
  /** Re-run these steps even if their verified outputs are still valid. */
  forceSteps?: ReadonlySet<string>;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: Logger;
  /** Literal secret values to redact from stored error messages. */
  knownSecrets?: readonly string[];
  /** Stop after this step has been verified or reused (e.g. `render run` stops after "render"). */
  stopAfter?: string;
  lockWaitMs?: number;
  /** After a timeout/cancel, how long to wait for the executor to stop. */
  graceMs?: number;
}

export type JobResult = "completed" | "unchanged" | "blocked" | "failed" | "locked" | "corrupt" | "cancelled";

export interface JobOutcome {
  jobId: string;
  contentId: string;
  result: JobResult;
  state?: JobRecord["state"];
  stepsRun: string[];
  stepsReused: string[];
  /** Attempts started during this run. */
  attempts: number;
  message?: string;
  notes: string[];
}

export function policyFromConfig(config: CreatorFlowConfig): RetryPolicy {
  return { ...config.workflow };
}

export function newStepRecord(): StepRecord {
  return { status: "pending", outputs: [], metadata: {}, attempts: [], budgetStart: 0 };
}

export function createJobRecord(plan: ApprovedPlan, item: PlanItem, at: string): JobRecord {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    kind: "video-job",
    jobId: jobIdFor(plan.weekId, item.contentId),
    contentId: item.contentId,
    weekId: plan.weekId,
    revision: 0,
    createdAt: at,
    updatedAt: at,
    state: "PLANNED",
    currentStep: null,
    lastSuccessfulStep: null,
    planRef: { version: plan.version, planHash: plan.contentHash, itemHash: fingerprint(item) },
    steps: {},
    artifacts: {},
    history: [{ at, type: "created", to: "PLANNED", reason: `from approved plan ${plan.weekId} v${plan.version}` }],
  };
}

// ------------------------------------------------------------------ output verification

async function checkFile(workspaceDir: string, abs: string, rel: string, nonEmpty: boolean): Promise<string | undefined> {
  let st: import("node:fs").Stats;
  try {
    st = await fs.lstat(abs);
  } catch {
    return `output ${rel} is missing`;
  }
  if (st.isSymbolicLink()) return `output ${rel} is a symbolic link, which is not allowed`;
  if (!st.isFile()) return `output ${rel} is not a regular file`;
  if (nonEmpty && st.size === 0) return `output ${rel} is empty`;
  const [real, realWs] = await Promise.all([fs.realpath(abs), fs.realpath(workspaceDir)]);
  if (!isWithin(realWs, real)) return `output ${rel} resolves outside the workspace`;
  return undefined;
}

/**
 * Generic output contract: each declared file exists inside the workspace, is a
 * regular file (not a symlink), is non-empty unless allowed, and gets hashed.
 * This does NOT prove media validity; media checks belong to later stages.
 */
export async function verifyOutputs(
  paths: WorkflowPaths,
  jobId: string,
  specs: readonly OutputSpec[],
): Promise<{ ok: true; records: OutputRecord[] } | { ok: false; problem: string }> {
  const jobDir = paths.jobDir(jobId);
  const records: OutputRecord[] = [];
  for (const spec of specs) {
    const abs = resolveWithin(jobDir, spec.path);
    if (spec.optional && !(await fs.lstat(abs).catch(() => undefined))) continue;
    const problem = await checkFile(paths.workspaceDir, abs, spec.path, spec.nonEmpty ?? true);
    if (problem) return { ok: false, problem };
    const { sha256, bytes } = await sha256File(abs);
    records.push({ path: toPosix(spec.path), sha256, bytes, ...(spec.role ? { role: spec.role } : {}) });
  }
  return { ok: true, records };
}

/** Re-checks previously verified outputs; returns a reason if any changed or vanished. */
export async function verifyRecordedOutputs(paths: WorkflowPaths, jobId: string, records: readonly OutputRecord[]): Promise<string | undefined> {
  if (records.length === 0) return "no verified outputs are recorded";
  const jobDir = paths.jobDir(jobId);
  for (const r of records) {
    const abs = resolveWithin(jobDir, r.path);
    const problem = await checkFile(paths.workspaceDir, abs, r.path, false);
    if (problem) return problem;
    const now = await sha256File(abs);
    if (now.sha256 !== r.sha256) return `output ${r.path} was modified after verification`;
  }
  return undefined;
}

// ------------------------------------------------------------------ execution

type ExecResult =
  | { kind: "succeeded"; metadata: Record<string, string | number | boolean> }
  | { kind: "blocked"; code: string; message: string }
  | { kind: "retryable" | "permanent"; code: string; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "cancelled" };

function classifyError(e: unknown): ExecResult {
  const err = e as { name?: string; kind?: string; code?: unknown; message?: unknown };
  if (err && err.name === "StepError" && (err.kind === "retryable" || err.kind === "permanent")) {
    return { kind: err.kind, code: String(err.code ?? "STEP_ERROR"), message: String(err.message ?? "") };
  }
  return { kind: "retryable", code: "STEP_ERROR", message: e instanceof Error ? e.message : String(e) };
}

async function execute(step: StepDefinition, ctx: Omit<StepContext, "signal">, timeoutMs: number, outer: AbortSignal | undefined, graceMs: number): Promise<ExecResult> {
  if (outer?.aborted) return { kind: "cancelled" };
  const ac = new AbortController();
  let reason: "timeout" | "cancelled" | undefined;
  const onOuter = () => {
    reason ??= "cancelled";
    ac.abort(new Error("cancelled by user"));
  };
  outer?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => {
    reason ??= "timeout";
    ac.abort(new Error(`step timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  const aborted = new Promise<"aborted">((resolve) => ac.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
  const run = Promise.resolve().then(() => step.execute!({ ...ctx, signal: ac.signal }));
  const settled = run.then(
    (v) => ({ v }) as const,
    (e: unknown) => ({ e }) as const,
  );
  try {
    const winner = await Promise.race([settled, aborted]);
    if (winner === "aborted" || reason) {
      // Let a cooperative executor stop (and kill its children) before we move on.
      await Promise.race([settled, delay(graceMs, undefined, { ref: false })]);
      return reason === "timeout" ? { kind: "timeout", message: `step timed out after ${timeoutMs} ms` } : { kind: "cancelled" };
    }
    if ("e" in winner) return classifyError(winner.e);
    const v = winner.v as unknown as { status?: string; code?: unknown; reason?: unknown; metadata?: unknown };
    if (v?.status === "succeeded") {
      const metadata: Record<string, string | number | boolean> = {};
      if (v.metadata && typeof v.metadata === "object") {
        for (const [k, val] of Object.entries(v.metadata)) {
          if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") metadata[k] = val;
        }
      }
      return { kind: "succeeded", metadata };
    }
    if (v?.status === "blocked") return { kind: "blocked", code: String(v.code ?? "BLOCKED"), message: String(v.reason ?? "") };
    return { kind: "retryable", code: "STEP_RESULT_INVALID", message: "executor returned neither succeeded nor blocked" };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

// ------------------------------------------------------------------ job runner

const noopLogger = createLogger({ sinks: [] });

/**
 * Advances one job as far as possible, holding its lock for the whole run.
 * Persists before and after every attempt, so a crash at any point leaves a
 * record whose verified steps are reused and whose open attempt is recovered
 * as "interrupted" on the next run.
 */
export async function runJob(o: RunJobOptions): Promise<JobOutcome> {
  const clock = o.now ?? (() => new Date());
  const now = () => clock().toISOString();
  const policy = o.policy ?? policyFromConfig(o.config);
  const sleep = o.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, signal ? { signal } : {}));
  const jobId = jobIdFor(o.plan.weekId, o.item.contentId);
  const log = (o.logger ?? noopLogger).child({ jobId });
  const secrets = o.knownSecrets ?? [];
  const clean = (s: string) => redact(s, secrets).slice(0, 2000);
  const out: JobOutcome = { jobId, contentId: o.item.contentId, result: "unchanged", stepsRun: [], stepsReused: [], attempts: 0, notes: [] };
  const store = new JobStore(o.paths, clock);

  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(o.paths.jobLock(jobId), { purpose: `resume ${jobId}`, waitMs: o.lockWaitMs ?? 0 });
  } catch (error) {
    if (isCreatorFlowError(error) && (error.code === "LOCK_HELD" || error.code === "LOCK_UNREADABLE")) {
      return { ...out, result: "locked", message: error.message };
    }
    throw error;
  }

  try {
    const removedTemps = await cleanupStaleTempFiles(o.paths.jobDir(jobId));
    if (removedTemps.length) out.notes.push(`removed ${removedTemps.length} temp file(s) left by an interrupted write`);

    let loaded = await store.load(jobId);
    if (loaded.status === "missing") {
      await store.create(createJobRecord(o.plan, o.item, now()));
      loaded = await store.load(jobId);
    }
    if (loaded.status === "corrupt") {
      if (loaded.backup !== "valid") {
        return { ...out, result: "corrupt", message: `job.json is invalid (${loaded.issues[0]?.path}: ${loaded.issues[0]?.message}) and no valid backup exists` };
      }
      const r = await store.recover(jobId);
      out.notes.push(`recovered from job.prev.json; corrupt file kept as ${path.basename(r.quarantined)}`);
      loaded = { status: "ok", job: r.job };
    }
    if (loaded.status !== "ok") throw new Error("unreachable");
    const job = loaded.job;
    const commit = async () => {
      const saved = await store.save(job);
      job.revision = saved.revision;
      job.updatedAt = saved.updatedAt;
    };

    let dirty = false;
    if (lock.recoveredStale) {
      job.history.push({ at: now(), type: "recovered", reason: `removed stale lock of dead process ${lock.recoveredStale.pid} (${lock.recoveredStale.purpose})` });
      out.notes.push(`recovered stale lock from dead pid ${lock.recoveredStale.pid}`);
      dirty = true;
    }
    const itemHash = fingerprint(o.item);
    if (job.planRef.version !== o.plan.version || job.planRef.itemHash !== itemHash || job.planRef.planHash !== o.plan.contentHash) {
      job.history.push({
        at: now(),
        type: "plan-updated",
        reason: `plan v${job.planRef.version} -> v${o.plan.version}; item ${job.planRef.itemHash === itemHash ? "unchanged" : "changed"}`,
      });
      job.planRef = { version: o.plan.version, planHash: o.plan.contentHash, itemHash };
      dirty = true;
    }
    for (const [stepId, rec] of Object.entries(job.steps)) {
      if (rec.status !== "running") continue;
      const open = rec.attempts.at(-1);
      if (open && !open.outcome) {
        open.outcome = "interrupted";
        open.endedAt = now();
        open.error = { code: "INTERRUPTED", message: `process ${open.runner.pid} on ${open.runner.hostname} stopped before the attempt finished` };
      }
      rec.status = "pending";
      job.history.push({ at: now(), type: "interrupted-attempt", step: stepId, reason: `attempt ${open?.n ?? "?"} was interrupted; it counts toward the retry budget` });
      out.notes.push(`${stepId}: attempt ${open?.n ?? "?"} was interrupted`);
      dirty = true;
    }
    if (job.currentStep !== null) {
      job.currentStep = null;
      dirty = true;
    }
    if (dirty) await commit();

    const steps = o.pipeline.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (o.stopAfter && i > 0 && steps[i - 1]!.id === o.stopAfter) break;
      if (o.signal?.aborted) {
        out.result = "cancelled";
        out.state = job.state;
        return out;
      }
      const fctx = { jobId, item: o.item, profile: o.profile, config: o.config };
      const upstream = i === 0 ? [] : (job.steps[steps[i - 1]!.id]?.outputs ?? []);
      const depIds = [...new Set([...(step.dependsOn ?? []), ...(i > 0 ? [steps[i - 1]!.id] : [])])].sort();
      const verified: Record<string, OutputRecord[]> = {};
      for (const d of depIds) verified[d] = job.steps[d]?.outputs ?? [];
      const external = step.externalInputs ? await step.externalInputs({ ...fctx, workspaceDir: o.paths.workspaceDir }) : undefined;
      const inputFp = fingerprint({
        pipeline: o.pipeline.id,
        step: step.id,
        stepVersion: step.version,
        inputs: step.inputs ? step.inputs(fctx) : o.item,
        upstream: upstream.map((u) => ({ path: u.path, sha256: u.sha256 })),
        ...(step.dependsOn?.length ? { dependsOn: Object.fromEntries(depIds.map((d) => [d, verified[d]!.map((u) => ({ path: u.path, sha256: u.sha256 }))])) } : {}),
        ...(external === undefined ? {} : { external }),
      });
      const configFp = fingerprint(step.config ? step.config(fctx) : null);
      const rec = (job.steps[step.id] ??= newStepRecord());

      // 1. Reuse verified work, or invalidate it with an explicit reason.
      if (rec.status === "succeeded") {
        const reasons: string[] = [];
        if (o.forceSteps?.has(step.id)) reasons.push("forced by --force-step");
        if (rec.inputFingerprint !== inputFp) reasons.push("step inputs changed");
        if (rec.configFingerprint !== configFp) reasons.push("relevant configuration changed");
        if (reasons.length === 0) {
          const problem = await verifyRecordedOutputs(o.paths, jobId, rec.outputs);
          if (!problem) {
            out.stepsReused.push(step.id);
            // An upstream step may have re-run and reproduced identical outputs: the job then sits
            // at this step's start state, and reusing this step must advance it.
            if (job.state === step.from) {
              applyTransition(job, step.to, { at: now(), step: step.id, reason: "verified outputs reused (inputs unchanged)" });
              job.lastSuccessfulStep = step.id;
              await commit();
            }
            continue;
          }
          reasons.push(problem);
        }
        invalidateStep(job, steps, i, reasons.join("; "), now());
        log.info("step invalidated", { step: step.id, reason: reasons.join("; ") });
        await commit();
      } else if (isLifecycle(job.state) && rank(job.state) > rank(step.from)) {
        // The record says this step is not verified, so the job cannot be past it.
        invalidateStep(job, steps, i, "step has no verified outputs", now());
        await commit();
      }

      // 2. Failed steps only run again under an explicit retry rule.
      if (rec.status === "failed") {
        const f = rec.failure!;
        const grant = o.retryFailed ? "explicit --retry-failed" : f.inputFingerprint !== inputFp ? "inputs changed since the failure" : undefined;
        if (!grant) {
          if (job.state !== "FAILED") {
            applyTransition(job, "FAILED", { at: now(), step: step.id, failure: { kind: f.kind, code: f.code, message: f.message } });
            await commit();
          }
          out.result = "failed";
          out.state = job.state;
          out.message = `${step.id}: ${f.code}: ${f.message} (${f.kind}; not retried automatically — use --retry-failed)`;
          return out;
        }
        rec.status = "pending";
        rec.budgetStart = rec.attempts.length;
        delete rec.failure;
        job.history.push({ at: now(), type: "retry-granted", step: step.id, reason: grant });
        if (job.state === "FAILED") applyTransition(job, step.from, { at: now(), step: step.id, reason: grant });
        await commit();
      }
      // Still blocked on the same unavailable capability: report it without rewriting the record.
      if (!step.execute && job.state === "BLOCKED" && job.blocked?.step === step.id && job.blocked.code === "EXECUTOR_UNAVAILABLE") {
        out.result = "blocked";
        out.state = job.state;
        out.message = `${step.id}: ${step.unavailableReason}`;
        return out;
      }
      if (job.state === "BLOCKED") applyTransition(job, step.from, { at: now(), step: step.id, reason: "re-checking blocked step" });
      if (rec.status === "blocked") {
        rec.status = "pending";
        delete rec.blocked;
      }
      if (job.state !== step.from) {
        throw new CreatorFlowError(`Job ${jobId} is in ${job.state} but step ${step.id} starts at ${step.from}.`, {
          code: "JOB_STATE_INCONSISTENT",
          hint: "The job record was edited or the pipeline changed incompatibly; inspect its history.",
          exitCode: ExitCode.INTERNAL,
        });
      }

      // 3. Capability not implemented: block honestly instead of pretending.
      if (!step.execute) {
        blockStep(job, step.id, rec, "EXECUTOR_UNAVAILABLE", step.unavailableReason ?? "no executor", now());
        await commit();
        out.result = "blocked";
        out.state = job.state;
        out.message = `${step.id}: ${step.unavailableReason}`;
        return out;
      }

      // 4. Attempts with bounded retries, exponential backoff and timeouts.
      const timeoutMs = policy.stepTimeoutMs[step.id] ?? step.timeoutMs ?? policy.defaultStepTimeoutMs;
      let justFailed = false;
      for (;;) {
        const inBudget = rec.attempts.slice(rec.budgetStart);
        const counted = inBudget.filter((a) => a.outcome && COUNTED_OUTCOMES.has(a.outcome)).length;
        if (counted >= policy.maxAttempts) {
          const last = [...inBudget].reverse().find((a) => a.error);
          failStep(job, step.id, rec, "retries-exhausted", last?.error?.code ?? "RETRIES_EXHAUSTED", `${counted} of ${policy.maxAttempts} attempts used; last error: ${last?.error?.message ?? "unknown"}`, inputFp, now());
          await commit();
          out.result = "failed";
          out.state = job.state;
          out.message = `${step.id}: retries exhausted (${counted}/${policy.maxAttempts})`;
          return out;
        }
        if (justFailed) {
          const wait = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** Math.max(0, counted - 1));
          try {
            await sleep(wait, o.signal);
          } catch {
            out.result = "cancelled";
            out.state = job.state;
            return out;
          }
        }

        const attempt: StepRecord["attempts"][number] = { n: rec.attempts.length + 1, startedAt: now(), runner: { pid: process.pid, hostname: os.hostname() } };
        rec.attempts.push(attempt);
        rec.status = "running";
        job.currentStep = step.id;
        await commit(); // persisted BEFORE executing, so a crash is detectable
        out.attempts++;
        if (!out.stepsRun.includes(step.id)) out.stepsRun.push(step.id);
        log.info("attempt started", { step: step.id, attempt: attempt.n, timeoutMs });

        const t0 = Date.now();
        const jobDir = o.paths.jobDir(jobId);
        const result = await execute(
          step,
          {
            ...fctx,
            stepId: step.id,
            attempt: attempt.n,
            plan: { weekId: o.plan.weekId, version: o.plan.version, contentHash: o.plan.contentHash },
            workspaceDir: o.paths.workspaceDir,
            jobDir,
            outputPath: (rel: string) => resolveWithin(jobDir, rel),
            upstream,
            verified,
            log,
          },
          timeoutMs,
          o.signal,
          o.graceMs ?? 2_000,
        );
        attempt.endedAt = now();
        attempt.durationMs = Date.now() - t0;
        job.currentStep = null;

        if (result.kind === "succeeded") {
          const verified = await verifyOutputs(o.paths, jobId, step.outputs);
          if (!verified.ok) {
            attempt.outcome = "verification-failed";
            attempt.error = { code: "OUTPUT_VERIFICATION_FAILED", message: clean(verified.problem) };
            rec.status = "pending";
            await commit();
            log.warn("output verification failed", { step: step.id, attempt: attempt.n, problem: verified.problem });
            justFailed = true;
            continue;
          }
          attempt.outcome = "succeeded";
          rec.status = "succeeded";
          rec.inputFingerprint = inputFp;
          rec.configFingerprint = configFp;
          rec.outputs = verified.records;
          rec.metadata = Object.fromEntries(Object.entries(result.metadata).map(([k, v]) => [k, typeof v === "string" ? clean(v) : v]));
          rec.completedAt = now();
          job.lastSuccessfulStep = step.id;
          for (const r of verified.records) {
            if (r.role) job.artifacts[r.role as keyof JobRecord["artifacts"]] = toPosix(path.relative(o.paths.workspaceDir, resolveWithin(jobDir, r.path)));
          }
          applyTransition(job, step.to, { at: now(), step: step.id, reason: `${verified.records.length} output(s) verified` });
          await commit();
          log.info("step succeeded", { step: step.id, attempt: attempt.n });
          break;
        }
        if (result.kind === "cancelled") {
          attempt.outcome = "cancelled";
          attempt.error = { code: "CANCELLED", message: "cancelled by user" };
          rec.status = "pending";
          await commit();
          out.result = "cancelled";
          out.state = job.state;
          return out;
        }
        if (result.kind === "blocked") {
          attempt.outcome = "blocked";
          attempt.error = { code: result.code, message: clean(result.message) };
          blockStep(job, step.id, rec, result.code, clean(result.message), now());
          await commit();
          out.result = "blocked";
          out.state = job.state;
          out.message = `${step.id}: ${result.code}: ${clean(result.message)}`;
          return out;
        }
        if (result.kind === "permanent") {
          attempt.outcome = "failed-permanent";
          attempt.error = { code: result.code, message: clean(result.message) };
          failStep(job, step.id, rec, "permanent", result.code, clean(result.message), inputFp, now());
          await commit();
          out.result = "failed";
          out.state = job.state;
          out.message = `${step.id}: ${result.code}: ${clean(result.message)} (permanent; not retried)`;
          return out;
        }
        // retryable or timeout
        attempt.outcome = result.kind === "timeout" ? "timeout" : "failed-retryable";
        attempt.error = result.kind === "timeout" ? { code: "TIMEOUT", message: result.message } : { code: result.code, message: clean(result.message) };
        rec.status = "pending";
        await commit();
        log.warn("attempt failed", { step: step.id, attempt: attempt.n, outcome: attempt.outcome, code: attempt.error.code });
        justFailed = true;
      }
    }
    out.result = out.stepsRun.length > 0 ? "completed" : "unchanged";
    out.state = job.state;
    return out;
  } finally {
    await lock.release();
  }
}

function invalidateStep(job: JobRecord, steps: readonly StepDefinition[], index: number, reason: string, at: string): void {
  const step = steps[index]!;
  const rec = job.steps[step.id]!;
  const wasVerified = rec.status === "succeeded";
  if (wasVerified) {
    rec.status = "pending";
    delete rec.completedAt;
    rec.outputs = [];
    rec.metadata = {};
    rec.budgetStart = rec.attempts.length; // new inputs get a fresh retry budget
    for (const o of step.outputs) if (o.role) delete job.artifacts[o.role];
    job.history.push({ at, type: "invalidated", step: step.id, reason });
  }
  // Regress the job to the milestone this step starts from (never forwards).
  const target = step.from;
  if (isLifecycle(job.state)) {
    if (rank(job.state) > rank(target)) applyTransition(job, target, { at, step: step.id, reason });
  } else if (job.resumeState && rank(job.resumeState) >= rank(target)) {
    applyTransition(job, target, { at, step: step.id, reason });
  }
  const prev = index > 0 ? steps[index - 1]!.id : null;
  const lastIdx = job.lastSuccessfulStep ? steps.findIndex((s) => s.id === job.lastSuccessfulStep) : -1;
  if (lastIdx >= index) job.lastSuccessfulStep = prev;
}

function blockStep(job: JobRecord, stepId: string, rec: StepRecord, code: string, reason: string, at: string): void {
  rec.status = "blocked";
  rec.blocked = { code, reason, at };
  applyTransition(job, "BLOCKED", { at, step: stepId, blocked: { code, reason } });
}

function failStep(job: JobRecord, stepId: string, rec: StepRecord, kind: "permanent" | "retries-exhausted", code: string, message: string, inputFp: string, at: string): void {
  rec.status = "failed";
  rec.failure = { kind, code, message: message.slice(0, 2000), at, inputFingerprint: inputFp };
  applyTransition(job, "FAILED", { at, step: stepId, failure: { kind, code, message: message.slice(0, 2000) } });
}
