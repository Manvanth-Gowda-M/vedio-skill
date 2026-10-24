import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathExists, runCommand } from "@creatorflow/core";
import type { CreatorFlowConfig } from "@creatorflow/schemas";

const require = createRequire(import.meta.url);

export function remotionVersion(): string {
  try {
    return (require("remotion/package.json") as { version: string }).version;
  } catch {
    return "not-installed";
  }
}

/** Local Chromium-family browsers (never downloaded). */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter(Boolean) as string[];
    return roots.flatMap((r) => [path.join(r, "Google", "Chrome", "Application", "chrome.exe"), path.join(r, "Microsoft", "Edge", "Application", "msedge.exe")]);
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export type BrowserChoice =
  | { ok: true; executable: string | null; chromeMode: "chrome-for-testing" | "headless-shell"; description: string }
  | { ok: false; message: string };

/**
 * A system Chrome/Edge is driven in its new headless mode ("chrome-for-testing"
 * mode in Remotion). Remotion's own headless-shell download is only used when
 * render.allowBrowserDownload is true.
 */
export async function chooseBrowser(config: CreatorFlowConfig): Promise<BrowserChoice> {
  const explicit = config.hardware.browserExecutable;
  if (explicit) {
    return (await pathExists(explicit))
      ? { ok: true, executable: explicit, chromeMode: "chrome-for-testing", description: `configured browser ${explicit}` }
      : { ok: false, message: `hardware.browserExecutable ${explicit} does not exist` };
  }
  for (const c of browserCandidates()) if (await pathExists(c)) return { ok: true, executable: c, chromeMode: "chrome-for-testing", description: `system browser ${c}` };
  if (config.render.allowBrowserDownload) return { ok: true, executable: null, chromeMode: "headless-shell", description: "Remotion-managed Chrome Headless Shell (downloaded on first use)" };
  return { ok: false, message: "No local Chrome or Edge found and render.allowBrowserDownload is false. Install Chrome, set hardware.browserExecutable, or allow Remotion to download Chrome Headless Shell" };
}

export interface FfprobeChoice {
  path: string;
  description: string;
}

/** ffprobe: configured path, then PATH, then the copy shipped inside Remotion's compositor package. */
export async function findFfprobe(config: CreatorFlowConfig): Promise<FfprobeChoice | undefined> {
  return findTool("ffprobe", config.hardware.ffprobePath);
}

/** ffmpeg (used to decode-check video assets and the rendered audio): same discovery as ffprobe. */
export async function findFfmpeg(config: CreatorFlowConfig): Promise<FfprobeChoice | undefined> {
  return findTool("ffmpeg", config.hardware.ffmpegPath);
}

const toolCache = new Map<string, FfprobeChoice | undefined>();

async function findTool(name: "ffprobe" | "ffmpeg", configured: string | undefined): Promise<FfprobeChoice | undefined> {
  const key = `${name}|${configured ?? ""}`;
  if (toolCache.has(key)) return toolCache.get(key);
  const found = await locateTool(name, configured);
  if (found) toolCache.set(key, found);
  return found;
}

async function locateTool(name: "ffprobe" | "ffmpeg", configured: string | undefined): Promise<FfprobeChoice | undefined> {
  const tryRun = async (p: string) => (await runCommand(p, ["-version"], { timeoutMs: 10_000 })).exitCode === 0;
  if (configured && (await tryRun(configured))) return { path: configured, description: `configured ${configured}` };
  if (await tryRun(name)) return { path: name, description: `${name} on PATH` };
  const remotionDir = path.dirname(require.resolve("@remotion/renderer/package.json"));
  const scope = path.dirname(remotionDir);
  for (const dir of await fs.readdir(scope).catch(() => [] as string[])) {
    if (!dir.startsWith("compositor-")) continue;
    for (const exe of [`${name}.exe`, name]) {
      const p = path.join(scope, dir, exe);
      if ((await pathExists(p)) && (await tryRun(p))) return { path: p, description: `${name} bundled with Remotion (@remotion/${dir})` };
    }
  }
  return undefined;
}
