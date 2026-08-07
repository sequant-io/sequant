/**
 * Unit tests for CheckoutLock (#901).
 *
 * Focus: the AC-4 staleness parity and the AC-5 orchestrator no-op. The
 * two-sessions-one-checkout enforcement (AC-2, AC-3, AC-7) is covered by
 * `checkout-lock.integration.test.ts`, which drives the real `pre-tool.sh`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { CheckoutLock, isCheckoutOwner } from "./checkout-lock.js";
import { formatCheckoutLockedMessage } from "./checkout-lock.js";
import {
  CHECKOUT_LOCK_FILENAME,
  DEFAULT_MAX_LOCK_AGE_MS,
  type CheckoutLockFile,
} from "./types.js";

const HOST = "test-host";

let locksDir: string;

function makeLock(overrides: Partial<CheckoutLockOptionsForTest> = {}) {
  return new CheckoutLock({
    locksDir,
    hostname: overrides.hostname ?? HOST,
    pid: overrides.pid ?? 1234,
    now: overrides.now ?? (() => 1_000_000_000_000),
    isPidAlive: overrides.isPidAlive ?? (() => true),
    orchestratorMode: overrides.orchestratorMode ?? false,
    maxLockAgeMs: overrides.maxLockAgeMs,
  });
}

interface CheckoutLockOptionsForTest {
  hostname: string;
  pid: number;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  orchestratorMode: boolean;
  maxLockAgeMs?: number;
}

beforeEach(() => {
  locksDir = mkdtempSync(join(tmpdir(), "sequant-checkout-lock-"));
});

afterEach(() => {
  rmSync(locksDir, { recursive: true, force: true });
});

describe("CheckoutLock — acquire/release basics", () => {
  it("writes a non-numeric checkout.lock so LockManager.list() ignores it", () => {
    const lock = makeLock();
    const result = lock.acquire(23, "/fullsolve 23");

    expect(result.acquired).toBe(true);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(true);

    const payload = JSON.parse(
      readFileSync(join(locksDir, CHECKOUT_LOCK_FILENAME), "utf-8"),
    );
    expect(payload.issue).toBe(23);
    expect(payload.command).toBe("/fullsolve 23");
    expect(
      Number.isInteger(Number(CHECKOUT_LOCK_FILENAME.replace(".lock", ""))),
    ).toBe(false);
  });

  it("refuses a second session on a different issue", () => {
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23");

    const result = makeLock({ pid: 2 }).acquire(10, "/fullsolve 10");

    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error("unreachable");
    expect(result.holder.issue).toBe(23);
  });

  it("is re-entrant for the same session id", () => {
    const a = makeLock({ pid: 1 });
    a.acquire(23, "/fullsolve 23", { sessionId: "S1" });

    // Different PID (skill shells get a new one each call), same session.
    const again = makeLock({ pid: 999 }).acquire(23, "/fullsolve 23", {
      sessionId: "S1",
    });

    expect(again.acquired).toBe(true);
    if (!again.acquired) throw new Error("unreachable");
    expect(again.reentrant).toBe(true);
  });

  it("refuses a bare release of a skill-shell lock (#906)", () => {
    // Before #906 this returned true: any same-host caller could remove a
    // fresh `skipPidCheck` lock. That is the reported bug — every /fullsolve
    // halt branch runs a release, so a *blocked* session finishing first
    // silently handed the tree away mid-run.
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23", { skipPidCheck: true });

    const released = makeLock({ pid: 2 }).release({ pid: 2, hostname: HOST });

    expect(released).toBe(false);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(true);
  });

  it("releases a skill-shell lock when the caller names the holder's issue", () => {
    // The rightful holder can still release: its PID is gone, but it knows
    // which issue it is working on.
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23", { skipPidCheck: true });

    const released = makeLock({ pid: 2 }).release({
      pid: 2,
      hostname: HOST,
      issue: 23,
    });

    expect(released).toBe(true);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(false);
  });

  it("refuses a skill-shell release naming a different issue", () => {
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23", { skipPidCheck: true });

    const released = makeLock({ pid: 2 }).release({
      pid: 2,
      hostname: HOST,
      issue: 77,
    });

    expect(released).toBe(false);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(true);
  });

  it("re-acquires reentrantly by issue, matching what release accepts (#906)", () => {
    // Identity symmetry: if issue-match is enough to release, it must be
    // enough to re-acquire — otherwise a session blocks itself on its own
    // lock part-way through its run.
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23", { skipPidCheck: true });

    const again = makeLock({ pid: 999 }).acquire(23, "/fullsolve 23", {
      skipPidCheck: true,
    });

    expect(again.acquired).toBe(true);
    if (!again.acquired) throw new Error("unreachable");
    expect(again.reentrant).toBe(true);
  });

  it("still refuses a foreign issue's acquire while the holder is fresh", () => {
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23", { skipPidCheck: true });

    const other = makeLock({ pid: 999 }).acquire(77, "/fullsolve 77", {
      skipPidCheck: true,
    });

    expect(other.acquired).toBe(false);
    if (other.acquired) throw new Error("unreachable");
    expect(other.holder.issue).toBe(23);
  });

  it("refuses to release a cross-host holder", () => {
    makeLock({ pid: 1, hostname: "other-host" }).acquire(23, "/fullsolve 23", {
      skipPidCheck: true,
    });

    const released = makeLock({ pid: 2, hostname: HOST }).release();

    expect(released).toBe(false);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(true);
  });
});

describe("CheckoutLock — atomic create (O_CREAT|O_EXCL)", () => {
  // `acquire()` reads the current holder before writing, and in practice that
  // read serializes competing CLI processes long before the create — a
  // multi-process race test passes even with a non-atomic `w` open, so it
  // cannot pin this behavior (verified by mutation: 33/33 still green with
  // `wx` -> `w`). The exclusive-create flag only matters in the window where
  // two acquirers have BOTH passed the read and are racing to create.
  //
  // So drive that window directly. `writeAtomic` is private to TypeScript
  // only; reaching it here is deliberate white-box coverage of the one
  // invariant the read path cannot provide.
  type WriteAtomic = (
    lockPath: string,
    issue: number,
    command: string,
    options: { sessionId?: string; skipPidCheck?: boolean },
  ) => { acquired: boolean };

  it("refuses to overwrite an existing lock, and preserves the winner", () => {
    const a = makeLock({ pid: 1 });
    const b = makeLock({ pid: 2 });

    const writeA = (
      a as unknown as { writeAtomic: WriteAtomic }
    ).writeAtomic.bind(a);
    const writeB = (
      b as unknown as { writeAtomic: WriteAtomic }
    ).writeAtomic.bind(b);

    const path = a.lockPath;
    // Both acquirers have already passed the read check — the file does not
    // exist yet from either one's point of view.
    expect(writeA(path, 23, "/fullsolve 23", {}).acquired).toBe(true);
    expect(writeB(path, 10, "/fullsolve 10", {}).acquired).toBe(false);

    // The loser must not have truncated or replaced the winner's payload.
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.issue).toBe(23);
    expect(onDisk.pid).toBe(1);
  });

  it("reports the winner as the holder to the loser", () => {
    const a = makeLock({ pid: 1 });
    const b = makeLock({ pid: 2 });
    const writeA = (
      a as unknown as { writeAtomic: WriteAtomic }
    ).writeAtomic.bind(a);
    const writeB = (
      b as unknown as { writeAtomic: WriteAtomic }
    ).writeAtomic.bind(b);

    writeA(a.lockPath, 23, "/fullsolve 23", {});
    const loser = writeB(a.lockPath, 10, "/fullsolve 10", {}) as {
      acquired: boolean;
      holder?: { issue: number; pid: number };
    };

    expect(loser.acquired).toBe(false);
    expect(loser.holder?.issue).toBe(23);
    expect(loser.holder?.pid).toBe(1);
  });
});

describe("CheckoutLock — AC-4: stale recovery matches per-issue semantics", () => {
  it("clears a same-host holder whose PID is dead", () => {
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23");

    // skipPidCheck absent => the same-host PID probe is authoritative.
    const result = makeLock({ pid: 2, isPidAlive: () => false }).acquire(
      10,
      "/fullsolve 10",
    );

    expect(result.acquired).toBe(true);
  });

  it("clears a holder past the absolute age ceiling even with a live PID", () => {
    const t0 = 1_000_000_000_000;
    makeLock({ pid: 1, now: () => t0 }).acquire(23, "/fullsolve 23");

    const later = t0 + DEFAULT_MAX_LOCK_AGE_MS + 1;
    const result = makeLock({
      pid: 2,
      now: () => later,
      isPidAlive: () => true, // recycled PID reads as alive
    }).acquire(10, "/fullsolve 10");

    expect(result.acquired).toBe(true);
  });

  it("does NOT clear a holder still inside the ceiling", () => {
    const t0 = 1_000_000_000_000;
    makeLock({ pid: 1, now: () => t0 }).acquire(23, "/fullsolve 23");

    const result = makeLock({
      pid: 2,
      now: () => t0 + DEFAULT_MAX_LOCK_AGE_MS - 1,
      isPidAlive: () => true,
    }).acquire(10, "/fullsolve 10");

    expect(result.acquired).toBe(false);
  });

  it("honors an explicit maxLockAgeMs override (SEQUANT_MAX_LOCK_AGE_MS path)", () => {
    const t0 = 1_000_000_000_000;
    makeLock({ pid: 1, now: () => t0 }).acquire(23, "/fullsolve 23");

    const result = makeLock({
      pid: 2,
      now: () => t0 + 60_000,
      isPidAlive: () => true,
      maxLockAgeMs: 1_000, // 1s ceiling
    }).acquire(10, "/fullsolve 10");

    expect(result.acquired).toBe(true);
  });

  it("reads SEQUANT_MAX_LOCK_AGE_MS from the environment", () => {
    const prev = process.env.SEQUANT_MAX_LOCK_AGE_MS;
    try {
      const t0 = 1_000_000_000_000;
      makeLock({ pid: 1, now: () => t0 }).acquire(23, "/fullsolve 23");

      process.env.SEQUANT_MAX_LOCK_AGE_MS = "1000";
      const lock = new CheckoutLock({
        locksDir,
        hostname: HOST,
        pid: 2,
        now: () => t0 + 60_000,
        isPidAlive: () => true,
        orchestratorMode: false,
      });

      expect(lock.acquire(10, "/fullsolve 10").acquired).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SEQUANT_MAX_LOCK_AGE_MS;
      else process.env.SEQUANT_MAX_LOCK_AGE_MS = prev;
    }
  });

  it("clear() refuses a fresh holder but yields to --force", () => {
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23");

    const guarded = makeLock({ pid: 2 }).clear();
    expect(guarded.cleared).toBe(false);
    expect(guarded.reason).toBe("fresh-holder");

    const forced = makeLock({ pid: 2 }).clear({ safetyCheck: false });
    expect(forced.cleared).toBe(true);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(false);
  });
});

describe("CheckoutLock — AC-5: orchestrator/MCP mode is a no-op", () => {
  it("touches no filesystem and never blocks", () => {
    const lock = makeLock({ orchestratorMode: true });

    const acquired = lock.acquire(23, "/fullsolve 23");
    expect(acquired.acquired).toBe(true);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(false);

    expect(lock.check()).toBeNull();
    expect(lock.listing()).toBeNull();
    expect(lock.release()).toBe(false);
    expect(lock.clear()).toEqual({
      cleared: false,
      reason: "orchestrator-mode",
    });
  });

  it("does not block even when a real lock file is present", () => {
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23");

    const orchestrated = makeLock({ pid: 2, orchestratorMode: true });
    expect(orchestrated.acquire(10, "/fullsolve 10").acquired).toBe(true);
  });
});

describe("CheckoutLock — clear() on a corrupt lock file (#906)", () => {
  // Reachable in production: `writeAtomic` creates the file with openSync and
  // writes to it as a second step, so a process killed in between leaves a
  // zero-byte checkout.lock (#856 documents the group-SIGKILL that does it).
  it("removes a zero-byte lock that no other command could clear", () => {
    const lockPath = join(locksDir, CHECKOUT_LOCK_FILENAME);
    writeFileSync(lockPath, "");

    // The precondition that made it unclearable: nothing can read a holder.
    expect(makeLock().check()).toBeNull();

    expect(makeLock().clear()).toEqual({
      cleared: true,
      reason: "cleared-corrupt",
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes an unparseable lock without needing --force", () => {
    // --force gates the *staleness* check, which needs a holder to evaluate.
    // Corrupt bytes name no session, so there is nothing to protect.
    const lockPath = join(locksDir, CHECKOUT_LOCK_FILENAME);
    writeFileSync(lockPath, "{ not json at all");

    expect(makeLock().clear({ safetyCheck: true }).cleared).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("still reports no-lock when the file is genuinely absent", () => {
    expect(makeLock().clear()).toEqual({ cleared: false, reason: "no-lock" });
  });

  it("lets acquire proceed again once the corrupt lock is cleared", () => {
    const lockPath = join(locksDir, CHECKOUT_LOCK_FILENAME);
    writeFileSync(lockPath, "");

    makeLock().clear();
    expect(makeLock().acquire(23, "/fullsolve 23").acquired).toBe(true);
  });
});

describe("isCheckoutOwner — the five-rule matrix (#906)", () => {
  const base: CheckoutLockFile = {
    pid: 1,
    hostname: HOST,
    startedAt: new Date(0).toISOString(),
    command: "x",
    issue: 23,
  };
  const skill: CheckoutLockFile = { ...base, skipPidCheck: true };

  it("rule 1: refuses a cross-host caller before any other rule runs", () => {
    // Checked first on purpose: no weaker rule below may overturn it. A
    // matching sessionId does not rescue a foreign host.
    expect(
      isCheckoutOwner(
        { ...base, sessionId: "S1" },
        { sessionId: "S1", pid: 1, hostname: "elsewhere" },
      ),
    ).toBe(false);
    expect(isCheckoutOwner(base, { pid: 1, hostname: "elsewhere" })).toBe(
      false,
    );
  });

  it("rule 2: when both sides carry a sessionId, equality decides with no fall-through", () => {
    expect(
      isCheckoutOwner(
        { ...base, sessionId: "S1" },
        { sessionId: "S1", pid: 999, hostname: HOST },
      ),
    ).toBe(true);

    // A mismatch is positive proof of non-ownership — a matching pid and a
    // matching issue must NOT rescue it.
    expect(
      isCheckoutOwner(
        { ...skill, sessionId: "S1" },
        { sessionId: "S2", pid: 1, hostname: HOST, issue: 23 },
      ),
    ).toBe(false);
  });

  it("rule 3: a live process releases its own lock by pid+hostname", () => {
    expect(isCheckoutOwner(base, { pid: 1, hostname: HOST })).toBe(true);
    expect(isCheckoutOwner(base, { pid: 2, hostname: HOST })).toBe(false);
  });

  it("rule 4: issue identity applies to skipPidCheck locks only", () => {
    expect(
      isCheckoutOwner(skill, { pid: 999, hostname: HOST, issue: 23 }),
    ).toBe(true);
    // Not a skill-shell lock: the issue proves nothing, the PID is authoritative.
    expect(isCheckoutOwner(base, { pid: 999, hostname: HOST, issue: 23 })).toBe(
      false,
    );
  });

  it("rule 5: refuses a foreign issue, and a caller that names no issue at all", () => {
    // This is the exact reported bug: session B, blocked on #77, running its
    // release contract against A's fresh #23 lock.
    expect(
      isCheckoutOwner(skill, { pid: 999, hostname: HOST, issue: 77 }),
    ).toBe(false);
    expect(isCheckoutOwner(skill, { pid: 999, hostname: HOST })).toBe(false);
  });
});

describe("formatCheckoutLockedMessage — AC-2 + AC-3", () => {
  const holder: CheckoutLockFile = {
    pid: 4711,
    hostname: "mac",
    startedAt: new Date(1_000_000_000_000).toISOString(),
    command: "/fullsolve 23",
    issue: 23,
  };

  it("names the holding session and its issue (AC-2)", () => {
    const msg = formatCheckoutLockedMessage(holder, {}, 1_000_000_720_000);
    expect(msg).toContain("#23");
    expect(msg).toContain("4711");
    expect(msg).toContain("mac");
    expect(msg).toContain("/fullsolve 23");
    expect(msg).toContain("12m ago");
  });

  it("tells the user how to proceed, not just that they are blocked (AC-3)", () => {
    const msg = formatCheckoutLockedMessage(holder, { issue: 10 });
    // Names the worktree the blocked session should use instead...
    expect(msg).toContain("../worktrees/feature/10-*/");
    // ...and how to clear a stale holder.
    expect(msg).toContain("sequant locks checkout clear --force");
  });

  it("degrades to a generic worktree hint when the blocked issue is unknown", () => {
    const msg = formatCheckoutLockedMessage(holder);
    expect(msg).toContain("../worktrees/feature/<issue>-*/");
    expect(msg).toContain("sequant locks checkout clear --force");
  });
});
