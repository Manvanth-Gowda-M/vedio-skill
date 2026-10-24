import { definePipeline, type FingerprintContext, type Pipeline, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import { LOCALIZE_OUTPUTS, localizeStepConfig, localizeStepExecute, localizeStepExternalInputs, localizeStepInputs } from "@creatorflow/localization";
import { RESEARCH_OUTPUT, researchStepConfig, researchStepExecute, researchStepInputs } from "@creatorflow/research";
import { SCRIPT_OUTPUTS, scriptStepConfig, scriptStepExecute, scriptStepInputs } from "@creatorflow/scriptwriter";
import {
  ASSET_OUTPUT,
  assetsStepConfig,
  assetsStepExecute,
  assetsStepExternalInputs,
  assetsStepInputs,
  makeRenderStepExecute,
  queueRenderStepExecute,
  queueStepConfig,
  queueStepInputs,
  RENDER_OUTPUTS,
  renderStepConfig,
  renderStepInputs,
  REQUEST_OUTPUT,
  type RenderEngineOptions,
} from "@creatorflow/video-engine";
import { makeNarrateStepExecute, makeNarrateStepExternalInputs, NARRATION_OUTPUTS, narrateStepConfig, narrateStepInputs, type NarrateOptions } from "@creatorflow/voice";
import {
  makeQaStepExecute,
  makeQaStepExternalInputs,
  PACKAGE_OUTPUTS,
  packageStepConfig,
  packageStepExecute,
  packageStepExternalInputs,
  packageStepInputs,
  QA_OUTPUTS,
  qaStepConfig,
  qaStepInputs,
  REVIEW_OUTPUTS,
  reviewStepConfig,
  reviewStepExecute,
  reviewStepExternalInputs,
  reviewStepInputs,
  type QaOptions,
} from "@creatorflow/qa";

/**
 * The CreatorFlow production pipeline. Every lifecycle step from `research` (Stage D)
 * through `package` (Stage I) has a real executor. Verified outputs are reused on resume.
 */
const brand = (c: FingerprintContext) => ({ brand: c.profile.brand, visual: c.profile.visual });

type Executor = (ctx: StepContext) => Promise<StepResult>;

export interface PipelineOverrides {
  /** Test hook: wrap real executors by step id (e.g. to inject a hang). */
  wrap?: (stepId: string, real: Executor) => Executor;
  /** Test hook: render engine options (fake worker, ffprobe override). */
  render?: RenderEngineOptions;
  /** Test hook: voice provider override (simulated providers). */
  voice?: NarrateOptions;
  /** Test hook: QA tool overrides (missing ffprobe/ffmpeg). */
  qa?: QaOptions;
}

export function buildProductionPipeline(overrides: PipelineOverrides = {}): Pipeline {
  const w = (id: string, real: Executor) => (overrides.wrap ? overrides.wrap(id, real) : real);
  const research = w("research", researchStepExecute);
  return definePipeline("creatorflow-v1", [
    {
      id: "research",
      version: 1,
      from: "PLANNED",
      to: "RESEARCHED",
      outputs: [{ path: RESEARCH_OUTPUT, role: "research" }],
      inputs: researchStepInputs,
      config: researchStepConfig,
      timeoutMs: 5 * 60_000,
      execute: research,
    },
    {
      id: "script",
      version: 2,
      from: "RESEARCHED",
      to: "SCRIPTED",
      outputs: [
        { path: SCRIPT_OUTPUTS.script, role: "script" },
        { path: SCRIPT_OUTPUTS.storyboard, role: "storyboard" },
        { path: SCRIPT_OUTPUTS.captions, role: "captions" },
        { path: SCRIPT_OUTPUTS.manifest, role: "sceneManifest" },
      ],
      inputs: scriptStepInputs,
      config: scriptStepConfig,
      timeoutMs: 5 * 60_000,
      execute: w("script", scriptStepExecute),
    },
    {
      id: "localize",
      version: 2,
      from: "SCRIPTED",
      to: "LOCALIZED",
      outputs: [
        { path: LOCALIZE_OUTPUTS.variants, role: "localization" },
        { path: LOCALIZE_OUTPUTS.subtitles, role: "subtitles" },
      ],
      inputs: localizeStepInputs,
      config: localizeStepConfig,
      externalInputs: localizeStepExternalInputs,
      timeoutMs: 5 * 60_000,
      execute: w("localize", localizeStepExecute),
    },
    {
      id: "narrate",
      version: 1,
      from: "LOCALIZED",
      to: "NARRATED",
      outputs: [
        { path: NARRATION_OUTPUTS.record, role: "narration" },
        { path: NARRATION_OUTPUTS.subtitles, role: "narrationSubtitles" },
        { path: NARRATION_OUTPUTS.audio, role: "narrationAudio", optional: true },
      ],
      dependsOn: ["script"],
      inputs: narrateStepInputs,
      config: narrateStepConfig,
      externalInputs: makeNarrateStepExternalInputs(overrides.voice),
      timeoutMs: 20 * 60_000,
      execute: w("narrate", makeNarrateStepExecute(overrides.voice)),
    },
    {
      id: "assets",
      version: 3,
      from: "NARRATED",
      to: "ASSETS_READY",
      outputs: [{ path: ASSET_OUTPUT, role: "assets" }],
      dependsOn: ["script"],
      inputs: assetsStepInputs,
      config: assetsStepConfig,
      externalInputs: assetsStepExternalInputs,
      timeoutMs: 15 * 60_000,
      execute: w("assets", assetsStepExecute),
    },
    {
      id: "queue-render",
      version: 3,
      from: "ASSETS_READY",
      to: "RENDER_QUEUED",
      outputs: [{ path: REQUEST_OUTPUT, role: "renderRequest" }],
      dependsOn: ["script", "narrate"],
      inputs: queueStepInputs,
      config: queueStepConfig,
      timeoutMs: 5 * 60_000,
      execute: w("queue-render", queueRenderStepExecute),
    },
    {
      id: "render",
      version: 3,
      from: "RENDER_QUEUED",
      to: "RENDERED",
      outputs: [
        { path: RENDER_OUTPUTS.video, role: "render" },
        { path: RENDER_OUTPUTS.report, role: "renderReport" },
      ],
      dependsOn: ["script", "narrate", "assets"],
      inputs: renderStepInputs,
      config: renderStepConfig,
      timeoutMs: 30 * 60_000,
      execute: w("render", makeRenderStepExecute(overrides.render)),
    },
    {
      id: "qa",
      version: 2,
      from: "RENDERED",
      to: "QA_PASSED",
      outputs: [
        { path: QA_OUTPUTS.report, role: "quality" },
        { path: QA_OUTPUTS.reviewManifest, role: "qaReview" },
      ],
      dependsOn: ["research", "script", "localize", "narrate", "assets", "queue-render"],
      inputs: qaStepInputs,
      config: qaStepConfig,
      externalInputs: makeQaStepExternalInputs(overrides.qa),
      timeoutMs: 30 * 60_000,
      execute: w("qa", makeQaStepExecute(overrides.qa)),
    },
    {
      id: "review",
      version: 1,
      from: "QA_PASSED",
      to: "REVIEWED",
      outputs: [{ path: REVIEW_OUTPUTS.record, role: "review" }],
      inputs: reviewStepInputs,
      config: reviewStepConfig,
      externalInputs: reviewStepExternalInputs,
      timeoutMs: 60_000,
      execute: w("review", reviewStepExecute),
    },
    {
      id: "package",
      version: 1,
      from: "REVIEWED",
      to: "PACKAGE_READY",
      outputs: [{ path: PACKAGE_OUTPUTS.manifest, role: "package" }],
      dependsOn: ["research", "script", "localize", "narrate", "assets", "queue-render", "render", "qa", "review"],
      inputs: packageStepInputs,
      config: packageStepConfig,
      externalInputs: packageStepExternalInputs,
      timeoutMs: 10 * 60_000,
      execute: w("package", packageStepExecute),
    },
  ]);
}

export const productionPipeline = buildProductionPipeline();
