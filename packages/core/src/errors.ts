/**
 * Process exit codes used by every CreatorFlow command.
 * Kept as a frozen object (not a TS enum) so sources stay erasable-syntax only.
 */
export const ExitCode = Object.freeze({
  OK: 0,
  /** A check or validation ran and found problems. */
  CHECK_FAILED: 1,
  /** Invalid CLI usage or missing required input. */
  USAGE: 2,
  /** Configuration or profile file missing or invalid. */
  CONFIG: 3,
  /** Filesystem or path-safety violation. */
  IO: 4,
  /** Concurrency conflict: lock held, stale revision, or plan hash mismatch. */
  CONFLICT: 5,
  /** A referenced plan, plan version or job does not exist. */
  NOT_FOUND: 6,
  /** Unexpected internal error (bug). */
  INTERNAL: 70,
  /** Interrupted by the user (SIGINT); completed work is preserved. */
  INTERRUPTED: 130,
});
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface CreatorFlowErrorOptions {
  /** Stable machine-readable code, e.g. "PROFILE_INVALID". */
  code: string;
  /** Short actionable remediation shown to the user. */
  hint?: string;
  exitCode?: ExitCodeValue;
  details?: unknown;
  cause?: unknown;
}

/** Base error carrying a stable code, remediation hint and exit code. */
export class CreatorFlowError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: ExitCodeValue;
  readonly details: unknown;

  constructor(message: string, options: CreatorFlowErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CreatorFlowError";
    this.code = options.code;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? ExitCode.INTERNAL;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isCreatorFlowError(value: unknown): value is CreatorFlowError {
  return value instanceof CreatorFlowError;
}
