// Render worker: runs in its own Node process so a timeout or cancellation can
// kill it together with the browser it launched. Input: path to a job JSON
// written by render.ts. Output: progress lines and one final "CF_RESULT {...}"
// line on stdout; exit code 0 only after Remotion finished writing the file.
// Remotion telemetry: server-side renders only send telemetry when a
// licenseKey is set (remotion.dev/docs/telemetry); none is set here.
import { readFileSync } from "node:fs";
import { isProcessAlive, killProcessTree } from "@creatorflow/core";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

interface WorkerJob {
  entryPoint: string;
  publicDir: string;
  bundleDir: string;
  propsFile: string;
  output: string;
  compositionId: string;
  settings: { crf: number; pixelFormat: "yuv420p" | "yuv444p"; concurrency: number; chromeMode: "chrome-for-testing" | "headless-shell" };
  browserExecutable: string | null;
  parentPid: number;
}

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as WorkerJob;
const inputProps = JSON.parse(readFileSync(job.propsFile, "utf8")) as Record<string, unknown> & { format: { width: number; height: number; fps: number; durationInFrames: number } };
const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

// If CreatorFlow dies (e.g. killed), do not keep rendering as an orphan: kill this
// worker and the browser it started. (Windows does not do this automatically.)
const watchdog = setInterval(() => {
  if (!isProcessAlive(job.parentPid)) void killProcessTree(process.pid);
}, 1000);
watchdog.unref();

try {
  say({ phase: "bundle" });
  const serveUrl = await bundle({ entryPoint: job.entryPoint, outDir: job.bundleDir, publicDir: job.publicDir });
  const browser = { browserExecutable: job.browserExecutable, chromeMode: job.settings.chromeMode, logLevel: "error" as const };
  const composition = await selectComposition({ serveUrl, id: job.compositionId, inputProps, ...browser });
  const f = inputProps.format;
  if (composition.width !== f.width || composition.height !== f.height || composition.fps !== f.fps || composition.durationInFrames !== f.durationInFrames) {
    throw new Error(`composition metadata ${composition.width}x${composition.height}@${composition.fps} ${composition.durationInFrames}f does not match the request`);
  }
  let last = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    crf: job.settings.crf,
    pixelFormat: job.settings.pixelFormat,
    concurrency: job.settings.concurrency,
    outputLocation: job.output,
    inputProps,
    // Silent jobs stay silent (no empty audio track); narrated jobs get AAC.
    audioCodec: "aac",
    enforceAudioTrack: false,
    // Bound memory used for extracted video-clip frames on low-RAM machines.
    offthreadVideoCacheSizeInBytes: 256 * 1024 * 1024,
    offthreadVideoThreads: 1,
    ...browser,
    onProgress: ({ progress }) => {
      const p = Math.floor(progress * 10);
      if (p !== last) {
        last = p;
        say({ phase: "render", progress: Math.round(progress * 100) });
      }
    },
  });
  process.stdout.write(`CF_RESULT ${JSON.stringify({ ok: true, frames: composition.durationInFrames })}\n`);
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
