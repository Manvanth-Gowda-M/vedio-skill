// Deterministic fixture pipeline for tests. Behaviour is injected through
// <workspace>/fixture-control.json; every invocation is appended to
// <workspace>/fixture-exec.jsonl so tests can prove what did (not) run.
// This file is test-only and is never loaded by the production CLI.
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson, runCommand } from "@creatorflow/core";
import { definePipeline, StepError, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";

export interface StepBehaviour {
  /** Only apply to these content ids (default: all). */
  jobs?: string[];
  failAttempts?: number[];
  failKind?: "retryable" | "permanent";
  message?: string;
  /** Write a marker file and wait (abortably) forever on these attempts. */
  hangOnAttempts?: number[];
  blockAttempts?: number[];
  /** Wait until this workspace-relative file exists before continuing. */
  gateFile?: string;
  /** Claim success without writing outputs (verification must fail). */
  skipOutput?: boolean;
  emptyOutput?: boolean;
  /** Spawn a long-lived child (pid written to this workspace-relative file) and wait for it. */
  spawnChildPidFile?: string;
}

export interface FixtureControl {
  steps?: Record<string, StepBehaviour>;
}

export const CONTROL_FILE = "fixture-control.json";
export const EXEC_LOG = "fixture-exec.jsonl";

async function control(ws: string): Promise<FixtureControl> {
  try {
    return JSON.parse(await fs.readFile(path.join(ws, CONTROL_FILE), "utf8")) as FixtureControl;
  } catch {
    return {};
  }
}

const inputsOf: Record<string, (c: FingerprintContext) => unknown> = {
  research: (c) => ({ topic: c.item.topic, contentId: c.item.contentId, sourceIds: c.item.sourceIds }),
  script: (c) => ({ hook: c.item.hook ?? null, takeaway: c.item.takeaway ?? null, durationSec: c.item.durationSec }),
  localize: (c) => ({ language: c.item.language }),
  narrate: (c) => ({ contentId: c.item.contentId }),
  assets: (c) => ({ requiredAssets: c.item.requiredAssets }),
};
const configOf: Record<string, (c: FingerprintContext) => unknown> = {
  research: () => null,
  script: (c) => ({ brand: c.profile.brand.name }),
  localize: (c) => ({ additional: c.profile.languages.additional }),
  narrate: (c) => ({ voice: c.profile.voice.mode }),
  assets: () => null,
};

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function execute(ctx: StepContext): Promise<StepResult> {
  const ws = ctx.workspaceDir;
  const all = (await control(ws)).steps?.[ctx.stepId];
  const b = all && (!all.jobs || all.jobs.includes(ctx.item.contentId)) ? all : undefined;
  await fs.appendFile(path.join(ws, EXEC_LOG), `${JSON.stringify({ pid: process.pid, jobId: ctx.jobId, step: ctx.stepId, attempt: ctx.attempt })}\n`);

  if (b?.hangOnAttempts?.includes(ctx.attempt)) {
    await fs.writeFile(path.join(ws, `hang-${ctx.jobId}-${ctx.stepId}-${ctx.attempt}.marker`), String(process.pid));
    await waitForAbort(ctx.signal);
  }
  if (b?.gateFile) {
    await fs.writeFile(path.join(ws, `waiting-${ctx.jobId}-${ctx.stepId}.marker`), String(process.pid));
    while (!(await fs.stat(path.join(ws, b.gateFile)).catch(() => undefined))) await delay(20, undefined, { signal: ctx.signal });
  }
  if (b?.spawnChildPidFile) {
    const pidFile = path.join(ws, b.spawnChildPidFile);
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    await runCommand(process.execPath, ["-e", script], { signal: ctx.signal, timeoutMs: 120_000 });
    if (ctx.signal.aborted) throw ctx.signal.reason;
  }
  if (b?.blockAttempts?.includes(ctx.attempt)) return { status: "blocked", code: "NEEDS_SOURCES", reason: "waiting for user-supplied sources" };
  if (b?.failAttempts?.includes(ctx.attempt)) {
    throw new StepError(b.message ?? `injected ${b.failKind ?? "retryable"} failure on attempt ${ctx.attempt}`, { kind: b.failKind ?? "retryable", code: "INJECTED" });
  }
  if (b?.skipOutput) return { status: "succeeded" };

  const fctx: FingerprintContext = { jobId: ctx.jobId, item: ctx.item, profile: ctx.profile, config: ctx.config };
  const body = b?.emptyOutput
    ? ""
    : `${canonicalJson({
        step: ctx.stepId,
        inputs: inputsOf[ctx.stepId]!(fctx),
        config: configOf[ctx.stepId]!(fctx),
        upstream: ctx.upstream.map((u) => u.sha256),
      })}\n`;
  const out = ctx.outputPath(`${ctx.stepId}/out.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, body);
  return { status: "succeeded", metadata: { attempt: ctx.attempt } };
}

const step = (id: string, from: any, to: any, role?: "research" | "script") => ({
  id,
  version: 1,
  from,
  to,
  outputs: [{ path: `${id}/out.json`, ...(role ? { role } : {}) }],
  inputs: inputsOf[id]!,
  config: configOf[id]!,
  execute,
});

export const fixturePipeline = definePipeline("fixture", [
  step("research", "PLANNED", "RESEARCHED", "research"),
  step("script", "RESEARCHED", "SCRIPTED", "script"),
  step("localize", "SCRIPTED", "LOCALIZED"),
  step("narrate", "LOCALIZED", "NARRATED"),
  step("assets", "NARRATED", "ASSETS_READY"),
]);
