import { describe, expect, it } from "vitest";
import { LIFECYCLE_STATES, VideoState, type JobRecord, type LifecycleState } from "@creatorflow/schemas";
import { applyTransition, checkTransition, definePipeline, rank, type StepDefinition } from "@creatorflow/orchestrator";

const ALL = VideoState.options;
const L = LIFECYCLE_STATES;

/** Independent restatement of the rules, used to check every one of the 121 pairs. */
function expected(from: string, to: string, resume?: LifecycleState): boolean {
  if (from === to) return false;
  const li = (s: string) => (L as readonly string[]).indexOf(s);
  const fromL = li(from) >= 0;
  const toL = li(to) >= 0;
  if (fromL && toL) return li(to) === li(from) + 1 || li(to) < li(from);
  if (fromL) return from !== "PACKAGE_READY";
  if (!toL || !resume) return false;
  return li(to) <= li(resume);
}

describe("state transition rules", () => {
  it("covers all 13 states", () => {
    expect(ALL).toHaveLength(13);
  });

  for (const from of ALL) {
    for (const to of ALL) {
      it(`${from} -> ${to}`, () => {
        // For BLOCKED/FAILED, test with the most permissive resumeState; restrictions are tested below.
        const resume = from === "BLOCKED" || from === "FAILED" ? ("QA_PASSED" as const) : undefined;
        expect(checkTransition(from, to, resume).ok).toBe(expected(from, to, resume));
      });
    }
  }

  it("classifies kinds", () => {
    expect(checkTransition("PLANNED", "RESEARCHED")).toEqual({ ok: true, kind: "advance" });
    expect(checkTransition("RENDERED", "RESEARCHED")).toEqual({ ok: true, kind: "invalidate" });
    expect(checkTransition("SCRIPTED", "BLOCKED")).toEqual({ ok: true, kind: "block" });
    expect(checkTransition("SCRIPTED", "FAILED")).toEqual({ ok: true, kind: "fail" });
    expect(checkTransition("BLOCKED", "SCRIPTED", "SCRIPTED")).toEqual({ ok: true, kind: "unblock" });
    expect(checkTransition("FAILED", "PLANNED", "SCRIPTED")).toEqual({ ok: true, kind: "retry" });
  });

  it("BLOCKED/FAILED may only return to their resumeState or earlier", () => {
    for (const special of ["BLOCKED", "FAILED"] as const) {
      expect(checkTransition(special, "SCRIPTED").ok).toBe(false); // no resumeState
      for (const to of L) {
        expect(checkTransition(special, to, "SCRIPTED").ok).toBe(rank(to) <= rank("SCRIPTED"));
      }
    }
  });

  it("explains rejections", () => {
    const r = checkTransition("PLANNED", "SCRIPTED");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("skips RESEARCHED");
  });
});

function job(state: JobRecord["state"], extra: Partial<JobRecord> = {}): JobRecord {
  return {
    schemaVersion: 1,
    kind: "video-job",
    jobId: "2026-w44-a",
    contentId: "a",
    weekId: "2026-W44",
    revision: 0,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    state,
    currentStep: null,
    lastSuccessfulStep: null,
    planRef: { version: 1, planHash: `sha256:${"0".repeat(64)}`, itemHash: `sha256:${"1".repeat(64)}` },
    steps: {},
    artifacts: {},
    history: [],
    ...extra,
  };
}

describe("applyTransition", () => {
  const at = "2026-10-22T10:00:00.000Z";

  it("records history and BLOCKED/FAILED details, and clears them on exit", () => {
    const j = job("RESEARCHED");
    applyTransition(j, "BLOCKED", { at, step: "script", blocked: { code: "NEEDS_SOURCES", reason: "no sources" } });
    expect(j).toMatchObject({ state: "BLOCKED", resumeState: "RESEARCHED", blocked: { step: "script", code: "NEEDS_SOURCES", since: at } });
    applyTransition(j, "RESEARCHED", { at, step: "script", reason: "sources added" });
    expect(j.state).toBe("RESEARCHED");
    expect(j.blocked).toBeUndefined();
    expect(j.resumeState).toBeUndefined();
    applyTransition(j, "FAILED", { at, step: "script", failure: { kind: "permanent", code: "X", message: "bad" } });
    expect(j.failure).toMatchObject({ kind: "permanent", step: "script" });
    expect(j.history.map((e) => `${e.from}->${e.to}`)).toEqual(["RESEARCHED->BLOCKED", "BLOCKED->RESEARCHED", "RESEARCHED->FAILED"]);
    expect(j.history[0]!.reason).toBe("block: no sources");
  });

  it("throws a stable ILLEGAL_TRANSITION error and leaves the job unchanged", () => {
    const j = job("PLANNED");
    expect(() => applyTransition(j, "RENDERED", { at })).toThrow(expect.objectContaining({ code: "ILLEGAL_TRANSITION", exitCode: 70 }));
    expect(j.state).toBe("PLANNED");
    expect(j.history).toEqual([]);
  });
});

describe("definePipeline", () => {
  const ok = (over: Partial<StepDefinition> = {}): StepDefinition => ({
    id: "research",
    version: 1,
    from: "PLANNED",
    to: "RESEARCHED",
    outputs: [{ path: "research/out.json" }],
    unavailableReason: "n/a",
    ...over,
  });

  it("accepts a contiguous chain starting at PLANNED", () => {
    expect(definePipeline("p", [ok(), ok({ id: "script", from: "RESEARCHED", to: "SCRIPTED", outputs: [{ path: "s.json" }] })]).steps).toHaveLength(2);
  });

  it.each([
    ["not starting at PLANNED", [ok({ from: "RESEARCHED", to: "SCRIPTED" })]],
    ["skipping a milestone", [ok({ to: "SCRIPTED" })]],
    ["a gap between steps", [ok(), ok({ id: "b", from: "SCRIPTED", to: "LOCALIZED", outputs: [{ path: "b.json" }] })]],
    ["no outputs", [ok({ outputs: [] })]],
    ["output path traversal", [ok({ outputs: [{ path: "../escape.json" }] })]],
    ["absolute output path", [ok({ outputs: [{ path: "C:/x.json" }] })]],
    ["duplicate step ids", [ok(), ok({ from: "RESEARCHED", to: "SCRIPTED", outputs: [{ path: "x.json" }] })]],
    ["no executor and no reason", [ok({ unavailableReason: undefined })]],
    ["bad version", [ok({ version: 0 })]],
  ])("rejects %s", (_label, steps) => {
    expect(() => definePipeline("p", steps as StepDefinition[])).toThrow(expect.objectContaining({ code: "PIPELINE_INVALID" }));
  });
});
