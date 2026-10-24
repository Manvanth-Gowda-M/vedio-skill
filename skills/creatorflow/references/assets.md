# Assets: registration, provenance and video clips

Every file a video shows (diagram, screenshot, code text, screen recording, B-roll) must be registered in `workspace/assets/registry.json` with `creatorflow assets`. Do not edit that file by hand. Nothing is ever downloaded or copied for you: put the file inside `workspace/assets/` first.

## Commands

```sh
creatorflow storyboard inspect --job <job>     # lists the scene slots, e.g. ast-scn-03-diagram (required)
creatorflow assets register --file workspace/assets/diagrams/flow.png --type diagram \
  --job <job> --slot ast-scn-03-diagram --origin user-created --license "own work" --attest
creatorflow assets register --file workspace/assets/captures/terminal.mp4 --type screen-recording \
  --job <job> --slot ast-scn-02-screen-recording --start 1.5 --end 9 --fit contain --origin user-created
creatorflow assets list [--job <job>] [--type <type>]
creatorflow assets inspect --id ast-terminal          # re-checks the file now and lists the slots that use it
creatorflow assets update --id ast-terminal --use <job>:<slot> --start 2 --end 8      # attach / change trim
creatorflow assets update --id ast-terminal --unuse <job>:<slot>                      # detach
creatorflow assets update --id ast-flow --license CC-BY-4.0 --attribution "Diagram: A. Person" --attribution-required
creatorflow assets update --id ast-flow --refresh     # accept an intended change of the file's content
creatorflow assets validate [--id <id>]
creatorflow assets remove --id ast-flow               # refused while any slot uses it; never deletes the file
creatorflow assets recover                            # restore a corrupt registry.json from registry.prev.json
```

Types: `diagram`, `screenshot`, `code-snippet`, `logo`, `icon`, `other` (images; code text for `code-snippet`) and `screen-recording`, `b-roll` (video). A video type can only fill a video slot and vice versa.

Exit codes: `0` ok; `1` the file failed a check (wrong content, corrupt, unsupported codec, invalid clip, registry corrupt); `2` bad flags; `3` media tools missing; `4` path outside `workspace/assets/`, symlink, or junction leading out; `5` conflict (duplicate content, slot already filled, asset still in use, registry changed by another process); `6` not found.

## What registration checks (from the bytes, never from the extension alone)

| Media | Accepted | Checks |
|---|---|---|
| Image | `.png` `.jpg` `.jpeg` `.webp`, ≤ `assets.maxImageBytes` (25 MiB) | magic bytes match the extension; dimensions readable from the header |
| Code text | `.txt` `.md` for `code-snippet`, ≤ 1 MiB | valid UTF-8, no NUL |
| Video | `.mp4` `.m4v` `.mov` (ISO-BMFF) and `.webm` `.mkv` (Matroska) | container sniffed from the header and matched to the extension; ffprobe: a video stream, codec in `assets.videoCodecs` (default h264, vp8, vp9), width/height/fps/duration within limits, audio stream presence, rotation metadata; then **ffmpeg decodes every frame** (`assets.decodeCheck: "full"`, or first/last second with `"sample"`) so truncated or damaged files are rejected |

Every file: regular file (no symlinks), inside `workspace/assets/` after resolving links, non-empty, sha256 of the actual bytes. Identical content registered twice is refused with the existing id (`ASSET_DUPLICATE`); one asset may fill several slots with `--use`.

Video limits (config `assets`): `maxVideoBytes` 512 MiB, `maxVideoDurationSec` 600, `maxVideoWidth`×`maxVideoHeight` 3840×2160, `maxVideoFps` 120, `probeTimeoutMs` 180000. Files over a limit are rejected with the limit named. CreatorFlow never trims, transcodes or truncates your files; re-encode or cut them yourself (e.g. to H.264) if needed. HEVC and AV1 are off by default because they were not tested.

Before every render the assets step re-measures each bound file (it never trusts the stored media data) and re-checks the hash. The render step hashes the staged copy again.

## Provenance and licences are claims

Each asset records `origin` (`user-created`, `user-provided`, `public-domain-claim`, `open-license-claim`, `unknown`), and optionally `creator`, `sourceUrl` (recorded, **never fetched**), `license`, `attribution`, `attributionRequired`, `obtainedAt`, `notes`. `verification` is `unverified`, or `user-attested` when `--attest` was given. CreatorFlow cannot check ownership or licences: registration does not mean a file is cleared for publication.

- `--origin open-license-claim` or `public-domain-claim` needs `--license`. Open-licence claims default to `attributionRequired: true`.
- A required attribution without text blocks the job (`ATTRIBUTION_MISSING`). Attribution text is drawn verbatim at the top of the scene and must pass the brand font's glyph check.
- An unknown licence is a warning in the asset resolution and render report, not an error.
- Only register files the user has confirmed they may use. Never invent a creator, licence or source.

## Video scenes

- `screen-capture` scenes (tutorials) need a registered video in their `screen-recording` slot. Without one the job blocks (`ASSETS_MISSING`); it is never replaced by a blank or unrelated image.
- Clip window: `--start`/`--end` (seconds in the source; default whole file) and `--fit contain` (letterbox, default) or `cover` (crop the centre). A window past the end of the source is an error, not a clamp.
- The clip plays muted (narration is the only audio). If the scene is longer than the window, the last frame is held; if shorter, the rest of the window is not shown. Both are recorded as warnings in the render request and report (`videoClips`).
- ScreenCapture and CodeDemo scenes show the video in a frame inside the safe area, with captions below. In other scene types a video is a dimmed backdrop behind the text.
- Rendering uses Remotion's `OffthreadVideo` (frames extracted by the compositor, cache limited to 256 MB, one thread).

## Invalidation

The assets step fingerprints only the registry entries bound to *its* job, plus each bound file's size and modification time. Registering, editing or removing an unrelated asset does not re-render other jobs. A changed trim, licence, attribution or file re-runs assets → queue-render → render for that job only; research, script and narration are untouched.

## Registry file and recovery

`registry.json` (schemaVersion 2) is written under a lock with compare-and-swap: if the file changes while a command runs, the command fails with `REGISTRY_CONFLICT` and nothing is written. The previous version is kept as `registry.prev.json`. A corrupt registry is never overwritten; `assets recover` restores the backup and keeps the corrupt file as `registry.json.corrupt-<time>`. A Stage F registry (schemaVersion 1) is still read; the first `register`/`update`/`remove` migrates it (provenance `unknown`, `unverified`) and keeps the original as `registry.v1.json`.
