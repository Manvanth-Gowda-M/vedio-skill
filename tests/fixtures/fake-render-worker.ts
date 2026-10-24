// SIMULATED render worker for tests. It does NOT run Remotion. Modes (CF_FAKE_RENDER):
//   ok            write a real H.264 MP4 with the requested size/fps/frames (ffmpeg bundled with Remotion);
//                 when the props carry a narration track, it is muxed as AAC (as Remotion would)
//   fail          exit 1 with an error on stderr
//   no-result     exit 0 without the CF_RESULT line
//   empty         write a 0-byte file and claim success
//   garbage       write non-MP4 bytes and claim success
//   wrong-size    write a valid MP4 at half the requested size
//   drop-audio    ignore the narration track (silent output for a narrated request)
//   silent-audio  mux digital silence instead of the narration
//   add-audio     add a tone track to a request that must be silent
//   hang          start a grandchild process (pid -> CF_FAKE_PIDFILE) and wait forever
//   qa-ok         QA-plausible frames (text bars in the safe area, caption boxes while cues are active; see qa-video.ts)
//   qa-no-captions / qa-margin-text / qa-blank-scene / qa-caption-low   qa-ok with one visual defect
//   qa-damaged    qa-ok, then bytes inside mdat are overwritten (header intact: render checks pass, decoding fails)
// Each invocation is appended to CF_FAKE_LOG.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeMp4, toneWav } from "./media.ts";
import { damageMiddle, makeQaLikeVideo, type FakeProps, type QaDefect } from "./qa-video.ts";

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { output: string; propsFile: string; publicDir: string };
const props = JSON.parse(readFileSync(job.propsFile, "utf8")) as {
  format: { width: number; height: number; fps: number; durationInFrames: number };
  scenes: { video?: unknown }[];
  captions: unknown[];
  captionsTiming: string;
  audio?: { file: string };
};
const mode = process.env["CF_FAKE_RENDER"] ?? "ok";
if (process.env["CF_FAKE_LOG"]) appendFileSync(process.env["CF_FAKE_LOG"], `${JSON.stringify({ pid: process.pid, mode, scenes: props.scenes.length, captions: props.captions.length, audio: Boolean(props.audio), videos: props.scenes.filter((s) => s.video).length, timing: props.captionsTiming })}\n`);
const f = props.format;
const ok = () => process.stdout.write(`CF_RESULT ${JSON.stringify({ ok: true, frames: f.durationInFrames })}\n`);
const narration = props.audio ? path.join(job.publicDir, props.audio.file) : undefined;
const sec = f.durationInFrames / f.fps;

switch (mode) {
  case "fail":
    process.stderr.write("Error: simulated renderer crash (browser exited)\n");
    process.exitCode = 1;
    break;
  case "no-result":
    break;
  case "empty":
    writeFileSync(job.output, "");
    ok();
    break;
  case "garbage":
    writeFileSync(job.output, "this is not an mp4 file at all");
    ok();
    break;
  case "wrong-size":
    await makeMp4(job.output, f.width / 2, f.height / 2, f.fps, f.durationInFrames);
    ok();
    break;
  case "drop-audio":
    await makeMp4(job.output, f.width, f.height, f.fps, f.durationInFrames);
    ok();
    break;
  case "silent-audio":
  case "add-audio": {
    const wav = `${job.output}.alt.wav`;
    writeFileSync(wav, toneWav(sec, 16000, 440, mode === "silent-audio" ? 0 : 0.3));
    await makeMp4(job.output, f.width, f.height, f.fps, f.durationInFrames, { audioWav: wav });
    ok();
    break;
  }
  case "qa-ok":
  case "qa-no-captions":
  case "qa-margin-text":
  case "qa-blank-scene":
  case "qa-caption-low":
  case "qa-damaged": {
    const defect = (mode === "qa-ok" || mode === "qa-damaged" ? "none" : mode.slice(3)) as QaDefect;
    await makeQaLikeVideo(job.output, props as unknown as FakeProps, job.publicDir, defect);
    if (mode === "qa-damaged") await damageMiddle(job.output);
    ok();
    break;
  }
  case "hang": {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env["CF_FAKE_PIDFILE"]!, String(child.pid));
    await new Promise(() => {});
    break;
  }
  default:
    await makeMp4(job.output, f.width, f.height, f.fps, f.durationInFrames, narration ? { audioWav: narration } : {});
    ok();
}
