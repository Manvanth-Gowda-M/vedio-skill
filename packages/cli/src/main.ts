import path from "node:path";
import { Command, CommanderError, Option } from "commander";
import { CreatorFlowError, ExitCode, isCreatorFlowError, type ExitCodeValue } from "@creatorflow/core";
import type { Pipeline } from "@creatorflow/orchestrator";
import { productionPipeline } from "./pipeline.ts";
import { runDoctor, type CheckStatus } from "./commands/doctor.ts";
import { approvePlanCommand, planAddCommand, resumeCommand, statusCommand, type ApproveFlags, type ResumeFlags } from "./commands/workflow.ts";
import { renderConfigCommand, renderRunCommand, renderStatusCommand } from "./commands/render.ts";
import {
  ASSET_FORMATS_HELP,
  assetsInspectCommand,
  assetsListCommand,
  assetsRecoverCommand,
  assetsRegisterCommand,
  assetsRemoveCommand,
  assetsUpdateCommand,
  assetsValidateCommand,
  type RegisterFlags,
  type UpdateFlags,
} from "./commands/assets.ts";
import { voiceProvidersCommand, voiceTestCommand } from "./commands/voice.ts";
import { qaRunCommand, qaShowCommand, reviewDecideCommand, reviewShowCommand } from "./commands/qa.ts";
import { packageExportCommand, packageRunCommand, packageShowCommand, packageVerifyCommand } from "./commands/package.ts";
import { batchReportCommand, batchResumeCommand, batchRunCommand, batchStatusCommand } from "./commands/batch.ts";
import { ASSET_TYPES } from "@creatorflow/schemas";
import { planWeekCommand, researchCommand, type PlanWeekFlags, type ResearchFlags } from "./commands/research.ts";
import {
  localizeImportCommand,
  localizeTemplateCommand,
  localizeValidateCommand,
  scriptShowCommand,
  scriptValidateCommand,
  storyboardInspectCommand,
  subtitlesExportCommand,
} from "./commands/script.ts";
import { runInit, type InitFlags } from "./onboarding/init.ts";
import { PRESETS } from "./onboarding/defaults.ts";
import { createTtyPrompter, type Prompter } from "./onboarding/prompter.ts";
import { createOutput, processStreams, type Output, type OutputStreams } from "./output.ts";
import { loadProject, SKILL_SOURCE_DIR } from "./project.ts";
import { AGENT_SKILL_DIRS, installSkill, isAgentId, type InstallScope } from "./skill/install.ts";
import { validateSkillDir } from "./skill/validate.ts";

export interface MainDeps {
  streams?: OutputStreams;
  /** Overrides the interactive prompter (tests). */
  prompter?: Prompter;
  /** Whether stdin is an interactive terminal. */
  isTty?: boolean;
  home?: string;
  /** Workflow pipeline; defaults to the production pipeline. Tests inject fixture executors here. */
  pipeline?: Pipeline;
}

const STATUS_ICON: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" };

interface GlobalOpts {
  dir: string;
  json?: boolean;
}

function buildProgram(deps: MainDeps, setExit: (code: ExitCodeValue) => void): Command {
  const streams = deps.streams ?? processStreams;
  const out = (cmd: Command): Output => createOutput(Boolean((cmd.optsWithGlobals() as GlobalOpts).json), streams);
  const dirOf = (cmd: Command): string => path.resolve((cmd.optsWithGlobals() as GlobalOpts).dir);

  const program = new Command("creatorflow")
    .description("CreatorFlow: research-backed, faceless video production toolkit for coding agents.")
    .version("0.1.0")
    .option("-C, --dir <path>", "project directory containing creatorflow.config.json", process.cwd())
    .option("--json", "machine-readable JSON output on stdout")
    .showHelpAfterError("(run with --help for usage)")
    .configureOutput({ writeOut: streams.stdout, writeErr: streams.stderr })
    .exitOverride();

  // ---------------------------------------------------------------- init
  program
    .command("init")
    .description("Create or update creator-profile.json and creatorflow.config.json (asks only for missing essentials).")
    .addOption(new Option("--preset <name>", "apply a starting preset").choices(Object.keys(PRESETS)))
    .option("--answers <file>", 'JSON file with { "profile": {...}, "config": {...} } for non-interactive setup')
    .option("--non-interactive", "never prompt; fail with a list of missing fields instead")
    .option("--dry-run", "validate and report without writing files")
    .option("--name <text>", "creator / channel display name")
    .option("--niche <text>", "one-line niche")
    .option("--topics <csv>", "core topics, comma-separated")
    .option("--audience <text>", "audience description")
    .option("--language <tag>", "primary language (BCP 47)")
    .option("--languages <csv>", "additional languages (BCP 47), comma-separated")
    .option("--platform <id>", "primary platform")
    .option("--secondary-platforms <csv>", "secondary platforms, comma-separated")
    .option("--timezone <iana>", "IANA time zone, e.g. Asia/Kolkata")
    .option("--weekly-target <n>", "videos per week (1-14)")
    .option("--brand-name <text>", "brand name shown in videos")
    .action(async function (this: Command, opts: InitFlags & { preset?: string; answers?: string; nonInteractive?: boolean; dryRun?: boolean }) {
      const o = out(this);
      const interactive = !opts.nonInteractive && !o.json && (deps.isTty ?? Boolean(process.stdin.isTTY));
      const prompter = interactive ? (deps.prompter ?? createTtyPrompter()) : undefined;
      try {
        const r = await runInit({
          dir: dirOf(this),
          interactive,
          dryRun: Boolean(opts.dryRun),
          ...(opts.preset ? { preset: opts.preset } : {}),
          ...(opts.answers ? { answersFile: opts.answers } : {}),
          ...(prompter ? { prompter } : {}),
          flags: opts,
        });
        o.result({ ok: true, ...r });
        o.line(`Profile: ${r.profileFile} (${r.profile.status})`);
        o.line(`Config:  ${r.configFile} (${r.config.status})`);
        o.line(`Workspace: ${r.workspaceDir}`);
        if (r.preserved.length) o.line(`Preserved existing values for: ${r.preserved.join(", ")}`);
        o.line("Next: run `creatorflow doctor` to check the toolchain.");
      } finally {
        prompter?.close();
      }
    });

  // ---------------------------------------------------------------- doctor
  program
    .command("doctor")
    .description("Diagnose the local toolchain, configuration, and provider credentials (presence only).")
    .action(async function (this: Command) {
      const o = out(this);
      const report = await runDoctor(dirOf(this));
      o.result(report);
      o.line(`CreatorFlow doctor — ${report.environment.os}, Node ${report.environment.node}`);
      for (const c of report.checks) {
        o.line(`  [${STATUS_ICON[c.status]}] ${c.label}: ${c.detail}`);
        if (c.hint && c.status !== "pass") o.line(`         -> ${c.hint}`);
      }
      const s = report.summary;
      o.line(`\n${s.pass} passed, ${s.warn} warnings, ${s.fail} failed, ${s.info} info`);
      if (!report.ok) setExit(ExitCode.CHECK_FAILED);
    });

  // ---------------------------------------------------------------- profile
  const profile = program.command("profile").description("Creator profile commands.");
  profile
    .command("validate")
    .description("Validate creator-profile.json and creatorflow.config.json against their schemas.")
    .action(async function (this: Command) {
      const o = out(this);
      const p = await loadProject(dirOf(this));
      const docs = [
        { kind: "config", file: p.config.file, exists: p.config.exists, issues: p.config.issues },
        { kind: "profile", file: p.profileFile, exists: p.profile?.exists ?? false, issues: p.profile?.issues ?? [] },
      ];
      const ok = docs.every((d) => d.exists && d.issues.length === 0);
      o.result({ ok, documents: docs });
      for (const d of docs) {
        if (!d.exists) o.line(`MISSING ${d.kind}: ${d.file} (run \`creatorflow init\`)`);
        else if (d.issues.length === 0) o.line(`VALID   ${d.kind}: ${d.file}`);
        else {
          o.line(`INVALID ${d.kind}: ${d.file}`);
          for (const i of d.issues) o.line(`  - ${i.path}: ${i.message}`);
        }
      }
      if (!ok) setExit(docs.some((d) => !d.exists) ? ExitCode.CONFIG : ExitCode.CHECK_FAILED);
    });

  // ---------------------------------------------------------------- skill
  const skill = program.command("skill").description("Portable agent skill commands.");
  skill
    .command("validate")
    .description("Validate a skill directory against the Agent Skills specification.")
    .argument("[dir]", "skill directory", SKILL_SOURCE_DIR)
    .action(async function (this: Command, dir: string) {
      const o = out(this);
      const v = await validateSkillDir(dir);
      o.result(v);
      o.line(`${v.ok ? "VALID" : "INVALID"} skill ${v.name ?? "(unnamed)"} at ${v.dir}`);
      o.line(`  SKILL.md body: ${v.bodyLines} lines; ${v.referencedFiles.length} linked files`);
      for (const i of v.issues) o.line(`  - ${i.severity}: ${i.message}`);
      if (!v.ok) setExit(ExitCode.CHECK_FAILED);
    });

  skill
    .command("install")
    .description("Copy the CreatorFlow skill into an agent's skill discovery directory.")
    .addOption(new Option("--agent <id>", "target agent").choices(Object.keys(AGENT_SKILL_DIRS)).makeOptionMandatory())
    .addOption(new Option("--scope <scope>", "project (inside --dir) or user (home directory)").choices(["project", "user"]).default("project"))
    .option("--force", "replace an existing installation (previous copy kept as .bak)")
    .option("--dry-run", "show the target without copying")
    .action(async function (this: Command, opts: { agent: string; scope: InstallScope; force?: boolean; dryRun?: boolean }) {
      const o = out(this);
      if (!isAgentId(opts.agent)) throw new CreatorFlowError(`Unknown agent ${opts.agent}`, { code: "USAGE", exitCode: ExitCode.USAGE });
      const r = await installSkill({
        source: SKILL_SOURCE_DIR,
        agent: opts.agent,
        scope: opts.scope,
        projectDir: dirOf(this),
        force: Boolean(opts.force),
        dryRun: Boolean(opts.dryRun),
        ...(deps.home ? { home: deps.home } : {}),
      });
      o.result({ ok: true, ...r });
      o.line(`${r.status}: ${AGENT_SKILL_DIRS[r.agent].label} skill at ${r.target} (${r.files} files)`);
    });

  // ---------------------------------------------------------------- research & planning
  program
    .command("research")
    .description("Import user-supplied sources into a research session, or inspect a session and its candidate ranking. Offline: no live web research.")
    .option("--input <path>", "research JSON file, or a directory of them (with optional local HTML/text snapshots)")
    .option("--session <id>", "research session id", "main")
    .option("--topic <text>", "session topic / niche description")
    .option("--replace", "replace the session's records with exactly this input (default: merge)")
    .option("--as-of <date>", "date used for freshness and ranking (default: today in the profile time zone)")
    .option("--query <text>", "search query (requires a provider with web search; none is available in this release)")
    .action(async function (this: Command, opts: ResearchFlags) {
      setExit(await researchCommand(out(this), dirOf(this), opts));
    });

  program
    .command("plan-week")
    .description("Rank research candidates and save a new, UNAPPROVED weekly plan version (never fills slots with unsourced topics).")
    .option("--week <id>", "ISO week, e.g. 2026-W44 (default: next week)")
    .option("--session <id>", "research session id", "main")
    .option("--as-of <date>", "scoring date (default: Monday of the week)")
    .action(async function (this: Command, opts: PlanWeekFlags) {
      setExit(await planWeekCommand(out(this), dirOf(this), opts));
    });

  // ---------------------------------------------------------------- scripts, storyboards, localization
  const script = program.command("script").description("Inspect and validate generated scripts (scripts are generated by `resume`).");
  script
    .command("show")
    .description("Print a job's canonical script: segments, claim references, timing estimates, sources and editorial issues.")
    .requiredOption("--job <id>", "job id (see `creatorflow status`)")
    .action(async function (this: Command, opts: { job: string }) {
      setExit(await scriptShowCommand(out(this), dirOf(this), opts.job));
    });
  script
    .command("validate")
    .description("Re-check script, storyboard, captions and scene manifest against the evidence, their recorded hashes and each other.")
    .option("--job <id>", "one job (default: every scripted job of the week)")
    .option("--week <id>", "ISO week (default: latest week)")
    .action(async function (this: Command, opts: { job?: string; week?: string }) {
      setExit(await scriptValidateCommand(out(this), dirOf(this), opts));
    });

  program
    .command("storyboard")
    .description("Storyboard commands.")
    .command("inspect")
    .description("Print a job's scenes, timing, layout checks and asset requirements.")
    .requiredOption("--job <id>", "job id")
    .action(async function (this: Command, opts: { job: string }) {
      setExit(await storyboardInspectCommand(out(this), dirOf(this), opts.job));
    });

  const localize = program.command("localize").description("Human translation import and validation (no machine translation in this release).");
  localize
    .command("template")
    .description("Write a translation template for a job's canonical script.")
    .requiredOption("--job <id>", "job id")
    .requiredOption("--lang <tag>", "target language (BCP 47), e.g. hi-IN, kn-IN")
    .option("--out <file>", "where to write the template (default: inside the workspace)")
    .action(async function (this: Command, opts: { job: string; lang: string; out?: string }) {
      setExit(await localizeTemplateCommand(out(this), dirOf(this), opts));
    });
  localize
    .command("import")
    .description("Validate a human translation against the current canonical script and store it for the localize step.")
    .requiredOption("--job <id>", "job id")
    .requiredOption("--file <path>", "filled-in translation JSON")
    .action(async function (this: Command, opts: { job: string; file: string }) {
      setExit(await localizeImportCommand(out(this), dirOf(this), opts));
    });
  localize
    .command("validate")
    .description("Check stored translations for a job: missing, stale, invalid or valid (structure only, not quality).")
    .requiredOption("--job <id>", "job id")
    .action(async function (this: Command, opts: { job: string }) {
      setExit(await localizeValidateCommand(out(this), dirOf(this), opts));
    });

  program
    .command("subtitles")
    .description("Subtitle commands.")
    .command("export")
    .description("Export a subtitle track as SRT or WebVTT (UTF-8). Narrated jobs export sentence-aligned timing; otherwise timing is estimated.")
    .requiredOption("--job <id>", "job id")
    .requiredOption("--lang <tag>", "language of the track")
    .addOption(new Option("--format <fmt>", "output format").choices(["srt", "vtt"]).default("srt"))
    .option("--out <file>", "output file (default: inside the job directory)")
    .action(async function (this: Command, opts: { job: string; lang: string; format: "srt" | "vtt"; out?: string }) {
      setExit(await subtitlesExportCommand(out(this), dirOf(this), opts));
    });

  // ---------------------------------------------------------------- assets
  const assets = program.command("assets").description("Register and check local media in workspace/assets/ (images, code text, video clips). Never downloads; licences are recorded as stated, not verified.");
  const provOptions = (c: Command) =>
    c
      .addOption(new Option("--origin <origin>", "where the file came from (a claim)").choices(["user-created", "user-provided", "public-domain-claim", "open-license-claim", "unknown"]))
      .option("--creator <name>", "creator or provider, if known")
      .option("--source-url <url>", "source URL (recorded only; never fetched)")
      .option("--license <id>", "declared licence (SPDX id or name); omit if unknown")
      .option("--attribution <text>", "attribution text to show in the video")
      .option("--attribution-required", "the licence requires attribution (rendering blocks without --attribution)")
      .option("--no-attribution-required", "the licence does not require attribution")
      .option("--obtained <date>", "date the file was obtained (YYYY-MM-DD)")
      .option("--attest", "you assert you have the rights stated (recorded as user-attested; still not verified)")
      .option("--notes <text>", "limitations or notes");
  const clipOptions = (c: Command) =>
    c
      .option("--start <sec>", "video clips: start of the window in the source (seconds)")
      .option("--end <sec>", "video clips: end of the window (seconds; default: end of the source)")
      .addOption(new Option("--fit <fit>", "video clips: contain (letterbox) or cover (crop centre)").choices(["contain", "cover"]));
  assets
    .command("list")
    .description("List registered assets, their measured media, licences and scene uses.")
    .option("--job <id>", "only assets used by this job")
    .option("--type <type>", "only this asset type")
    .action(async function (this: Command, opts: { job?: string; type?: string }) {
      setExit(await assetsListCommand(out(this), dirOf(this), opts));
    });
  assets
    .command("inspect")
    .description("Show one asset, re-check its file now, and list the scene slots that use it.")
    .requiredOption("--id <id>", "asset id")
    .action(async function (this: Command, opts: { id: string }) {
      setExit(await assetsInspectCommand(out(this), dirOf(this), opts));
    });
  clipOptions(
    provOptions(
      assets
        .command("register")
        .description(`Register a file that is already inside workspace/assets/. Formats: ${ASSET_FORMATS_HELP}. Content type, size, hash and (for video) streams and decodability are measured from the file.`)
        .requiredOption("--file <path>", "file inside workspace/assets/")
        .addOption(new Option("--type <type>", "asset type").choices([...ASSET_TYPES]).makeOptionMandatory())
        .option("--id <id>", "stable id (default: derived from the file name)")
        .option("--job <id>", "job whose scene slot this file fills (with --slot)")
        .option("--slot <assetId>", "scene-manifest asset id, e.g. ast-scn-03-diagram (with --job)"),
    ),
  ).action(async function (this: Command, opts: RegisterFlags) {
    setExit(await assetsRegisterCommand(out(this), dirOf(this), opts));
  });
  clipOptions(
    provOptions(
      assets
        .command("update")
        .description("Change provenance, attach/detach scene uses, set a clip window, or --refresh after an intended file change. The id never changes.")
        .requiredOption("--id <id>", "asset id")
        .option("--use <jobId:slot>", "attach to a scene slot (clip flags apply to this use)")
        .option("--unuse <jobId:slot>", "detach from a scene slot")
        .option("--refresh", "re-measure the file and accept its new content hash"),
    ),
  ).action(async function (this: Command, opts: UpdateFlags) {
    setExit(await assetsUpdateCommand(out(this), dirOf(this), opts));
  });
  assets
    .command("validate")
    .description("Re-check every registered file (exists, hash, actual content, video decodability, clip windows, attribution).")
    .option("--id <id>", "one asset")
    .action(async function (this: Command, opts: { id?: string }) {
      setExit(await assetsValidateCommand(out(this), dirOf(this), opts));
    });
  assets
    .command("remove")
    .description("Remove an unused asset from the registry (refuses while scene slots use it). The file itself is never deleted.")
    .requiredOption("--id <id>", "asset id")
    .action(async function (this: Command, opts: { id: string }) {
      setExit(await assetsRemoveCommand(out(this), dirOf(this), opts));
    });
  assets
    .command("recover")
    .description("Restore a corrupt registry.json from registry.prev.json (the corrupt file is kept).")
    .action(async function (this: Command) {
      setExit(await assetsRecoverCommand(out(this), dirOf(this)));
    });

  // ---------------------------------------------------------------- voice
  const voice = program.command("voice").description("Local narration providers (Windows SAPI, Piper). Never downloads engines or models.");
  voice
    .command("providers")
    .description("Report every voice provider's readiness, voices, languages, controls and licence notes.")
    .action(async function (this: Command) {
      setExit(await voiceProvidersCommand(out(this), dirOf(this)));
    });
  voice
    .command("test")
    .description("Synthesise one sentence with the configured provider and measure it (no job state changes).")
    .option("--text <text>", "sentence to speak")
    .option("--lang <tag>", "language (default: the profile's primary language)")
    .option("--out <file>", "also save the WAV here")
    .action(async function (this: Command, opts: { text?: string; out?: string; lang?: string }) {
      setExit(await voiceTestCommand(out(this), dirOf(this), opts));
    });

  // ---------------------------------------------------------------- rendering
  const render = program.command("render").description("Render videos with Remotion (local browser, no network) and inspect the results.");
  render
    .command("run")
    .description("Advance one job through its remaining steps up to and including the render; verified renders are reused.")
    .requiredOption("--job <id>", "job id (see `creatorflow status`)")
    .option("--force", "re-render even if a verified render exists")
    .option("--out <file>", "also copy the verified MP4 here")
    .action(async function (this: Command, opts: { job: string; force?: boolean; out?: string }) {
      setExit(await renderRunCommand(out(this), dirOf(this), pipeline, opts));
    });
  render
    .command("status")
    .description("Show a job's asset, queue and render steps, errors, and the verified render report.")
    .requiredOption("--job <id>", "job id")
    .action(async function (this: Command, opts: { job: string }) {
      setExit(await renderStatusCommand(out(this), dirOf(this), opts));
    });
  render
    .command("config")
    .description("Show effective render settings, browser, media-inspection tool, font resolution and licensing notes.")
    .action(async function (this: Command) {
      setExit(await renderConfigCommand(out(this), dirOf(this)));
    });

  // ---------------------------------------------------------------- workflow
  const pipeline = deps.pipeline ?? productionPipeline;

  // ---------------------------------------------------------------- technical QA and human review
  const qa = program.command("qa").description("Technical QA of rendered videos: file, stream, full decode, sampled frames, audio, captions, content and provenance checks.");
  qa
    .command("run")
    .description("Run the job's remaining steps up to and including technical QA (renders first only if needed). Exit 0 only if technical QA passed.")
    .requiredOption("--job <id>", "job id")
    .option("--force", "re-run QA even if a verified QA report exists (never re-renders)")
    .option("--retry-failed", "grant a fresh retry budget to failed steps")
    .action(async function (this: Command, opts: { job: string; force?: boolean; retryFailed?: boolean }) {
      setExit(await qaRunCommand(out(this), dirOf(this), pipeline, opts));
    });
  qa
    .command("show")
    .description("Show the QA report: failed/blocked/review checks, measured media, frames and human review items. Marks stale or unverified reports.")
    .requiredOption("--job <id>", "job id")
    .option("--all", "list passing checks and every review item too")
    .action(async function (this: Command, opts: { job: string; all?: boolean }) {
      setExit(await qaShowCommand(out(this), dirOf(this), opts));
    });
  const review = program.command("review").description("Human review gate after technical QA (a manifest and recorded decisions; there is no review GUI). Never publishes.");
  review
    .command("show")
    .description("Show the review manifest (frames, scenes, questions), the recorded decision and delivery readiness.")
    .requiredOption("--job <id>", "job id")
    .action(async function (this: Command, opts: { job: string }) {
      setExit(await reviewShowCommand(out(this), dirOf(this), opts));
    });
  for (const [name, decision] of [["approve", "approved"], ["reject", "rejected"]] as const) {
    review
      .command(name)
      .description(`Record a human ${decision === "approved" ? "approval" : "rejection"} of exactly the current QA report (hash-bound). Only on the reviewer's explicit instruction.`)
      .requiredOption("--job <id>", "job id")
      .requiredOption("--qa-hash <hash>", "QA report hash shown by `qa run` / `review show` (>= 12 hex chars)")
      .option("--by <name>", "reviewer name (default: OS user name)")
      .option("--note <text>", decision === "rejected" ? "what must change (required)" : "note stored with the decision")
      .action(async function (this: Command, opts: { job: string; qaHash: string; by?: string; note?: string }) {
        setExit(await reviewDecideCommand(out(this), dirOf(this), { ...opts, decision }));
      });
  }
  const collect = (value: string, previous: string[] = []) => [...previous, value];

  const plan = program.command("plan").description("Weekly plan versions.");
  plan
    .command("add")
    .description("Store an edited weekly plan (JSON) as the next numbered version; identical content creates no new version.")
    .requiredOption("--file <path>", "weekly plan JSON file")
    .action(async function (this: Command, opts: { file: string }) {
      setExit(await planAddCommand(out(this), dirOf(this), opts.file));
    });

  program
    .command("approve-plan")
    .description("Approve (or --reject) an exact plan version; the content hash must match. Never authorises publishing.")
    .option("--week <id>", "ISO week, e.g. 2026-W44 (default: latest week)")
    .requiredOption("--plan-version <n>", "plan version number (named so it does not clash with the global --version)")
    .requiredOption("--hash <hash>", "content hash shown by `plan add` / `status` (full, or a prefix of >= 12 hex chars)")
    .option("--by <name>", "who is approving (default: OS user name)")
    .option("--note <text>", "note stored with the decision")
    .option("--reject", "record a rejection instead of an approval")
    .action(async function (this: Command, opts: ApproveFlags) {
      setExit(await approvePlanCommand(out(this), dirOf(this), opts));
    });

  program
    .command("status")
    .description("Show the weekly plan, approvals, job states, blocked and failed jobs, and progress (read-only).")
    .option("--week <id>", "ISO week (default: latest week)")
    .action(async function (this: Command, opts: { week?: string }) {
      setExit(await statusCommand(out(this), dirOf(this), pipeline, opts.week));
    });

  program
    .command("resume")
    .description("Continue jobs of the approved plan from their last verified step; verified work is never redone unless its inputs changed.")
    .option("--week <id>", "ISO week (default: latest week, or the week of --job)")
    .option("--job <id>", "resume a single job")
    .option("--retry-failed", "grant a fresh retry budget to FAILED steps")
    .option("--force-step <step>", "re-run a step even if its outputs are valid (repeatable)", collect)
    .action(async function (this: Command, opts: ResumeFlags) {
      setExit(await resumeCommand(out(this), dirOf(this), pipeline, opts));
    });

  // ---------------------------------------------------------------- packaging
  const pkg = program.command("package").description("Create, inspect, verify and export delivery bundles for approved videos.");
  pkg
    .command("run")
    .description("Advance one job through its remaining steps up to and including packaging (only for QA-passed, human-approved jobs).")
    .requiredOption("--job <id>", "job id")
    .option("--force", "re-package even if a verified package exists")
    .option("--retry-failed", "grant a fresh retry budget to failed steps")
    .action(async function (this: Command, opts: { job: string; force?: boolean; retryFailed?: boolean }) {
      setExit(await packageRunCommand(out(this), dirOf(this), pipeline, opts));
    });
  pkg
    .command("show")
    .description("Show the delivery package manifest, file list, hashes, QA report and human review records.")
    .requiredOption("--job <id>", "job id")
    .action(async function (this: Command, opts: { job: string }) {
      setExit(await packageShowCommand(out(this), dirOf(this), opts));
    });
  pkg
    .command("verify")
    .description("Independently verify an existing delivery package against its manifest hashes, sizes and review gates.")
    .option("--job <id>", "job id")
    .option("--path <dir>", "custom package directory path")
    .action(async function (this: Command, opts: { job?: string; path?: string }) {
      setExit(await packageVerifyCommand(out(this), dirOf(this), opts));
    });
  pkg
    .command("export")
    .description("Export a verified package to a destination directory or a deterministic .zip archive.")
    .requiredOption("--job <id>", "job id")
    .requiredOption("--out <path>", "output directory or .zip file path")
    .action(async function (this: Command, opts: { job: string; out: string }) {
      setExit(await packageExportCommand(out(this), dirOf(this), opts));
    });

  // ---------------------------------------------------------------- batch orchestration
  const batch = program.command("batch").description("Coordinate the seven-video weekly batch execution for an approved weekly plan.");
  batch
    .command("status")
    .description("Show the status of all seven jobs in the approved weekly plan.")
    .option("--week <id>", "ISO week (default: latest week)")
    .action(async function (this: Command, opts: { week?: string }) {
      setExit(await batchStatusCommand(out(this), dirOf(this), opts.week));
    });
  batch
    .command("run")
    .description("Execute remaining steps for every job of the approved weekly plan sequentially (concurrency 1).")
    .option("--week <id>", "ISO week (default: latest week)")
    .option("--stop-after <step>", "stop after this step has completed (e.g. render, qa, review, package)")
    .option("--retry-failed", "grant a fresh retry budget to FAILED steps")
    .action(async function (this: Command, opts: { week?: string; stopAfter?: string; retryFailed?: boolean }) {
      setExit(await batchRunCommand(out(this), dirOf(this), pipeline, opts));
    });
  batch
    .command("resume")
    .description("Resume all jobs of the approved weekly plan from their last verified milestone.")
    .option("--week <id>", "ISO week (default: latest week)")
    .option("--retry-failed", "grant a fresh retry budget to FAILED steps")
    .action(async function (this: Command, opts: { week?: string; retryFailed?: boolean }) {
      setExit(await batchResumeCommand(out(this), dirOf(this), pipeline, opts));
    });
  batch
    .command("report")
    .description("Generate and validate the batch summary report for an approved weekly plan.")
    .option("--week <id>", "ISO week (default: latest week)")
    .option("--out <file>", "also write the report JSON to this file")
    .action(async function (this: Command, opts: { week?: string; out?: string }) {
      setExit(await batchReportCommand(out(this), dirOf(this), opts));
    });

  program
    .command("report")
    .description("Generate and display the weekly batch report (alias for `creatorflow batch report`).")
    .option("--week <id>", "ISO week (default: latest week)")
    .option("--out <file>", "also write the report JSON to this file")
    .action(async function (this: Command, opts: { week?: string; out?: string }) {
      setExit(await batchReportCommand(out(this), dirOf(this), opts));
    });

  return program;
}

/** Top-level command names actually registered (used to keep SKILL.md honest). */
export function listCommandNames(): string[] {
  return buildProgram({}, () => {}).commands.map((c) => c.name());
}

/** CLI entry point. Returns the process exit code instead of exiting (testable). */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const streams = deps.streams ?? processStreams;
  let exitCode: ExitCodeValue = ExitCode.OK;
  const program = buildProgram(deps, (c) => {
    exitCode = c;
  });
  const json = argv.includes("--json");
  try {
    await program.parseAsync([...argv]);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version output exit with code 0; parse errors are usage errors.
      return error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    if (isCreatorFlowError(error)) {
      if (json) streams.stdout(`${JSON.stringify({ ok: false, ...error.toJSON() }, null, 2)}\n`);
      else {
        streams.stderr(`error [${error.code}]: ${error.message}\n`);
        if (Array.isArray(error.details)) {
          for (const d of error.details as Array<Record<string, unknown>>) {
            streams.stderr(`  - ${String(d["path"] ?? "")}: ${String(d["message"] ?? d["question"] ?? "")}\n`);
          }
        }
        if (error.hint) streams.stderr(`hint: ${error.hint}\n`);
      }
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) streams.stdout(`${JSON.stringify({ ok: false, error: "INTERNAL", message }, null, 2)}\n`);
    else streams.stderr(`internal error: ${message}\n`);
    return ExitCode.INTERNAL;
  }
}
