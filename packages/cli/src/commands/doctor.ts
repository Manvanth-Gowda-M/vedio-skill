import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { envVarPresent, pathExists, runCommand, type RunResult } from "@creatorflow/core";
import type { CreatorFlowConfig } from "@creatorflow/schemas";
import { voiceProviderFor } from "@creatorflow/voice";
import { loadProject, REPO_ROOT } from "../project.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: Record<CheckStatus, number>;
  environment: { os: string; arch: string; node: string; cpus: number; memoryGb: number };
  checks: DoctorCheck[];
}

/** Injectable system access so doctor is unit-testable. */
export interface DoctorDeps {
  run: (file: string, args: readonly string[]) => Promise<RunResult>;
  exists: (p: string) => Promise<boolean>;
  nodeVersion: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  freeDiskBytes: (dir: string) => Promise<number | undefined>;
  resolvePackage: (name: string) => string | undefined;
  /** Voice provider readiness (tests inject a fake; the default starts the configured provider's health check). */
  voiceHealth?: (config: CreatorFlowConfig) => Promise<{ ready: true; voices: number } | { ready: false; message: string }>;
}

async function defaultVoiceHealth(config: CreatorFlowConfig): Promise<{ ready: true; voices: number } | { ready: false; message: string }> {
  const h = await voiceProviderFor(config).health();
  return h.ready ? { ready: true, voices: h.capabilities.voices.length } : { ready: false, message: h.message };
}

const MIN_NODE: [number, number] = [22, 18];
const MIN_FREE_DISK_GB = 5;

export const defaultDoctorDeps: DoctorDeps = {
  run: (file, args) => runCommand(file, args, { timeoutMs: 10_000 }),
  exists: pathExists,
  nodeVersion: process.versions.node,
  platform: process.platform,
  env: process.env,
  freeDiskBytes: async (dir) => {
    try {
      const s = await fs.statfs(dir);
      return s.bavail * s.bsize;
    } catch {
      return undefined;
    }
  },
  resolvePackage: (name) => {
    try {
      return createRequire(path.join(REPO_ROOT, "package.json")).resolve(`${name}/package.json`);
    } catch {
      return undefined;
    }
  },
};

function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter(Boolean) as string[];
    return roots.flatMap((r) => [
      path.join(r, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

async function versionOf(deps: DoctorDeps, file: string, args: string[]): Promise<{ found: boolean; line: string }> {
  const r = await deps.run(file, args);
  if (r.errorCode === "ENOENT" || r.exitCode === null) return { found: false, line: r.errorCode ?? "not runnable" };
  const line = (r.stdout || r.stderr).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return { found: r.exitCode === 0, line: line.trim() };
}

export async function runDoctor(dir: string, deps: DoctorDeps = defaultDoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);
  const isWin = deps.platform === "win32";

  // --- Node.js ---
  const [maj = 0, min = 0] = deps.nodeVersion.split(".").map(Number);
  const nodeOk = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  add({
    id: "node",
    label: "Node.js",
    status: nodeOk ? "pass" : "fail",
    detail: `v${deps.nodeVersion}`,
    ...(nodeOk ? {} : { hint: `Install Node.js >= ${MIN_NODE.join(".")} (LTS 22 or 24 recommended).` }),
  });

  // --- npm / git ---
  // Run npm's JS entry through node: spawning npm.cmd without a shell is rejected on Windows.
  const npmCli = [deps.env["npm_execpath"], path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    .filter((p): p is string => typeof p === "string" && p.endsWith(".js"));
  let npmCliPath: string | undefined;
  for (const p of npmCli) if (await deps.exists(p)) { npmCliPath = p; break; }
  const npm = npmCliPath
    ? await versionOf(deps, process.execPath, [npmCliPath, "--version"])
    : await versionOf(deps, "npm", ["--version"]);
  add({ id: "npm", label: "npm", status: npm.found ? "pass" : "fail", detail: npm.found ? npm.line : "not found", ...(npm.found ? {} : { hint: "npm ships with Node.js; reinstall Node." }) });
  const git = await versionOf(deps, "git", ["--version"]);
  add({ id: "git", label: "git", status: git.found ? "pass" : "warn", detail: git.found ? git.line : "not found", ...(git.found ? {} : { hint: "Optional, but recommended for versioning plans and scripts." }) });

  // --- project files (loaded early so explicit binary paths can be honoured) ---
  const project = await loadProject(dir);
  const cfg = project.config.value;

  // --- FFmpeg / ffprobe (needed for media inspection & QA in later stages) ---
  for (const [id, bin] of [["ffmpeg", cfg?.hardware.ffmpegPath ?? "ffmpeg"], ["ffprobe", cfg?.hardware.ffprobePath ?? "ffprobe"]] as const) {
    const v = await versionOf(deps, bin, ["-version"]);
    add({
      id,
      label: id,
      status: v.found ? "pass" : "warn",
      detail: v.found ? v.line : "not found on PATH",
      ...(v.found
        ? {}
        : {
            hint: isWin
              ? `Install with \`winget install Gyan.FFmpeg\` (or set hardware.${id}Path). Required for technical QA; not needed for init/doctor/profile.`
              : `Install ${id} via your package manager (or set hardware.${id}Path). Required for technical QA.`,
          }),
    });
  }

  // ffmpeg/ffprobe are also shipped inside Remotion's compositor package; renders use them for
  // media inspection, video-asset decode checks and audio verification.
  const rendererPkg = deps.resolvePackage("@remotion/renderer");
  for (const id of ["ffmpeg", "ffprobe"] as const) {
    const check = checks.find((c) => c.id === id);
    if (!check || check.status === "pass" || !rendererPkg) continue;
    const scope = path.dirname(path.dirname(rendererPkg));
    const suffix = deps.platform === "win32" ? "-msvc" : deps.platform === "linux" ? "-gnu" : "";
    const bundled = path.join(scope, `compositor-${deps.platform}-${process.arch}${suffix}`, deps.platform === "win32" ? `${id}.exe` : id);
    if (await deps.exists(bundled)) {
      Object.assign(check, { status: "pass", detail: `not on PATH; Remotion's bundled ${id} is used (${bundled})` });
      delete check.hint;
    }
  }

  // --- Browser for Remotion rendering ---
  const explicit = cfg?.hardware.browserExecutable;
  let browser: string | undefined;
  if (explicit && (await deps.exists(explicit))) browser = explicit;
  if (!browser) {
    for (const c of browserCandidates(deps.platform, deps.env)) {
      if (await deps.exists(c)) {
        browser = c;
        break;
      }
    }
  }
  add({
    id: "browser",
    label: "Chromium-based browser",
    status: browser ? "pass" : "info",
    detail: browser ?? "no system browser detected",
    ...(browser ? {} : { hint: "Remotion can download Chrome Headless Shell on first render (`npx remotion browser ensure`)." }),
  });

  // --- Remotion (installed in Stage F) ---
  const remotion = deps.resolvePackage("@remotion/renderer");
  add({
    id: "remotion",
    label: "Remotion renderer",
    status: remotion ? "pass" : "info",
    detail: remotion ? "installed (free for individuals and companies of up to 3 people; see remotion.dev/docs/license)" : "not installed",
    ...(remotion ? {} : { hint: "Run `npm install` in the CreatorFlow repository; rendering needs it." }),
  });

  // --- Hardware ---
  // "8 GB" machines typically report ~7.6-7.9 GiB usable, so the threshold is 7.5.
  const memGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const memOk = memGb >= 7.5;
  add({
    id: "memory",
    label: "Memory",
    status: memOk ? "pass" : "warn",
    detail: `${memGb} GB, ${os.cpus().length} logical CPUs${memGb < 12 ? " (keep hardware.maxConcurrentRenders at 1)" : ""}`,
    ...(memOk ? {} : { hint: "Under 8 GB: rendering may be slow or fail; close other apps and keep maxConcurrentRenders at 1." }),
  });
  const free = await deps.freeDiskBytes(project.paths.dir);
  if (free !== undefined) {
    const gb = Math.round((free / 1024 ** 3) * 10) / 10;
    add({
      id: "disk",
      label: "Free disk space",
      status: gb >= MIN_FREE_DISK_GB ? "pass" : "warn",
      detail: `${gb} GB free`,
      ...(gb >= MIN_FREE_DISK_GB ? {} : { hint: `Rendering a week of video can need several GB; free at least ${MIN_FREE_DISK_GB} GB.` }),
    });
  }

  // --- Configuration & profile ---
  for (const [id, label, doc] of [
    ["config", "creatorflow.config.json", project.config],
    ["profile", "creator-profile.json", project.profile],
  ] as const) {
    if (!doc || !doc.exists) {
      add({ id, label, status: "warn", detail: "not found", hint: "Run `creatorflow init`." });
    } else if (doc.issues.length) {
      add({
        id,
        label,
        status: "fail",
        detail: `${doc.issues.length} issue(s): ${doc.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        hint: "Run `creatorflow profile validate` for the full list.",
      });
    } else {
      add({ id, label, status: "pass", detail: "valid" });
    }
  }

  if (cfg) {
    // Workspace writability
    const ws = path.resolve(project.paths.dir, cfg.workspaceDir);
    try {
      await fs.mkdir(ws, { recursive: true });
      const probe = path.join(ws, `.doctor-${process.pid}.tmp`);
      await fs.writeFile(probe, "ok");
      await fs.rm(probe, { force: true });
      add({ id: "workspace", label: "Workspace directory", status: "pass", detail: `${ws} is writable` });
    } catch (error) {
      add({ id: "workspace", label: "Workspace directory", status: "fail", detail: `${ws} is not writable (${(error as Error).message})`, hint: "Choose another workspaceDir in creatorflow.config.json." });
    }

    // Providers: credential presence (never values) and capability honesty
    for (const [kind, ref] of Object.entries(cfg.providers)) {
      if (!ref.enabled || ref.id === "none") {
        add({ id: `provider.${kind}`, label: `Provider: ${kind}`, status: "info", detail: "disabled (capability unavailable)" });
        continue;
      }
      if (ref.apiKeyEnv && !envVarPresent(ref.apiKeyEnv, deps.env)) {
        add({ id: `provider.${kind}`, label: `Provider: ${kind}`, status: "warn", detail: `${ref.id}: environment variable ${ref.apiKeyEnv} is not set`, hint: `Export ${ref.apiKeyEnv} in your shell; do not put it in config files.` });
        continue;
      }
      add({ id: `provider.${kind}`, label: `Provider: ${kind}`, status: "info", detail: `${ref.id}${ref.paid ? " (paid, budget-limited)" : ""} — adapter availability is checked when the stage runs` });
    }
  }

  const prof = project.profile?.value;
  if (prof) {
    for (const [slot, font] of Object.entries(prof.brand.fonts)) {
      if (font.license === "unknown") {
        add({ id: `font.${slot}`, label: `Font licence: ${slot}`, status: "warn", detail: `${font.family}: licence not recorded`, hint: "Record the font licence (e.g. OFL-1.1) before rendering commercially." });
      }
    }
    if (prof.brand.logoPath) {
      const logo = path.resolve(path.dirname(project.profileFile), prof.brand.logoPath);
      if (!(await deps.exists(logo))) {
        add({ id: "logo", label: "Brand logo", status: "warn", detail: `${prof.brand.logoPath} not found`, hint: "Fix brand.logoPath or add the file." });
      }
    }
    if (prof.voice.mode === "tts" && cfg && (cfg.providers.tts.id === "none" || !cfg.providers.tts.enabled)) {
      add({ id: "voice", label: "Voice", status: "warn", detail: "voice.mode is \"tts\" but no TTS provider is enabled", hint: "Set providers.tts.id to \"windows-sapi\" or \"piper\" (see `creatorflow voice providers`), or set voice.mode to \"none\" for silent videos." });
    } else if (prof.voice.mode === "tts" && cfg) {
      const h = await (deps.voiceHealth ?? defaultVoiceHealth)(cfg).catch((e: Error) => ({ ready: false as const, message: e.message }));
      add(h.ready ? { id: "voice", label: "Voice", status: "pass", detail: `${cfg.providers.tts.id} ready (local; ${h.voices} voice(s))` } : { id: "voice", label: "Voice", status: "warn", detail: `${cfg.providers.tts.id}: ${h.message}`, hint: "Narrated jobs block at the narrate step until this is fixed. See `creatorflow voice providers`." });
    } else if (prof.voice.mode === "user-recorded") {
      add({ id: "voice", label: "Voice", status: "warn", detail: 'voice.mode "user-recorded" is not supported yet', hint: 'Use "tts" with a local provider or "none".' });
    }
  }

  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) summary[c.status]++;
  return {
    ok: summary.fail === 0,
    summary,
    environment: { os: `${os.type()} ${os.release()}`, arch: os.arch(), node: deps.nodeVersion, cpus: os.cpus().length, memoryGb: memGb },
    checks,
  };
}
