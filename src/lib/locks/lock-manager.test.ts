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
  stealStaleLock,
} from "./lock-manager.js";
import { DEFAULT_MAX_LOCK_AGE_MS, DEFAULT_STALE_AGE_MS } from "./types.js";

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

  // ── #856: recycled PIDs must not read as fresh forever ────────────────
  describe("absolute age ceiling (#856)", () => {
    it("returns 'max-age-exceeded' for a same-host lock whose PID is alive but is older than 24h", () => {
      // The exact production shape: `.sequant/locks/505.lock`, written
      // 2026-05-14, PID 28809 long since recycled onto an unrelated live
      // process. Before the ceiling this returned null — fresh — forever,
      // permanently blocking #505 from ever running again.
      const result = classifyStaleness({
        holder: baseHolder,
        myHostname: "host-a", // same host
        now: new Date("2026-07-25T00:00:00Z").getTime(), // ~75 days later
        staleAgeMs: DEFAULT_STALE_AGE_MS,
        isPidAlive: () => true, // recycled PID answers "alive"
      });
      expect(result).toBe("max-age-exceeded");
    });

    it("still returns null for a same-host live PID inside the ceiling", () => {
      const result = classifyStaleness({
        holder: baseHolder,
        myHostname: "host-a",
        now: new Date("2026-05-11T20:00:00Z").getTime(), // 20h — under 24h
        staleAgeMs: DEFAULT_STALE_AGE_MS,
        isPidAlive: () => true,
      });
      expect(result).toBeNull();
    });

    it("overrides the 6h skill-shell TTL as well", () => {
      const result = classifyStaleness({
        holder: { ...baseHolder, skipPidCheck: true },
        myHostname: "host-a",
        now: new Date("2026-05-13T00:00:00Z").getTime(), // 48h
        staleAgeMs: DEFAULT_STALE_AGE_MS,
        skillLockTtlMs: 6 * 60 * 60 * 1000,
        maxLockAgeMs: DEFAULT_MAX_LOCK_AGE_MS,
        isPidAlive: () => true,
      });
      // Both rules fire; the ceiling is checked first and names the real
      // reason — this lock is not merely past a TTL, it is abandoned.
      expect(result).toBe("max-age-exceeded");
    });

    it("honours an explicit maxLockAgeMs override", () => {
      const result = classifyStaleness({
        holder: baseHolder,
        myHostname: "host-a",
        now: new Date("2026-05-11T00:10:00Z").getTime(), // 10 min
        staleAgeMs: DEFAULT_STALE_AGE_MS,
        maxLockAgeMs: 60_000, // 1 min ceiling
        isPidAlive: () => true,
      });
      expect(result).toBe("max-age-exceeded");
    });

    it("does not fire when startedAt is unparseable", () => {
      const result = classifyStaleness({
        holder: { ...baseHolder, startedAt: "not-a-date" },
        myHostname: "host-a",
        now: Date.now(),
        staleAgeMs: DEFAULT_STALE_AGE_MS,
        isPidAlive: () => true,
      });
      // Unknown age must not be treated as infinitely old — that would clear
      // a live holder's lock on a malformed timestamp.
      expect(result).toBeNull();
    });
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

describe("LockManager — #908: stale steal is compare-and-swap", () => {
  // Shared `stealStaleLock` with CheckoutLock (AC-2). The old steal unlinked
  // `lockPath` unconditionally, so a session that classified L0 stale would
  // remove whatever sat there later — including a fresh lock a winner created
  // in the window — and both would "win". Drive that window by hand: the
  // multi-process race test can't (acquire's read serializes CLI startup).

  type WriteAtomic = (
    issue: number,
    lockPath: string,
    command: string,
    skipPidCheck?: boolean,
  ) => { acquired: boolean; holder?: { pid: number } };

  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const STALE = {
    pid: 9999,
    hostname: "host-a",
    startedAt: new Date(0).toISOString(),
  };

  function seedStale(lockPath: string): void {
    writeFileSync(
      lockPath,
      JSON.stringify({ ...STALE, command: "/abandoned" }),
    );
  }

  it("a loser cannot remove the winner's fresh lock (documented ordering)", () => {
    const a = new LockManager({ locksDir: dir, hostname: "host-a", pid: 1 });
    const b = new LockManager({ locksDir: dir, hostname: "host-a", pid: 2 });
    const writeA = (
      a as unknown as { writeAtomic: WriteAtomic }
    ).writeAtomic.bind(a);
    const writeB = (
      b as unknown as { writeAtomic: WriteAtomic }
    ).writeAtomic.bind(b);
    const path = a.lockPathFor(42);

    seedStale(path);

    // A.steal → A.create.
    expect(stealStaleLock(path, STALE, { pid: 1, now: 1000 })).toBe(true);
    expect(writeA(42, path, "first").acquired).toBe(true);

    // B classified the same stale L0 earlier; its steal runs only now, when the
    // path holds A's fresh lock. CAS refuses and restores it.
    expect(stealStaleLock(path, STALE, { pid: 2, now: 2000 })).toBe(false);

    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.pid).toBe(1);

    const loser = writeB(42, path, "second");
    expect(loser.acquired).toBe(false);
    expect(loser.holder?.pid).toBe(1);
  });

  it("the winning stealer clears the stale lock it classified", () => {
    const dirPath = join(dir, "42.lock");
    seedStale(dirPath);
    expect(stealStaleLock(dirPath, STALE, { pid: 1, now: 1000 })).toBe(true);
    expect(existsSync(dirPath)).toBe(false);
  });

  it("a stealer that lost the rename (ENOENT) reports lost, touching nothing", () => {
    const dirPath = join(dir, "42.lock");
    expect(stealStaleLock(dirPath, STALE, { pid: 1, now: 1000 })).toBe(false);
    expect(existsSync(dirPath)).toBe(false);
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
      const result = mgr.signalOther({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "x",
      });
      expect(result).toEqual({ sent: true, reason: "sent" });
      expect(calls).toEqual([9999]);

      // Cross-host: should NOT signal.
      calls.length = 0;
      const result2 = mgr.signalOther({
        pid: 9999,
        hostname: "other-host",
        startedAt: new Date().toISOString(),
        command: "x",
      });
      expect(result2).toEqual({ sent: false, reason: "cross-host" });
      expect(calls).toEqual([]);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("signalOther refuses to signal a holder past the age ceiling (#856)", () => {
    // The dangerous case `--force --signal-other` could hit: a lock abandoned
    // weeks ago whose PID the OS has since recycled onto an unrelated live
    // process. isPidAlive says "alive" — correctly, for a different program —
    // so the liveness probe cannot catch this. Only the age can.
    const calls: number[] = [];
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true, // recycled PID answers "alive"
    });
    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
    ) => {
      calls.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const result = mgr.signalOther({
        pid: 28809, // the real 505.lock PID
        hostname: "host-a",
        startedAt: new Date(
          Date.now() - 76 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        command: "npx sequant run 505",
      });
      expect(result).toEqual({ sent: false, reason: "stale-pid-untrusted" });
      // The critical assertion: no signal was delivered to the stranger.
      expect(calls).toEqual([]);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("signalOther still signals a recent holder (age-guard negative control)", () => {
    const calls: number[] = [];
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
    ) => {
      calls.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const result = mgr.signalOther({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        command: "npx sequant run 1",
      });
      expect(result).toEqual({ sent: true, reason: "sent" });
      expect(calls).toEqual([9999]);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("signalOther refuses to signal the manager's own PID without probing isPidAlive (#637)", () => {
    let probed = 0;
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: process.pid, // mirrors production — manager runs with its real pid
      isPidAlive: () => {
        probed++;
        return true;
      },
    });
    const killCalls: number[] = [];
    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
    ) => {
      killCalls.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const result = mgr.signalOther({
        pid: process.pid, // === this.pid
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "x",
      });
      expect(result).toEqual({ sent: false, reason: "self-or-parent" });
      expect(probed).toBe(0); // guard short-circuits BEFORE isPidAlive
      expect(killCalls).toEqual([]);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("signalOther refuses to signal process.ppid without probing isPidAlive (#637)", () => {
    let probed = 0;
    // Pick a pid that cannot collide with process.ppid (parent of vitest).
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: process.pid, // self; POSIX guarantees process.pid !== process.ppid
      isPidAlive: () => {
        probed++;
        return true;
      },
    });
    const killCalls: number[] = [];
    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
    ) => {
      killCalls.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const result = mgr.signalOther({
        pid: process.ppid, // === parent of this process
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "x",
      });
      expect(result).toEqual({ sent: false, reason: "self-or-parent" });
      expect(probed).toBe(0);
      expect(killCalls).toEqual([]);
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

describe("resolveSkillLockTtlMs / SEQUANT_SKILL_LOCK_TTL_MS", () => {
  beforeEach(() => {
    delete process.env.SEQUANT_SKILL_LOCK_TTL_MS;
  });

  it("returns null when env var is unset", async () => {
    const { resolveSkillLockTtlMs } = await import("./lock-manager.js");
    expect(resolveSkillLockTtlMs()).toBeNull();
  });

  it("parses a positive integer from env", async () => {
    const { resolveSkillLockTtlMs } = await import("./lock-manager.js");
    process.env.SEQUANT_SKILL_LOCK_TTL_MS = "1000";
    expect(resolveSkillLockTtlMs()).toBe(1000);
  });

  it("rejects non-numeric / zero / negative values (returns null)", async () => {
    const { resolveSkillLockTtlMs } = await import("./lock-manager.js");
    process.env.SEQUANT_SKILL_LOCK_TTL_MS = "abc";
    expect(resolveSkillLockTtlMs()).toBeNull();
    process.env.SEQUANT_SKILL_LOCK_TTL_MS = "0";
    expect(resolveSkillLockTtlMs()).toBeNull();
    process.env.SEQUANT_SKILL_LOCK_TTL_MS = "-100";
    expect(resolveSkillLockTtlMs()).toBeNull();
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

describe("LockManager — skipPidCheck (skill-shell holders)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    delete process.env.SEQUANT_ORCHESTRATOR;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifyStaleness skips same-host PID check when skipPidCheck is set", () => {
    const holder = {
      pid: 9999,
      hostname: "host-a",
      startedAt: new Date("2026-05-11T00:00:00Z").toISOString(),
      command: "/fullsolve 1",
      skipPidCheck: true,
    };
    // PID is "dead" but skipPidCheck means we don't probe.
    const fresh = classifyStaleness({
      holder,
      myHostname: "host-a",
      now: new Date("2026-05-11T00:10:00Z").getTime(),
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      isPidAlive: () => false,
    });
    expect(fresh).toBeNull();

    const aged = classifyStaleness({
      holder,
      myHostname: "host-a",
      now: new Date("2026-05-11T03:00:00Z").getTime(), // 3h later
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      isPidAlive: () => false,
    });
    expect(aged).toBe("age-exceeded");
  });

  it("acquire({ skipPidCheck: true }) writes the flag into the lock file", () => {
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.acquire(42, "/fullsolve 42", { skipPidCheck: true });
    expect(result.acquired).toBe(true);
    const parsed = JSON.parse(readFileSync(join(dir, "42.lock"), "utf-8"));
    expect(parsed.skipPidCheck).toBe(true);
  });

  it("acquire without skipPidCheck does NOT include the flag", () => {
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    expect(mgr.acquire(42, "x").acquired).toBe(true);
    const parsed = JSON.parse(readFileSync(join(dir, "42.lock"), "utf-8"));
    expect(parsed.skipPidCheck).toBeUndefined();
  });

  it("a skipPidCheck same-host lock blocks a second skill on this host", () => {
    // Skill A wrote a lock from a now-dead shell.
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date(Date.now() - 60_000).toISOString(), // 1m ago
        command: "/fullsolve 42",
        skipPidCheck: true,
      }),
    );
    // Skill B (different PID, same host) tries to acquire.
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => false, // would normally clear; skipPidCheck overrides
    });
    const result = mgr.acquire(42, "/fullsolve 42", { skipPidCheck: true });
    expect(result.acquired).toBe(false);
    if (result.acquired === false) {
      expect(result.holder.skipPidCheck).toBe(true);
    }
  });

  it("a skipPidCheck same-host lock past skillLockTtlMs is auto-cleared", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), // 7h
        command: "/fullsolve 42",
        skipPidCheck: true,
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
      // Default skillLockTtlMs is 6h; 7h-old lock should be cleared.
    });
    const result = mgr.acquire(42, "/fullsolve 42", { skipPidCheck: true });
    expect(result.acquired).toBe(true);
  });

  it("a skipPidCheck same-host lock between staleAgeMs (2h) and skillLockTtlMs (6h) is NOT cleared", () => {
    // 4h old: past staleAgeMs (would clear cross-host) but within skillLockTtlMs.
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        command: "/fullsolve 42",
        skipPidCheck: true,
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.acquire(42, "/fullsolve 42", { skipPidCheck: true });
    expect(result.acquired).toBe(false);
  });

  it("a cross-host lock past staleAgeMs (2h) but within skillLockTtlMs (6h) IS cleared", () => {
    // Regression guard: cross-host MUST use staleAgeMs, not skillLockTtlMs.
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "remote-host",
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h
        command: "npx sequant run 42",
        // No skipPidCheck — this is a regular cross-host lock.
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    const result = mgr.acquire(42, "x");
    expect(result.acquired).toBe(true);
  });

  it("constructor honors explicit skillLockTtlMs option", () => {
    // 3h old + 1h TTL = stale.
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        command: "/fullsolve 42",
        skipPidCheck: true,
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
      skillLockTtlMs: 60 * 60 * 1000, // 1h
    });
    const result = mgr.acquire(42, "/fullsolve 42", { skipPidCheck: true });
    expect(result.acquired).toBe(true);
  });

  it("releaseExternal removes a same-host skipPidCheck lock from any PID", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999, // dead PID from a prior skill shell
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "/fullsolve 42",
        skipPidCheck: true,
      }),
    );
    // Released by a different PID on the same host (the next skill shell).
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    expect(mgr.releaseExternal(42)).toBe(true);
    expect(existsSync(join(dir, "42.lock"))).toBe(false);
  });

  it("releaseExternal refuses to release a cross-host lock", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "other-host",
        startedAt: new Date().toISOString(),
        command: "/fullsolve 42",
        skipPidCheck: true,
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    expect(mgr.releaseExternal(42)).toBe(false);
    expect(existsSync(join(dir, "42.lock"))).toBe(true);
  });

  it("releaseExternal refuses non-skipPidCheck locks from a different PID", () => {
    writeFileSync(
      join(dir, "42.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date().toISOString(),
        command: "regular run", // no skipPidCheck
      }),
    );
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: () => true,
    });
    expect(mgr.releaseExternal(42)).toBe(false);
    expect(existsSync(join(dir, "42.lock"))).toBe(true);
  });
});

describe("LockManager — RunOrchestrator lockedResults flow (AC-18)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    delete process.env.SEQUANT_ORCHESTRATOR;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // This file lives in the `unit` project, which deliberately keeps vitest's
  // 5s default because "a slow test is a real signal" there (vitest.config.ts).
  // The signal here is genuine: the lazy import below pulls in the whole
  // workflow package, whose transform cost lands right on that 5s line — it
  // was measured failing at 5.06s and passing at 1.38s on the *same* commit,
  // purely with machine load. That is a cold-import cost, not a behavioral
  // slowdown, so the fix is a local override (the escape hatch the config
  // documents) rather than widening the project default or splitting the file.
  it("buildLockedResult produces the IssueResult shape that flows into the summary", async () => {
    // Imported lazily so test failures in lock-manager don't masquerade as
    // workflow-package failures during file collection.
    const { buildLockedResult } =
      await import("../workflow/run-orchestrator.js");
    const result = buildLockedResult(100, {
      pid: 9999,
      hostname: "host-a",
      startedAt: "2026-05-11T00:00:00Z",
      command: "npx sequant run 100",
    });
    expect(result).toMatchObject({
      issueNumber: 100,
      success: false,
      phaseResults: [],
      abortReason: "locked by PID 9999",
      locked: {
        pid: 9999,
        hostname: "host-a",
        startedAt: "2026-05-11T00:00:00Z",
        command: "npx sequant run 100",
      },
    });
  }, 30_000);

  it("batch with a pre-existing foreign lock skips that issue and proceeds with others", async () => {
    // Pre-write a fresh foreign lock for issue 100 — simulates another
    // session that ran `npx sequant run 100` and is still in-flight.
    writeFileSync(
      join(dir, "100.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "host-a",
        startedAt: new Date(Date.now() - 30_000).toISOString(),
        command: "npx sequant run 100",
      }),
    );

    // Same-host manager — pid=1, pid=9999 still alive per probe.
    const mgr = new LockManager({
      locksDir: dir,
      hostname: "host-a",
      pid: 1,
      isPidAlive: (pid) => pid === 9999,
    });

    // Emulate the orchestrator's per-issue acquire loop (run-orchestrator.ts:533-555):
    // try-acquire each issue, collect locked vs claimed.
    const claimed: number[] = [];
    const lockedHolders: number[] = [];
    for (const issue of [100, 101]) {
      const claim = mgr.acquire(issue, "npx sequant run 100 101");
      if (claim.acquired) claimed.push(issue);
      else lockedHolders.push(claim.holder.pid);
    }

    // #100 should be in lockedHolders; #101 should be claimed and proceed.
    expect(lockedHolders).toEqual([9999]);
    expect(claimed).toEqual([101]);
    expect(existsSync(join(dir, "100.lock"))).toBe(true); // foreign lock preserved
    expect(existsSync(join(dir, "101.lock"))).toBe(true); // we acquired

    // The `formatLockedMessage` output flows into IssueResult.abortReason
    // (run-orchestrator.ts:1043) — verify the canonical format is present.
    const holder = mgr.check(100);
    expect(holder).not.toBeNull();
    if (holder) {
      expect(formatLockedMessage(100, holder)).toContain(
        "Issue #100 is being worked on by PID 9999",
      );
    }
  });
});
