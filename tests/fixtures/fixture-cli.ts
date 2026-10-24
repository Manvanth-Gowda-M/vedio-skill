#!/usr/bin/env node
// TEST-ONLY launcher: the real CreatorFlow CLI (`main`) with a test pipeline
// injected. Everything else — argument parsing, config loading, plan store,
// job store, locks, persistence and exit codes — is the production code path.
//
// CF_FIXTURE_PIPELINE:
//   (unset)      fixture executors from fixture-pipeline.ts
//   "production" the REAL production pipeline. Real executors are wrapped so they
//                can hang on chosen attempts, controlled by <workspace>/hang.json:
//                { "<stepId>": { "jobs": [contentId], "attempts": [n] } }.
//                Every real execution is logged to <workspace>/exec.jsonl.
import { promises as fs } from "node:fs";
import path from "node:path";
import { main } from "../../packages/cli/src/main.ts";
import { buildProductionPipeline } from "../../packages/cli/src/pipeline.ts";
import { fixturePipeline } from "./fixture-pipeline.ts";

type HangControl = Record<string, { jobs?: string[]; attempts?: number[] }>;

const production = buildProductionPipeline({
  wrap: (stepId, real) => async (ctx) => {
    const ctl = await fs
      .readFile(path.join(ctx.workspaceDir, "hang.json"), "utf8")
      .then((t) => JSON.parse(t) as HangControl)
      .catch(() => ({}) as HangControl);
    await fs.appendFile(path.join(ctx.workspaceDir, "exec.jsonl"), `${JSON.stringify({ pid: process.pid, jobId: ctx.jobId, step: stepId, attempt: ctx.attempt })}\n`);
    const h = ctl[stepId];
    if (h?.jobs?.includes(ctx.item.contentId) && h.attempts?.includes(ctx.attempt)) {
      await fs.writeFile(path.join(ctx.workspaceDir, `hang-${ctx.jobId}-${stepId}-${ctx.attempt}.marker`), String(process.pid));
      await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
    }
    return real(ctx);
  },
});

const pipeline = process.env["CF_FIXTURE_PIPELINE"] === "production" ? production : fixturePipeline;
process.exitCode = await main(process.argv, { pipeline });
