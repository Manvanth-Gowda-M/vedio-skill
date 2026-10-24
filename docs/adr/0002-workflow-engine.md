# ADR 0002 — Persistent workflow engine

Status: accepted (Stage C) · Date: 2026-10-22

## Decision

File-backed state under the configured workspace, no database. Code lives in `packages/orchestrator`; schemas in `packages/schemas/src/workflow.ts` (JSON Schemas generated into `packages/schemas/json/`).

```
workspace/
  plans/<week>/index.json        version list + append-only approval events (revisioned)
  plans/<week>/v0001.json ...    immutable plan versions with content hash
  plans/<week>/plan.lock
  jobs/<jobId>/job.json          job record (schema-validated, revisioned)
  jobs/<jobId>/job.prev.json     previous valid record (recovery source)
  jobs/<jobId>/job.lock
  jobs/<jobId>/<step>/...        step outputs
  logs/workflow.jsonl            structured, redacted log
```

Rationale: one creator, at most a few concurrent CLI invocations, seven-ish jobs a week. Plain JSON stays inspectable and diffable, and needs no extra dependency. Revisit if multiple machines must share one workspace concurrently (see limits).

## State machine

States and rules are defined once in `transitions.ts` (`checkTransition`, `applyTransition`); every change goes through them and is appended to the job's `history`.

| Kind | Rule |
|---|---|
| advance | milestone → the next milestone, only after the step's outputs are verified |
| invalidate | milestone → any earlier milestone, when an input of that step changed |
| block / fail | any milestone except `PACKAGE_READY` → `BLOCKED` / `FAILED`; `resumeState` is recorded |
| unblock / retry | `BLOCKED` / `FAILED` → `resumeState` or earlier |

Rejected: self-transitions, skipping milestones, `BLOCKED ↔ FAILED`, leaving `PACKAGE_READY` except by invalidation. Illegal attempts throw `ILLEGAL_TRANSITION` and leave the record unchanged. The job schema enforces the invariants (`blocked` present iff `BLOCKED`, `failure` iff `FAILED`, `resumeState` only in those states), so an inconsistent record can never be written.

Pipelines (`definePipeline`) must form a contiguous chain of advance transitions from `PLANNED`, and every step must declare at least one output: a step with nothing to verify cannot succeed. A step without an executor makes the job `BLOCKED: EXECUTOR_UNAVAILABLE`; the production pipeline is entirely in that state until Stages D–I attach executors.

## Failure and retry rules

| Attempt outcome | Counts toward budget | Next |
|---|---|---|
| succeeded (outputs verified) | – | advance |
| failed-retryable, timeout, verification-failed | yes | retry after backoff `min(max, base·2^(n-1))` while budget remains, else `FAILED (retries-exhausted)` |
| failed-permanent (`StepError` kind `permanent`) | yes | `FAILED (permanent)` immediately |
| interrupted (process died mid-attempt) | yes | detected on the next run; retried if budget remains |
| blocked | no | `BLOCKED`; re-checked on every resume |
| cancelled (SIGINT) | no | step returns to pending; exit 130 |

A `FAILED` step runs again only if its input fingerprint changed since the failure, or with `resume --retry-failed`. Either way it gets a fresh budget, and a `retry-granted` event records why. Unclassified executor errors are treated as retryable, so they are always bounded by the budget. Defaults: `maxAttempts 3`, backoff 2 s–60 s, step timeout 30 min, per-step overrides in `config.workflow`. Timeouts abort the step's `AbortSignal`; executors pass it to `runCommand`, which kills child processes. After an abort the runner waits up to a grace period (2 s) for the executor to stop.

## Persistence and recovery

- Writes: validate → compare-and-swap on `revision` against the file on disk → copy the current file to `job.prev.json` → atomic temp+fsync+rename. A stale writer gets `JOB_REVISION_CONFLICT` (exit 5) and cannot overwrite newer state.
- New files that must never be replaced (plan versions, new jobs, locks) use `writeFileExclusive` (temp file plus hard link; the link fails if the target exists).
- The attempt is persisted as `running` **before** the executor starts. A crash therefore always leaves a detectable open attempt, which the next run closes as `interrupted`.
- A corrupt `job.json` is never overwritten. `status` reports it (exit 1). `resume` moves it to `job.json.corrupt-<timestamp>` and restores `job.prev.json` only if that copy validates, and records a `recovered` event. Without a valid backup the job is reported as `corrupt` and skipped. Restoring the backup can lose at most the last transition; outputs are re-verified by hash, so this can only cause a re-run, never a false success.
- Temp files from interrupted writes are removed only when the PID in their name is no longer alive.
- Plan version files are adopted into the index if a crash happened between writing the version and updating the index. Version numbers already on disk are never reused.

## Fingerprints and invalidation

`fingerprint()` is versioned (`cf-fp-v1`): sha256 over canonical JSON (sorted keys, no whitespace, `undefined` dropped; non-JSON values rejected). Each step stores:

- `inputFingerprint` = pipeline id, step id, step `version`, the step's declared inputs (default: the plan item), and the path+hash of every upstream output.
- `configFingerprint` = only the profile/config subset the step declares.

On resume, a succeeded step is reused only if both fingerprints match **and** every recorded output still exists with the same sha256. Otherwise the step is invalidated with a stated reason and the job regresses to that step's start state. Because downstream fingerprints include upstream output hashes, a re-run that produces byte-identical output leaves downstream steps reusable, and a changed output invalidates exactly the dependent steps. Timestamps, plan version numbers, plan notes, log order and attempt metadata are never fingerprint inputs. Bump a step's `version` when its executor logic changes; bump `FINGERPRINT_VERSION` if canonicalisation changes, which deliberately invalidates everything.

Job IDs are `<week>-<contentId>` (e.g. `2026-w44-claude-code-hooks`), derived only from the persisted plan, so they are identical across restarts and independent of item order.

## Plans and approvals

- `plan add` validates the content, normalises it (defaults applied, `$schema` dropped), hashes it, and writes the next immutable version. Identical content returns `unchanged`, unless the latest version was rejected, in which case it becomes a fresh proposal.
- The **effective** version is the newest one that is not rejected. Production (`resume`) requires that version to be approved and to pass its integrity check (file hash equals the stored hash).
- `approve-plan` requires the exact version and its hash (full, or a prefix of at least 12 hex characters). It refuses to approve a superseded version, and refuses to approve or produce from a version whose file was edited after hashing (`PLAN_INTEGRITY`). Events (`approved` / `rejected`, who, when, hash, note) are appended, never rewritten.
- Approval never authorises publishing; publishing remains `manual-only` in the profile schema.

## Locking

- One lock per job (held for that job's whole resume run) and one per week's plans (held for each write). This lets different jobs run in parallel processes while the same job is protected.
- A lock is broken only when it was created on this host **and** its owner PID is no longer alive. Age is never a criterion. Locks from other hosts and unreadable lock files are reported (`LOCK_HELD` / `LOCK_UNREADABLE`, exit 5) and left alone.
- Breaking a lock renames it to a unique tombstone, re-reads it and deletes it only if it is the same lock (token match). If a fresh lock was displaced, it is restored with a no-replace link.
- `resume` on a locked job reports it as `locked` (exit 5) and does not wait. Plan writes wait up to 10 s.

### Limits

- PID reuse: if the OS reassigns a dead owner's PID to an unrelated process, the lock is treated as held (fails safe); delete the lock file manually after checking.
- Locks are advisory; tools other than CreatorFlow, or a user editing files, are not blocked. Hand edits are caught by schema validation, revision checks and hashes.
- Shared network drives across hosts are not supported for concurrent use: a remote owner's liveness cannot be checked, so its stale locks need manual removal.
- Hard links are required for the strongest no-overwrite guarantee. On filesystems without them, an exclusive-open fallback is used, which may leave a partial file after a crash; it is detected as invalid on load.
- An executor that ignores its `AbortSignal` may keep running in-process after a timeout; the runner stops waiting after the grace period and records the timeout.

## Verification scope

The generic output contract proves files exist, are regular, non-empty, inside the workspace, and unchanged since verification. It does **not** prove that a file is valid media or content; media and editorial checks belong to Stages F and H.
