/**
 * Unit tests for CheckoutLock (#901).
 *
 * Focus: the AC-4 staleness parity and the AC-5 orchestrator no-op. The
 * two-sessions-one-checkout enforcement (AC-2, AC-3, AC-7) is covered by
 * `checkout-lock.integration.test.ts`, which drives the real `pre-tool.sh`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { CheckoutLock, isSameHolder } from "./checkout-lock.js";
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

  it("releases a skill-shell lock whose original PID is gone", () => {
    makeLock({ pid: 1 }).acquire(23, "/fullsolve 23", { skipPidCheck: true });

    const released = makeLock({ pid: 2 }).release({ pid: 2, hostname: HOST });

    expect(released).toBe(true);
    expect(existsSync(join(locksDir, CHECKOUT_LOCK_FILENAME))).toBe(false);
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

describe("isSameHolder", () => {
  const base: CheckoutLockFile = {
    pid: 1,
    hostname: HOST,
    startedAt: new Date(0).toISOString(),
    command: "x",
    issue: 23,
  };

  it("prefers sessionId when both sides have one", () => {
    expect(
      isSameHolder(
        { ...base, sessionId: "S1" },
        { sessionId: "S1", pid: 999, hostname: "elsewhere" },
      ),
    ).toBe(true);

    expect(
      isSameHolder(
        { ...base, sessionId: "S1" },
        { sessionId: "S2", pid: 1, hostname: HOST },
      ),
    ).toBe(false);
  });

  it("falls back to pid+hostname when a sessionId is missing", () => {
    expect(isSameHolder(base, { pid: 1, hostname: HOST })).toBe(true);
    expect(isSameHolder(base, { pid: 2, hostname: HOST })).toBe(false);
    expect(isSameHolder(base, { pid: 1, hostname: "other" })).toBe(false);
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
    expect(msg).toContain("sequant locks checkout clear");
  });

  it("degrades to a generic worktree hint when the blocked issue is unknown", () => {
    const msg = formatCheckoutLockedMessage(holder);
    expect(msg).toContain("../worktrees/feature/<issue>-*/");
    expect(msg).toContain("sequant locks checkout clear");
  });
});
