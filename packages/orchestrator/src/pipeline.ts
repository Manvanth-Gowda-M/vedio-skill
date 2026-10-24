import path from "node:path";
import { CreatorFlowError, ExitCode, resolveWithin, type Logger } from "@creatorflow/core";
import {
  RelativePath,
  StepId,
  type ArtifactRole,
  type CreatorFlowConfig,
  type CreatorProfile,
  type LifecycleState,
  type OutputRecord,
  type PlanItem,
} from "@creatorflow/schemas";
import { checkTransition } from "./transitions.ts";

export interface OutputSpec {
  /** Path relative to the job directory, e.g. "research/sources.json". */
  path: string;
  role?: ArtifactRole;
  /** Default true: a zero-byte file fails verification. */
  nonEmpty?: boolean;
  /**
   * Default false. An optional output may be absent (e.g. narration audio for a
   * silent job). When present it is verified and recorded like any other, so a
   * later deletion or edit still invalidates the step.
   */
  optional?: boolean;
}

/** Pure inputs used for fingerprinting. Must not include timestamps or other nondeterministic data. */
export interface FingerprintContext {
  jobId: string;
  item: PlanItem;
  profile: CreatorProfile;
  config: CreatorFlowConfig;
}

export interface StepContext extends FingerprintContext {
  stepId: string;
  attempt: number;
  /** Approved plan the job is running under. Not part of any fingerprint. */
  plan: { weekId: string; version: number; contentHash: string };
  workspaceDir: string;
  jobDir: string;
  /** Aborted on timeout or user cancellation. Pass it to runCommand / timers. */
  signal: AbortSignal;
  /** Absolute path for a declared output (validated to stay in the job directory). */
  outputPath(relative: string): string;
  /** Verified outputs of the previous step. */
  upstream: readonly OutputRecord[];
  /** Verified outputs of every step in `dependsOn` (plus the previous step), by step id. */
  verified: Readonly<Record<string, readonly OutputRecord[]>>;
  log: Logger;
}

export type StepResult =
  | { status: "succeeded"; metadata?: Record<string, string | number | boolean> }
  /** Waiting for something outside CreatorFlow (user sources, a capability). Does not consume retries. */
  | { status: "blocked"; code: string; reason: string };

/** Throw from an executor to classify a failure. Unclassified errors are treated as retryable. */
export class StepError extends Error {
  readonly kind: "retryable" | "permanent";
  readonly code: string;
  constructor(message: string, options: { kind: "retryable" | "permanent"; code: string }) {
    super(message);
    this.name = "StepError";
    this.kind = options.kind;
    this.code = options.code;
  }
}

export interface StepDefinition {
  id: string;
  /** Bump when executor logic changes so previously verified outputs are invalidated. */
  version: number;
  from: LifecycleState;
  to: LifecycleState;
  outputs: readonly OutputSpec[];
  timeoutMs?: number;
  /**
   * Earlier steps whose verified outputs this step reads. Their output hashes
   * are part of the input fingerprint (the previous step is always included),
   * so a change anywhere in that set invalidates this step.
   */
  dependsOn?: readonly string[];
  /** Canonical step inputs (default: the plan item). */
  inputs?(ctx: FingerprintContext): unknown;
  /** Relevant configuration/profile subset (default: none). */
  config?(ctx: FingerprintContext): unknown;
  /**
   * Inputs that live in files outside the job (e.g. imported translations).
   * Must return deterministic, JSON-compatible data such as file hashes; it is
   * folded into the input fingerprint, so a changed file invalidates the step.
   */
  externalInputs?(ctx: FingerprintContext & { workspaceDir: string }): Promise<unknown>;
  /** Absent when the capability is not implemented: the job becomes BLOCKED, never "succeeded". */
  execute?(ctx: StepContext): Promise<StepResult>;
  unavailableReason?: string;
}

export interface Pipeline {
  id: string;
  steps: readonly StepDefinition[];
}

function invalid(message: string): CreatorFlowError {
  return new CreatorFlowError(`Invalid pipeline: ${message}`, { code: "PIPELINE_INVALID", exitCode: ExitCode.INTERNAL });
}

/**
 * Validates a pipeline against the central transition rules: steps form a
 * contiguous chain of `advance` transitions starting at PLANNED, every step
 * declares at least one verifiable output, and output paths stay inside the
 * job directory.
 */
export function definePipeline(id: string, steps: readonly StepDefinition[]): Pipeline {
  if (!StepId.safeParse(id).success) throw invalid(`id "${id}" is not a slug`);
  if (steps.length === 0) throw invalid("no steps");
  const ids = new Set<string>();
  const outputs = new Set<string>();
  steps.forEach((step, i) => {
    if (!StepId.safeParse(step.id).success) throw invalid(`step id "${step.id}" is not a slug`);
    if (ids.has(step.id)) throw invalid(`duplicate step id "${step.id}"`);
    ids.add(step.id);
    const expectedFrom = i === 0 ? "PLANNED" : steps[i - 1]!.to;
    if (step.from !== expectedFrom) throw invalid(`step "${step.id}" must start at ${expectedFrom}, not ${step.from}`);
    const t = checkTransition(step.from, step.to);
    if (!t.ok || t.kind !== "advance") throw invalid(`step "${step.id}": ${step.from} -> ${step.to} is not an advance transition`);
    if (!Number.isInteger(step.version) || step.version < 1) throw invalid(`step "${step.id}" needs an integer version >= 1`);
    if (step.outputs.length === 0) throw invalid(`step "${step.id}" declares no outputs, so success could not be verified`);
    for (const o of step.outputs) {
      if (!RelativePath.safeParse(o.path).success) throw invalid(`step "${step.id}" output "${o.path}" must be relative without ".."`);
      resolveWithin(path.resolve("/job"), o.path);
      const key = o.path.replace(/\\/g, "/");
      if (outputs.has(key)) throw invalid(`output "${o.path}" is declared twice`);
      outputs.add(key);
    }
    if (!step.execute && !step.unavailableReason) throw invalid(`step "${step.id}" has no executor and no unavailableReason`);
    for (const dep of step.dependsOn ?? []) {
      if (!steps.slice(0, i).some((s) => s.id === dep)) throw invalid(`step "${step.id}" depends on "${dep}", which is not an earlier step`);
    }
  });
  return { id, steps };
}
