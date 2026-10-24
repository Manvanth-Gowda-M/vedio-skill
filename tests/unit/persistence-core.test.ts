import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  canonicalJson,
  cleanupStaleTempFiles,
  fingerprint,
  isProcessAlive,
  releaseLock,
  runCommand,
  sha256File,
  writeFileExclusive,
} from "@creatorflow/core";
import { makeTempDir } from "../helpers.ts";

describe("canonical JSON and fingerprints (cf-fp-v1)", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(fingerprint({ x: 1, y: [2, 3] })).toBe(fingerprint({ y: [2, 3], x: 1 }));
  });

  it("is sensitive to values and array order", () => {
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
    expect(fingerprint({ a: "1" })).not.toBe(fingerprint({ a: 1 }));
  });

  it("produces a stable, versioned digest", () => {
    // Pinned: sha256("cf-fp-v1\n" + '{"hello":"world"}'). A change here means FINGERPRINT_VERSION must be bumped.
    expect(fingerprint({ hello: "world" })).toBe("sha256:4e3e906795536dd11c0b21e16e234232e885d42b6f868ac45137e6e46edcb53b");
  });

  it.each([
    ["Date", { d: new Date(0) }],
    ["NaN", { n: Number.NaN }],
    ["function", { f: () => 1 }],
    ["bigint", { b: 1n }],
    ["class instance", { m: new Map() }],
  ])("rejects non-JSON values (%s)", (_l, v) => {
    expect(() => canonicalJson(v)).toThrow(TypeError);
  });

  it("hashes files", async () => {
    const t = await makeTempDir();
    try {
      const f = path.join(t.dir, "a.txt");
      await fs.writeFile(f, "abc");
      expect(await sha256File(f)).toEqual({ sha256: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: 3 });
    } finally {
      await t.cleanup();
    }
  });
});

describe("exclusive writes and temp cleanup", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("never replaces an existing file, even under concurrency", async () => {
    const f = path.join(tmp.dir, "v0001.json");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => writeFileExclusive(f, `writer ${i}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    expect(await fs.readFile(f, "utf8")).toBe(`writer ${winner}`);
    expect((await fs.readdir(tmp.dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("removes temp files only when their writer is dead", async () => {
    const dead = path.join(tmp.dir, ".job.json.999999.abcdef01.tmp");
    const mine = path.join(tmp.dir, `.job.json.${process.pid}.abcdef02.tmp`);
    const unrelated = path.join(tmp.dir, "notes.tmp");
    for (const f of [dead, mine, unrelated]) await fs.writeFile(f, "x");
    const removed = await cleanupStaleTempFiles(tmp.dir, (pid) => pid !== 999999);
    expect(removed).toEqual([path.basename(dead)]);
    expect((await fs.readdir(tmp.dir)).sort()).toEqual([path.basename(mine), "notes.tmp"].sort());
  });
});

describe("lock files", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let lockPath: string;
  beforeEach(async () => {
    tmp = await makeTempDir();
    lockPath = path.join(tmp.dir, "job.lock");
  });
  afterEach(() => tmp.cleanup());

  const fake = (info: Record<string, unknown>) => fs.writeFile(lockPath, JSON.stringify({ token: "t0", acquiredAt: "2020-01-01T00:00:00.000Z", purpose: "x", ...info }));

  it("acquires, reports held, and releases", async () => {
    const a = await acquireLock(lockPath, { purpose: "a" });
    await expect(acquireLock(lockPath, { purpose: "b" })).rejects.toMatchObject({ code: "LOCK_HELD", exitCode: 5 });
    await a.release();
    const b = await acquireLock(lockPath, { purpose: "b" });
    expect(b.recoveredStale).toBeUndefined();
    await b.release();
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("waits for a live holder when waitMs is set", async () => {
    const a = await acquireLock(lockPath, { purpose: "a" });
    setTimeout(() => void a.release(), 150);
    const b = await acquireLock(lockPath, { purpose: "b", waitMs: 3000, pollMs: 20 });
    expect(b.info.purpose).toBe("b");
    await b.release();
  });

  it("recovers a stale lock from a dead process on this host, and says so", async () => {
    await fake({ pid: 424242, hostname: "this-host" });
    const l = await acquireLock(lockPath, { purpose: "resume", hostname: "this-host", isAlive: () => false });
    expect(l.recoveredStale).toMatchObject({ pid: 424242 });
    expect((await fs.readdir(tmp.dir)).filter((n) => n.includes("stale"))).toEqual([]);
    await l.release();
  });

  it("never breaks a lock just because it is old: live owner or another host", async () => {
    await fake({ pid: 424242, hostname: "this-host" });
    await expect(acquireLock(lockPath, { purpose: "x", hostname: "this-host", isAlive: () => true })).rejects.toMatchObject({ code: "LOCK_HELD" });
    await fake({ pid: 424242, hostname: "other-host" });
    await expect(acquireLock(lockPath, { purpose: "x", hostname: "this-host", isAlive: () => false })).rejects.toMatchObject({ code: "LOCK_HELD" });
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).hostname).toBe("other-host");
  });

  it("refuses unreadable locks and foreign releases", async () => {
    await fs.writeFile(lockPath, "garbage");
    await expect(acquireLock(lockPath, { purpose: "x" })).rejects.toMatchObject({ code: "LOCK_UNREADABLE" });
    await fake({ pid: 1, hostname: "h", token: "theirs" });
    await expect(releaseLock(lockPath, "mine")).rejects.toMatchObject({ code: "LOCK_NOT_OWNED" });
    expect(await fs.readFile(lockPath, "utf8")).toContain("theirs");
  });

  it("detects real dead processes", async () => {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => child.on("exit", r));
    expect(isProcessAlive(child.pid!)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe("runCommand with AbortSignal", () => {
  it("kills the child process on abort (no orphan left running)", async () => {
    const t = await makeTempDir();
    try {
      const pidFile = path.join(t.dir, "pid");
      const ac = new AbortController();
      const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const run = runCommand(process.execPath, ["-e", script], { signal: ac.signal, timeoutMs: 60_000 });
      for (let i = 0; i < 200 && !(await fs.stat(pidFile).catch(() => undefined)); i++) await new Promise((r) => setTimeout(r, 20));
      const pid = Number(await fs.readFile(pidFile, "utf8"));
      expect(isProcessAlive(pid)).toBe(true);
      ac.abort();
      expect((await run).errorCode).toBe("ABORTED");
      for (let i = 0; i < 100 && isProcessAlive(pid); i++) await new Promise((r) => setTimeout(r, 20));
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      await t.cleanup();
    }
  });
});
