/**
 * Tests for LockManager (#625).
 *
 * Covers stale-detection matrix, atomic acquire, --force semantics,
 * orchestrator no-op, error message format, and `locks list/clear`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  LockManager,
  classifyStaleness,
  formatLockedMessage,
  defaultIsPidAlive,
  resolveLocksDir,
} from "./lock-manager.js";
import { DEFAULT_STALE_AGE_MS } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sequant-locks-test-"));
}

describe("classifyStaleness", () => {
  const baseHolder = {
    pid: 1234,
    hostname: "host-a",
    startedAt: new Date("2026-05-11T00:00:00Z").toISOString(),
    command: "npx sequant run 1",
  };

  it("returns null when same-host PID is alive", () => {
    const result = classifyStaleness({
      holder: baseHolder,
      myHostname: "host-a",
      now: new Date("2026-05-11T00:10:00Z").getTime(),
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      isPidAlive: () => true,
    });
    expect(result).toBeNull();
  });

  it("returns 'pid-dead' when same-host PID is not alive", () => {
    const result = classifyStaleness({
      holder: baseHolder,
      myHostname: "host-a",
      now: new Date("2026-05-11T00:01:00Z").getTime(),
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      isPidAlive: () => false,
    });
    expect(result).toBe("pid-dead");
  });

  it("ignores PID across hosts; returns null when age is within window", () => {
    const result = classifyStaleness({
      holder: baseHolder,
      myHostname: "host-b",
      now: new Date("2026-05-11T00:30:00Z").getTime(),
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      isPidAlive: () => false, // ignored
    });
    expect(result).toBeNull();
  });

  it("returns 'age-exceeded' across hosts when older than staleAgeMs", () => {
    const result = classifyStaleness({
      holder: baseHolder,
      myHostname: "host-b",
      now: new Date("2026-05-11T03:00:00Z").getTime(), // 3h later
      staleAgeMs: DEFAULT_STALE_AGE_MS, // 2h
      isPidAlive: () => true,
    });
    expect(result).toBe("age-exceeded");
  });
});

describe("formatLockedMessage", () => {
  it("matches the AC-specified format", () => {
    const msg = formatLockedMessage(604, {
      pid: 12345,
      hostname: "Tambras-MacBook-Air.local",
      startedAt: "2026-05-10T14:32:00Z",
      command: "npx sequant fullsolve 604",
    });
    expect(msg).toBe(
      "Issue #604 is being worked on by PID 12345 since 2026-05-10T14:32:00Z " +
        "(npx sequant fullsolve 604). Use --force to take over, or wait for " +
        "the other session.",
    );
  });
});

describe("LockManager — acquire / release", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    delete process.env.SEQUANT_ORCHESTRATOR;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .sequant/locks/ on demand and acquires", () => {
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.acquire(42, "test-cmd");
    expect(result.acquired).toBe(true);
    expect(existsSync(join(dir, "42.lock"))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(dir, "42.lock"), "utf-8"));
    expect(parsed.pid).toBe(1);
    expect(parsed.hostname).toBe("host-a");
    expect(parsed.command).toBe("test-cmd");
  });

  it("second acquire from a different PID is blocked", () => {
    const a = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const b = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 2,
      isPidAlive: () => true,
    });
    expect(a.acquire(42, "first").acquired).toBe(true);
    const second = b.acquire(42, "second");
    expect(second.acquired).toBe(false);
    if (second.acquired === false) {
      expect(second.holder.pid).toBe(1);
    }
  });

  it("auto-clears same-host stale (PID-dead) lock", () => {
    // Pre-write a stale lock for PID 9999 (dead).
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "old",
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: (pid) => pid === 1, // 9999 dead, 1 alive
    });
    const result = mgr.acquire(42, "new");
    expect(result.acquired).toBe(true);
    const after = JSON.parse(readFileSync(join(dir, "42.lock"), "utf-8"));
    expect(after.pid).toBe(1);
  });

  it("cross-host fresh lock blocks acquisition", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "remote-host",
        startedAt: new Date(Date.now() - 60_000).toISOString(), // 1m ago
        command: "remote",
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      isPidAlive: () => true,
    });
    const result = mgr.acquire(42, "new");
    expect(result.acquired).toBe(false);
  });

  it("cross-host beyond 2h is cleared", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "remote-host",
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h
        command: "remote",
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.acquire(42, "new");
    expect(result.acquired).toBe(true);
  });

  it("release removes the lock when held by this process", () => {
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    expect(mgr.acquire(42, "x").acquired).toBe(true);
    mgr.release(42);
    expect(existsSync(join(dir, "42.lock"))).toBe(false);
  });

  it("release is a no-op when another process holds the lock", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "x",
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    mgr.release(42);
    expect(existsSync(join(dir, "42.lock"))).toBe(true);
  });

  it("releaseAll releases every held lock", () => {
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    mgr.acquire(1, "a");
    mgr.acquire(2, "b");
    mgr.acquire(3, "c");
    mgr.releaseAll();
    expect(existsSync(join(dir, "1.lock"))).toBe(false);
    expect(existsSync(join(dir, "2.lock"))).toBe(false);
    expect(existsSync(join(dir, "3.lock"))).toBe(false);
  });
});

describe("LockManager — forceAcquire / signalOther", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    delete process.env.SEQUANT_ORCHESTRATOR;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("forceAcquire overwrites an existing fresh lock", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 555,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "old",
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.forceAcquire(42, "new");
    expect(result.previous?.pid).toBe(555);
    const after = JSON.parse(readFileSync(join(dir, "42.lock"), "utf-8"));
    expect(after.pid).toBe(1);
    expect(after.command).toBe("new");
  });

  it("signalOther only signals same-host alive PIDs", () => {
    const calls: number[] = [];
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: (pid) => pid === 9999,
    });
    // Same-host alive — pretend signal succeeds by stubbing process.kill.
    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
    ) => {
      calls.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const sent = mgr.signalOther({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "x",
      });
      expect(sent).toBe(true);
      expect(calls).toEqual([9999]);

      // Cross-host: should NOT signal.
      calls.length = 0;
      const sent2 = mgr.signalOther({
        pid: 9999,
        hostname: "other-host",
        startedAt: new Date().toISOString(),
        command: "x",
      });
      expect(sent2).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });
});

describe("LockManager — orchestrator no-op", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SEQUANT_ORCHESTRATOR;
  });

  it("does not touch the filesystem when orchestratorMode is true", () => {
    const mgr = new LockManager({ locksDir: dir, orchestratorMode: true });
    const result = mgr.acquire(42, "x");
    expect(result.acquired).toBe(true);
    // Lock dir may already exist (from mkdtempSync), but no lock file
    // should be written when orchestratorMode is true.
    expect(existsSync(join(dir, "42.lock"))).toBe(false);
    mgr.release(42);
    mgr.releaseAll();
    expect(mgr.list()).toEqual([]);
    expect(mgr.check(42)).toBeNull();
  });

  it("honors SEQUANT_ORCHESTRATOR env var by default", () => {
    process.env.SEQUANT_ORCHESTRATOR = "1";
    const mgr = new LockManager({ locksDir: dir });
    expect(mgr.isNoop).toBe(true);
    const result = mgr.acquire(42, "x");
    expect(result.acquired).toBe(true);
    expect(existsSync(join(dir, "42.lock"))).toBe(false);
  });
});

describe("LockManager — list / clearLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    delete process.env.SEQUANT_ORCHESTRATOR;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("list returns all active locks with staleness flags", () => {
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: (pid) => pid !== 9999, // 9999 is dead
    });
    mgr.acquire(1, "cmd-1");
    writeFileSync(
      join(dir, "2.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "dead",
      }),
    );
    const list = mgr.list();
    expect(list).toHaveLength(2);
    const byIssue = Object.fromEntries(list.map((l) => [l.issue, l]));
    expect(byIssue[1].stale).toBe(false);
    expect(byIssue[2].stale).toBe(true);
    expect(byIssue[2].staleReason).toBe("pid-dead");
  });

  it("clearLock refuses fresh same-host alive locks by default", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "x",
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.clearLock(42);
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("fresh-same-host-alive");
    expect(existsSync(join(dir, "42.lock"))).toBe(true);
  });

  it("clearLock with safetyCheck=false clears unconditionally", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "x",
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.clearLock(42, { safetyCheck: false });
    expect(result.cleared).toBe(true);
    expect(existsSync(join(dir, "42.lock"))).toBe(false);
  });

  it("clearLock returns no-lock for missing files", () => {
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.clearLock(42);
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe("no-lock");
  });
});

describe("resolveLocksDir / SEQUANT_LOCKS_DIR", () => {
  afterEach(() => {
    delete process.env.SEQUANT_LOCKS_DIR;
  });

  it("explicit option wins", () => {
    process.env.SEQUANT_LOCKS_DIR = "/tmp/env";
    expect(resolveLocksDir("/tmp/explicit")).toBe("/tmp/explicit");
  });

  it("falls back to SEQUANT_LOCKS_DIR", () => {
    process.env.SEQUANT_LOCKS_DIR = "/tmp/env";
    expect(resolveLocksDir()).toBe("/tmp/env");
  });

  it("defaults to .sequant/locks", () => {
    delete process.env.SEQUANT_LOCKS_DIR;
    expect(resolveLocksDir().endsWith(".sequant/locks")).toBe(true);
  });
});

describe("defaultIsPidAlive", () => {
  it("returns true for self pid", () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });

  it("returns false for invalid pids", () => {
    expect(defaultIsPidAlive(-1)).toBe(false);
    expect(defaultIsPidAlive(0)).toBe(false);
    expect(defaultIsPidAlive(Number.NaN)).toBe(false);
  });

  it("returns false for a pid unlikely to exist", () => {
    // 2^22 - 1 is above typical pid_max on most kernels.
    expect(defaultIsPidAlive(4194303)).toBe(false);
  });
});
