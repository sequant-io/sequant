/**
 * Tests for the `merge --watch` poll/classify loop (#818).
 *
 * The loop is pure over injected deps: a fake `WatchGitHub` returns scripted
 * rollup/mergeable/annotation data, and injected `sleepFn`/`nowFn` make the
 * timing deterministic without real timers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  rollupEntryBucket,
  isRollupEntryTerminal,
  classifyTick,
  waitForChecks,
  type WatchGitHub,
} from "./watch.js";
import type {
  RollupEntry,
  MergeableState,
} from "../workflow/platforms/github.js";
import type { AnnotatedCheck } from "../qa/infra-blocked-ci.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const checkRun = (status: string, conclusion?: string): RollupEntry => ({
  __typename: "CheckRun",
  status,
  conclusion,
});

const statusContext = (state: string): RollupEntry => ({
  __typename: "StatusContext",
  state,
});

const BILLING_ANNOTATION: AnnotatedCheck[] = [
  {
    checkName: "build",
    annotations: [
      {
        message:
          "The job was not started because recent account payments have failed " +
          "or your spending limit needs to be increased.",
        annotation_level: "failure",
        path: ".github",
      },
    ],
  },
];

/** Build a fake provider from scripted per-call return values. */
function fakeGitHub(overrides: Partial<WatchGitHub> = {}): WatchGitHub {
  return {
    getMergeableStateSync: () => "MERGEABLE",
    getStatusCheckRollupSync: () => [],
    getPRHeadShaSync: () => "deadbeef",
    getCheckRunAnnotationsSync: () => [],
    ...overrides,
  };
}

// ── rollupEntryBucket / isRollupEntryTerminal ────────────────────────────────

describe("rollupEntryBucket", () => {
  it("maps a completed successful CheckRun to pass", () => {
    expect(rollupEntryBucket(checkRun("COMPLETED", "SUCCESS"))).toBe("pass");
  });

  it("maps an in-progress CheckRun to pending regardless of conclusion", () => {
    expect(rollupEntryBucket(checkRun("IN_PROGRESS"))).toBe("pending");
    expect(rollupEntryBucket(checkRun("QUEUED"))).toBe("pending");
  });

  it("maps a completed failing CheckRun to fail", () => {
    expect(rollupEntryBucket(checkRun("COMPLETED", "FAILURE"))).toBe("fail");
    expect(rollupEntryBucket(checkRun("COMPLETED", "TIMED_OUT"))).toBe("fail");
  });

  it("maps neutral/skipped conclusions to skipping", () => {
    expect(rollupEntryBucket(checkRun("COMPLETED", "SKIPPED"))).toBe(
      "skipping",
    );
    expect(rollupEntryBucket(checkRun("COMPLETED", "NEUTRAL"))).toBe(
      "skipping",
    );
  });

  it("maps StatusContext states to buckets", () => {
    expect(rollupEntryBucket(statusContext("SUCCESS"))).toBe("pass");
    expect(rollupEntryBucket(statusContext("FAILURE"))).toBe("fail");
    expect(rollupEntryBucket(statusContext("ERROR"))).toBe("fail");
    expect(rollupEntryBucket(statusContext("PENDING"))).toBe("pending");
    expect(rollupEntryBucket(statusContext("EXPECTED"))).toBe("pending");
  });
});

describe("isRollupEntryTerminal", () => {
  it("treats pending entries as non-terminal and others as terminal", () => {
    expect(isRollupEntryTerminal(checkRun("IN_PROGRESS"))).toBe(false);
    expect(isRollupEntryTerminal(checkRun("COMPLETED", "SUCCESS"))).toBe(true);
    expect(isRollupEntryTerminal(statusContext("FAILURE"))).toBe(true);
  });
});

// ── classifyTick ─────────────────────────────────────────────────────────────

describe("classifyTick", () => {
  const noAnnotations = () => [] as AnnotatedCheck[];

  it("returns terminal when every check is terminal and not all failing", () => {
    const rollup = [
      checkRun("COMPLETED", "SUCCESS"),
      checkRun("COMPLETED", "FAILURE"),
    ];
    expect(classifyTick("MERGEABLE", rollup, noAnnotations)).toEqual({
      kind: "terminal",
    });
  });

  it("returns pending when any check is still running", () => {
    const rollup = [checkRun("COMPLETED", "SUCCESS"), checkRun("IN_PROGRESS")];
    expect(classifyTick("MERGEABLE", rollup, noAnnotations)).toEqual({
      kind: "pending",
      pending: 1,
      total: 2,
    });
  });

  it("blocks on CONFLICTING regardless of check count (AC-3a/AC-3b)", () => {
    const outcome = classifyTick("CONFLICTING", [], noAnnotations);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.reason).toMatch(/CONFLICTING/);
    }
  });

  it("treats zero checks as pending, never terminal (AC-1 wait contract)", () => {
    expect(classifyTick("MERGEABLE", [], noAnnotations)).toEqual({
      kind: "pending",
      pending: 0,
      total: 0,
    });
  });

  it("does NOT fetch annotations when the board is not all-failing", () => {
    const fetch = vi.fn(() => [] as AnnotatedCheck[]);
    const rollup = [
      checkRun("COMPLETED", "SUCCESS"),
      checkRun("COMPLETED", "FAILURE"),
    ];
    classifyTick("MERGEABLE", rollup, fetch);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks on billing-lockout when all checks fail-fast (AC-3c)", () => {
    const fetch = vi.fn(() => BILLING_ANNOTATION);
    const rollup = [
      checkRun("COMPLETED", "FAILURE"),
      checkRun("COMPLETED", "FAILURE"),
    ];
    const outcome = classifyTick("MERGEABLE", rollup, fetch);
    expect(fetch).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.reason).toMatch(/job was not started/i);
      expect(outcome.checkName).toBe("build");
    }
  });

  it("stays terminal when all-failing but annotations show a real failure", () => {
    const fetch = vi.fn(() => [] as AnnotatedCheck[]);
    const rollup = [checkRun("COMPLETED", "FAILURE")];
    expect(classifyTick("MERGEABLE", rollup, fetch)).toEqual({
      kind: "terminal",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ── waitForChecks ─────────────────────────────────────────────────────────────

describe("waitForChecks", () => {
  const opts = { intervalMs: 1000, timeoutMs: 60_000 };

  /** A `nowFn` that advances by `step` ms on each call. */
  function fakeClock(step = 1000): () => number {
    let t = 0;
    return () => {
      const v = t;
      t += step;
      return v;
    };
  }

  it("returns terminal once the rollup settles (AC-1)", async () => {
    let poll = 0;
    const gh = fakeGitHub({
      getStatusCheckRollupSync: () => {
        poll++;
        return poll < 3
          ? [checkRun("IN_PROGRESS")]
          : [checkRun("COMPLETED", "SUCCESS")];
      },
    });
    const sleep = vi.fn(async () => {});
    const result = await waitForChecks(42, opts, gh, sleep, fakeClock());
    expect(result.status).toBe("terminal");
    expect(result.polls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns blocked immediately on CONFLICTING without sleeping (AC-3)", async () => {
    const gh = fakeGitHub({ getMergeableStateSync: () => "CONFLICTING" });
    const sleep = vi.fn(async () => {});
    const result = await waitForChecks(42, opts, gh, sleep, fakeClock());
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/CONFLICTING/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("times out with a distinct message when checks never settle (AC-2)", async () => {
    const gh = fakeGitHub({
      getStatusCheckRollupSync: () => [checkRun("IN_PROGRESS")],
    });
    const sleep = vi.fn(async () => {});
    // Deadline of 3000ms with a clock advancing 1000ms/call → times out.
    const result = await waitForChecks(
      42,
      { intervalMs: 1000, timeoutMs: 3000 },
      gh,
      sleep,
      fakeClock(1000),
    );
    expect(result.status).toBe("timeout");
    expect(result.reason).toMatch(/timed out after 3s/);
    expect(result.reason).toMatch(/still pending/);
  });

  it("timeout message names the zero-checks case distinctly", async () => {
    const gh = fakeGitHub({ getStatusCheckRollupSync: () => [] });
    const result = await waitForChecks(
      7,
      { intervalMs: 1000, timeoutMs: 2000 },
      gh,
      vi.fn(async () => {}),
      fakeClock(1000),
    );
    expect(result.status).toBe("timeout");
    expect(result.reason).toMatch(/no CI checks ever appeared/);
  });

  it("does not swallow a terminal poll even when the deadline has passed", async () => {
    // timeoutMs=0 → the deadline is the start instant, already elapsed. Because
    // classifyTick runs on a fresh poll and the terminal check precedes the
    // deadline check, a terminal board still returns terminal, not timeout.
    const gh = fakeGitHub({
      getStatusCheckRollupSync: () => [checkRun("COMPLETED", "SUCCESS")],
    });
    const result = await waitForChecks(
      42,
      { intervalMs: 1000, timeoutMs: 0 },
      gh,
      vi.fn(async () => {}),
      fakeClock(1000),
    );
    expect(result.status).toBe("terminal");
  });

  it("reports blocked billing-lockout through the full loop (AC-3c)", async () => {
    const gh = fakeGitHub({
      getStatusCheckRollupSync: () => [checkRun("COMPLETED", "FAILURE")],
      getCheckRunAnnotationsSync: () => BILLING_ANNOTATION,
    });
    const result = await waitForChecks(
      42,
      opts,
      gh,
      vi.fn(async () => {}),
      fakeClock(),
    );
    expect(result.status).toBe("blocked");
    expect(result.checkName).toBe("build");
  });

  it("degrades to terminal (not crash) when annotation fetch returns junk (AC-D1)", async () => {
    const gh = fakeGitHub({
      getStatusCheckRollupSync: () => [checkRun("COMPLETED", "FAILURE")],
      getPRHeadShaSync: () => null, // e.g. gh failure → no SHA
      getCheckRunAnnotationsSync: () => {
        throw new Error("should not be reached when SHA is null");
      },
    });
    const result = await waitForChecks(
      42,
      opts,
      gh,
      vi.fn(async () => {}),
      fakeClock(),
    );
    // No SHA → no annotations → detector says not-blocked → real terminal verdict.
    expect(result.status).toBe("terminal");
  });
});
