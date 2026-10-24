/**
 * Pure consistency checks used by the QA step. Each returns a list of problems
 * (empty = pass). They re-use the existing validators' data and helpers; they
 * do not re-judge facts (that is validateScriptAgainstEvidence's job).
 */
import type { AssetResolution, CanonicalScript, NarrationRecord, QaCheck, RenderRequest, SceneManifest, SubtitleTrack } from "@creatorflow/schemas";
import { checkSubtitleTrack, graphemeLength, preservesText } from "@creatorflow/scriptwriter";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The output must belong to this job and to the approved item. A newer plan
 * version that left this item unchanged keeps the render valid (the item hash
 * is the binding, as in the workflow engine); a changed item does not.
 */
export function planProblems(x: {
  jobId: string;
  approved: { weekId: string; version: number; contentHash: string };
  itemHash: string;
  report: { jobId: string; plan: { weekId: string; version: number } };
  script: Pick<CanonicalScript, "jobId" | "plan">;
  manifest: Pick<SceneManifest, "jobId" | "plan">;
}): { problems: string[]; notes: string[] } {
  const p: string[] = [];
  const notes: string[] = [];
  if (x.report.jobId !== x.jobId || x.script.jobId !== x.jobId || x.manifest.jobId !== x.jobId) p.push("report, script or manifest belongs to another job");
  if (x.report.plan.weekId !== x.approved.weekId || x.script.plan.weekId !== x.approved.weekId) p.push("output belongs to another week");
  if (x.script.plan.itemHash !== x.itemHash) p.push("the approved plan item changed after the script was written (stale plan)");
  if (x.manifest.plan.itemHash !== x.script.plan.itemHash || x.manifest.plan.contentHash !== x.script.plan.contentHash) p.push("scene manifest and script were made under different plans (stale manifest)");
  if (x.script.plan.version > x.approved.version || x.report.plan.version > x.approved.version) p.push("output claims a plan version newer than the approved one");
  if (!p.length && x.report.plan.version !== x.approved.version) notes.push(`rendered under plan v${x.report.plan.version}; approved is v${x.approved.version} with this item unchanged`);
  return { problems: p, notes };
}

export function captionTextProblems(segments: readonly { segmentId: string; narration: string }[], track: SubtitleTrack): string[] {
  const p: string[] = [];
  for (const seg of segments) {
    const lines = track.cues.filter((c) => c.segmentId === seg.segmentId).flatMap((c) => c.lines);
    if (!lines.length) p.push(`${seg.segmentId} has no caption`);
    else if (!preservesText(seg.narration, lines)) p.push(`${seg.segmentId} captions differ from the approved script text`);
  }
  for (const c of track.cues) if (!segments.some((s) => s.segmentId === c.segmentId)) p.push(`${c.cueId} belongs to unknown segment ${c.segmentId}`);
  return p;
}

export function captionTimingProblems(track: SubtitleTrack, durationMs: number): string[] {
  return [...checkSubtitleTrack(track), ...track.cues.filter((c) => c.startMs < 0 || c.endMs > durationMs + 1).map((c) => `${c.cueId} (${c.startMs}–${c.endMs} ms) is outside the video (0–${Math.round(durationMs)} ms)`)];
}

export function captionCoverageProblems(narration: Pick<NarrationRecord, "segments">, track: SubtitleTrack): string[] {
  const p: string[] = [];
  for (const seg of narration.segments) for (const s of seg.sentences) if (!track.cues.some((c) => c.segmentId === seg.segmentId && c.startMs < s.speechEndMs && c.endMs > s.speechStartMs)) p.push(`${seg.segmentId} sentence ${s.index + 1} (${s.speechStartMs}–${s.speechEndMs} ms) has no caption on screen while spoken`);
  return p;
}

export function captionMethodProblems(narrated: boolean, track: SubtitleTrack["timing"], reported: string, requested: string | undefined, renderValidation?: { ok: boolean; problems: string[] }): string[] {
  const p: string[] = [];
  const expected = narrated ? "sentence-aligned" : "estimated";
  if (track !== expected) p.push(`track timing is "${track}", expected "${expected}" for a ${narrated ? "narrated" : "silent"} job`);
  if (reported !== track) p.push(`render report says "${reported}", track says "${track}"`);
  if (requested && requested !== track) p.push(`render request says "${requested}"`);
  if (track === "word-aligned") p.push("word-aligned timing is claimed, but no CreatorFlow component produces word timestamps");
  if (renderValidation && !renderValidation.ok) p.push(`render-time caption validation failed: ${renderValidation.problems.join("; ")}`);
  return p;
}

export function captionLineProblems(track: SubtitleTrack, S: { maxCharsPerLine: number; maxLines: number }): { fail: string[]; warn: string[] } {
  const fail: string[] = [];
  const warn: string[] = [];
  for (const c of track.cues) {
    if (c.lines.length > S.maxLines) fail.push(`${c.cueId} has ${c.lines.length} lines (max ${S.maxLines})`);
    for (const l of c.lines) if (graphemeLength(l) > S.maxCharsPerLine) (l.trim().includes(" ") ? fail : warn).push(`${c.cueId}: "${l.slice(0, 40)}…" is ${graphemeLength(l)} characters (max ${S.maxCharsPerLine})`);
  }
  return { fail, warn };
}

/** Required source attributions are drawn as the scene source label; required asset attributions must have text. */
export function attributionProblems(manifest: Pick<SceneManifest, "attributions" | "scenes">, scriptAttributions: CanonicalScript["attributions"], resolution: Pick<AssetResolution, "assets">, renderedSceneIds: readonly string[]): string[] {
  const p: string[] = [];
  const label = new Map(scriptAttributions.map((a) => [a.sourceId, a.publisher ?? a.title]));
  for (const a of manifest.attributions.filter((x) => x.required)) {
    if (!a.sceneIds.length) p.push(`required attribution for ${a.sourceId} is not shown in any scene`);
    for (const sid of a.sceneIds) {
      const s = manifest.scenes.find((x) => x.sceneId === sid);
      const l = label.get(a.sourceId) ?? a.text;
      if (!s || !renderedSceneIds.includes(sid)) p.push(`${sid} (attribution for ${a.sourceId}) is not rendered`);
      else if (!s.text.secondary?.includes(l)) p.push(`${sid} should show "Source: ${l}" but shows "${s.text.secondary ?? "nothing"}"`);
    }
  }
  for (const a of resolution.assets) if (a.provenance?.attributionRequired && !a.attribution) p.push(`asset ${a.assetId} requires attribution but none was drawn`);
  return p;
}

export function sceneTimelineProblems(rendered: RenderRequest["scenes"], manifestScenes: readonly { sceneId: string }[], timeline: NarrationRecord["timing"]["scenes"], totalFrames: number): string[] {
  const p: string[] = [];
  if (rendered.map((s) => s.sceneId).join() !== manifestScenes.map((s) => s.sceneId).join()) p.push(`rendered scene order ${rendered.map((s) => s.sceneId).join(",")} differs from the manifest ${manifestScenes.map((s) => s.sceneId).join(",")}`);
  let f = 0;
  for (const s of rendered) {
    if (s.startFrame !== f) p.push(`${s.sceneId} starts at ${s.startFrame}, expected ${f}`);
    f += s.durationInFrames;
    const t = timeline.find((x) => x.sceneId === s.sceneId);
    if (!t || t.startFrame !== s.startFrame || t.durationInFrames !== s.durationInFrames) p.push(`${s.sceneId} timing differs from the verified timeline`);
  }
  if (f !== totalFrames) p.push(`scenes cover ${f} frames, the video has ${totalFrames}`);
  return p;
}

export function narrationTextProblems(segments: readonly { segmentId: string; narration: string }[], narration: Pick<NarrationRecord, "segments" | "script">, scriptSha256: string): string[] {
  const p: string[] = [];
  if (narration.script.sha256 !== scriptSha256) p.push("narration was made from a different script");
  for (const seg of segments) {
    const n = narration.segments.find((x) => x.segmentId === seg.segmentId);
    if (!n) p.push(`${seg.segmentId} was not narrated`);
    else if (norm(n.sentences.map((s) => s.text).join(" ")) !== norm(seg.narration)) p.push(`${seg.segmentId}: narrated text differs from the script`);
  }
  for (const n of narration.segments) if (!segments.some((s) => s.segmentId === n.segmentId)) p.push(`${n.segmentId} was narrated but is not in the script`);
  return p;
}

/** Overall verdict: any required FAIL -> failed; any required BLOCKED/NOT_INSPECTED -> blocked; else passed. */
export function technicalVerdict(checks: readonly Pick<QaCheck, "id" | "required" | "status" | "detail">[]): { status: "passed" | "failed" | "blocked"; reasons: string[] } {
  const req = checks.filter((c) => c.required);
  const failed = req.filter((c) => c.status === "FAIL");
  const missing = req.filter((c) => c.status === "BLOCKED" || c.status === "NOT_INSPECTED");
  return { status: failed.length ? "failed" : missing.length ? "blocked" : "passed", reasons: [...failed.map((c) => `${c.id}: ${c.detail}`), ...missing.map((c) => `${c.id} ${c.status}: ${c.detail}`)] };
}
