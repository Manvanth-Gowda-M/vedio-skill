import { CreatorFlowError, ExitCode } from "@creatorflow/core";
import { LIFECYCLE_STATES, type JobEvent, type JobRecord, type LifecycleState, type VideoState } from "@creatorflow/schemas";

/**
 * Central transition rules. Every state change in CreatorFlow goes through
 * `applyTransition`, which calls `checkTransition`.
 *
 * Kinds:
 * - advance:    lifecycle milestone -> the next milestone (a step verified its outputs)
 * - invalidate: lifecycle milestone -> any EARLIER milestone (an upstream input changed)
 * - block/fail: non-final milestone -> BLOCKED / FAILED (remembers resumeState)
 * - unblock:    BLOCKED -> resumeState or earlier
 * - retry:      FAILED  -> resumeState or earlier (only via an explicit retry rule)
 * Everything else is rejected: skipping milestones, self-transitions,
 * BLOCKED <-> FAILED, and anything out of PACKAGE_READY except invalidation.
 */
export type TransitionKind = "advance" | "invalidate" | "block" | "fail" | "unblock" | "retry";

export const FINAL_STATE: LifecycleState = "PACKAGE_READY";

export function isLifecycle(s: VideoState): s is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(s);
}

export function rank(s: LifecycleState): number {
  return LIFECYCLE_STATES.indexOf(s);
}

export function nextState(s: LifecycleState): LifecycleState | undefined {
  return LIFECYCLE_STATES[rank(s) + 1];
}

export type TransitionCheck = { ok: true; kind: TransitionKind } | { ok: false; reason: string };

export function checkTransition(from: VideoState, to: VideoState, resumeState?: LifecycleState): TransitionCheck {
  if (from === to) return { ok: false, reason: `${from} -> ${to} is not a transition` };

  if (isLifecycle(from) && isLifecycle(to)) {
    if (rank(to) === rank(from) + 1) return { ok: true, kind: "advance" };
    if (rank(to) < rank(from)) return { ok: true, kind: "invalidate" };
    return { ok: false, reason: `${from} -> ${to} skips ${LIFECYCLE_STATES.slice(rank(from) + 1, rank(to)).join(", ")}` };
  }

  if (isLifecycle(from)) {
    if (from === FINAL_STATE) return { ok: false, reason: `${FINAL_STATE} is final; only invalidation may leave it` };
    return { ok: true, kind: to === "BLOCKED" ? "block" : "fail" };
  }

  // from is BLOCKED or FAILED
  if (!isLifecycle(to)) return { ok: false, reason: `${from} -> ${to} is not allowed; resume the job first` };
  if (!resumeState) return { ok: false, reason: `${from} job has no resumeState` };
  if (rank(to) > rank(resumeState)) {
    return { ok: false, reason: `${from} job may only return to ${resumeState} or an earlier milestone, not ${to}` };
  }
  return { ok: true, kind: from === "BLOCKED" ? "unblock" : "retry" };
}

export interface TransitionMeta {
  at: string;
  step?: string;
  reason?: string;
  /** Required when entering BLOCKED. */
  blocked?: { code: string; reason: string };
  /** Required when entering FAILED. */
  failure?: { kind: "permanent" | "retries-exhausted"; code: string; message: string };
}

/** Mutates `job` to the new state and appends a history event. Throws ILLEGAL_TRANSITION. */
export function applyTransition(job: JobRecord, to: VideoState, meta: TransitionMeta): TransitionKind {
  const from = job.state;
  const check = checkTransition(from, to, job.resumeState);
  if (!check.ok) {
    throw new CreatorFlowError(`Illegal transition for ${job.jobId}: ${check.reason}.`, {
      code: "ILLEGAL_TRANSITION",
      hint: "This indicates a bug or a hand-edited job record; inspect the job's history.",
      exitCode: ExitCode.INTERNAL,
      details: { jobId: job.jobId, from, to },
    });
  }
  if (to === "BLOCKED" || to === "FAILED") {
    if (!meta.step) throw new TypeError("step is required when entering BLOCKED/FAILED");
    job.resumeState = from as LifecycleState;
    if (to === "BLOCKED") {
      if (!meta.blocked) throw new TypeError("blocked details are required");
      job.blocked = { step: meta.step, ...meta.blocked, since: meta.at };
    } else {
      if (!meta.failure) throw new TypeError("failure details are required");
      job.failure = { step: meta.step, ...meta.failure, at: meta.at };
    }
  } else {
    delete job.resumeState;
    delete job.blocked;
    delete job.failure;
  }
  job.state = to;
  const event: JobEvent = { at: meta.at, type: "transition", from, to };
  if (meta.step) event.step = meta.step;
  const reason = meta.reason ?? meta.blocked?.reason ?? meta.failure?.message;
  if (reason) event.reason = `${check.kind}: ${reason}`.slice(0, 2000);
  else event.reason = check.kind;
  job.history.push(event);
  return check.kind;
}
