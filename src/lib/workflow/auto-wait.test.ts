/**
 * #804 — `--auto-wait`: continue a rate-limited run when the window resets.
 *
 * Deliberately a separate file from `phase-executor.test.ts` /
 * `batch-executor.test.ts`. AC-2 is a regression contract stating that the
 * existing window-exhaustion and `-Q` halt tests pass **unmodified**; keeping
 * #804's tests out of those files makes that claim checkable with `git diff`
 * rather than by reading for incidental edits.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  AUTO_WAIT_BUFFER_MS,
  AUTO_WAIT_MAX_WAITS,
  RATE_LIMIT_RETRY_BACKOFF_MS,
  RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS,
  createAutoWaitLedger,
  executePhaseWithRetry,
  isWindowExhaustedRateLimit,
  shouldAutoWaitForReset,
  waitForWindowReset,
} from "./phase-executor.js";
import {
  isBillingHalt,
  isBillingOrWindowHalt,
  isWindowHalt,
  getEnvConfig,
} from "./batch-executor.js";
import { buildExecutionConfig, resolveRunOptions } from "./config-resolver.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { ExecutionConfig, PhaseResult, RunOptions } from "./types.js";
import { ShutdownManager } from "../shutdown.js";
import { DEFAULT_SETTINGS, RunSettingsSchema } from "../settings.js";
import type { SequantSettings } from "../settings.js";
import {
  BillingError,
  RateLimitError,
  createRateLimitError,
  resetsAtToMs,
} from "../errors.js";
import type { RateLimitInfoLike } from "../errors.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const baseConfig: ExecutionConfig = {
  phases: ["exec"],
  phaseTimeout: 600,
  qualityLoop: false,
  maxIterations: 3,
  skipVerification: false,
  sequential: false,
  concurrency: 3,
  parallel: false,
  verbose: false,
  noSmartTests: false,
  dryRun: false,
  mcp: true,
  retry: true,
};

function makeResult(overrides: Partial<PhaseResult> = {}): PhaseResult {
  return {
    phase: "exec",
    success: false,
    durationSeconds: 10,
    error: "cold-start failure",
    ...overrides,
  };
}

/** A window-exhausted rate-limit failure whose reset is `msOut` from `now`. */
function windowFailure(msOut: number, now: number = Date.now()): PhaseResult {
  const resetsAt = now + msOut;
  return makeResult({
    durationSeconds: 5,
    error: "Rate limited — resets at 14:30",
    structuredError: new RateLimitError("Rate limited — resets at 14:30", {
      resetsAt,
      rateLimitType: "five_hour",
    }),
  });
}

describe("#804 shouldAutoWaitForReset — the budget decision (AC-3, AC-4, AC-6)", () => {
  const now = 1_800_000_000_000;

  it("does not fire when auto-wait is off (default budget 0)", () => {
    const err = new RateLimitError("Rate limited", {
      resetsAt: now + 2 * HOUR,
    });
    expect(
      shouldAutoWaitForReset(err, createAutoWaitLedger(0), now),
    ).toBeNull();
    expect(
      shouldAutoWaitForReset(err, createAutoWaitLedger(undefined), now),
    ).toBeNull();
  });

  it("AC-4: never waits for a BillingError, even though it carries resetsAt", () => {
    // The #782 capture is exactly this shape: a credits failure that DOES
    // carry resetsAt/rateLimitType. Gating on the timestamp instead of the
    // error type would wait out a condition that cannot self-heal.
    const billing = new BillingError("Out of credits", {
      resetsAt: now + 2 * HOUR,
      rateLimitType: "five_hour",
      overageDisabledReason: "out_of_credits",
    });
    expect(
      shouldAutoWaitForReset(billing, createAutoWaitLedger(600), now),
    ).toBeNull();
  });

  it("AC-4: never waits for a rate limit with no resetsAt (transient path)", () => {
    const noMeta = new RateLimitError("Rate limited", {});
    expect(
      shouldAutoWaitForReset(noMeta, createAutoWaitLedger(600), now),
    ).toBeNull();
  });

  it("AC-3: only fires once isWindowExhaustedRateLimit is already true", () => {
    // Reset inside the 5-minute threshold ⇒ classified transient, so the
    // budget question is never asked no matter how large the budget is.
    const transient = new RateLimitError("Rate limited", {
      resetsAt: now + RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS - 1000,
    });
    expect(isWindowExhaustedRateLimit(transient, now)).toBe(false);
    expect(
      shouldAutoWaitForReset(transient, createAutoWaitLedger(600), now),
    ).toBeNull();
  });

  it("AC-6: budget boundary — a reset just inside the budget waits", () => {
    // Budget 60min; reset 58min out ⇒ wait is 59min with the buffer. Inside.
    const err = new RateLimitError("Rate limited", {
      resetsAt: now + 58 * MINUTE,
    });
    const decision = shouldAutoWaitForReset(err, createAutoWaitLedger(60), now);
    expect(decision).not.toBeNull();
    expect(decision!.waitMs).toBe(58 * MINUTE + AUTO_WAIT_BUFFER_MS);
  });

  it("AC-6: budget boundary — a reset just outside the budget halts", () => {
    // Budget 60min; reset 60min out ⇒ wait is 61min with the buffer. Outside.
    const err = new RateLimitError("Rate limited", {
      resetsAt: now + 60 * MINUTE,
    });
    expect(
      shouldAutoWaitForReset(err, createAutoWaitLedger(60), now),
    ).toBeNull();
  });

  it("AC-5: the wake is resetsAt + buffer, and seconds-unit resetsAt is normalized first", () => {
    // Seconds, like the real #782 capture — resetsAtToMs must run BEFORE the
    // buffer is added, or the arithmetic is off by ~1784392200 seconds.
    const resetsAtSeconds = Math.floor(now / 1000) + 2 * 60 * 60;
    const err = new RateLimitError("Rate limited", {
      resetsAt: resetsAtSeconds,
    });
    const decision = shouldAutoWaitForReset(
      err,
      createAutoWaitLedger(600),
      now,
    );
    expect(decision!.wakeAtMs).toBe(
      resetsAtToMs(resetsAtSeconds) + AUTO_WAIT_BUFFER_MS,
    );
    // And it is genuinely later than the bare reset — the whole point of the
    // buffer is to not re-request at the exact boundary.
    expect(decision!.wakeAtMs).toBeGreaterThan(resetsAtToMs(resetsAtSeconds));
  });

  it("AC-6: refuses once the per-issue wait bound is spent", () => {
    const ledger = createAutoWaitLedger(600);
    ledger.waits = AUTO_WAIT_MAX_WAITS;
    const err = new RateLimitError("Rate limited", { resetsAt: now + HOUR });
    expect(shouldAutoWaitForReset(err, ledger, now)).toBeNull();
  });

  it("AC-6: the budget is TOTAL — spend reduces what a later wait may use", () => {
    const ledger = createAutoWaitLedger(60);
    ledger.spentMs = 50 * MINUTE; // 10 min left
    // A 30-minute wait no longer fits even though it is well under the 60-min
    // total — this is what distinguishes a total budget from a per-occurrence
    // allowance.
    const tooLong = new RateLimitError("Rate limited", {
      resetsAt: now + 30 * MINUTE,
    });
    expect(shouldAutoWaitForReset(tooLong, ledger, now)).toBeNull();

    const fits = new RateLimitError("Rate limited", {
      resetsAt: now + 8 * MINUTE,
    });
    expect(shouldAutoWaitForReset(fits, ledger, now)).not.toBeNull();
  });

  it("does not wait when the reset has already passed", () => {
    const ledger = createAutoWaitLedger(600);
    // Far enough out to be 'window exhausted' at classification time, but the
    // wake has since passed — nothing left to wait for.
    const err = new RateLimitError("Rate limited", { resetsAt: now + HOUR });
    expect(
      shouldAutoWaitForReset(err, ledger, now + HOUR + AUTO_WAIT_BUFFER_MS + 1),
    ).toBeNull();
  });

  it("createAutoWaitLedger clamps hostile inputs to disabled", () => {
    expect(createAutoWaitLedger(-5).budgetMs).toBe(0);
    expect(createAutoWaitLedger(NaN).budgetMs).toBe(0);
    expect(createAutoWaitLedger(Infinity).budgetMs).toBe(0);
  });
});

describe("#804 waitForWindowReset — liveness and interruptibility (AC-7)", () => {
  it("sleeps in ticks and reports progress on each one", async () => {
    let clock = 0;
    const delayFn = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const ticks: number[] = [];

    const { sleptMs, aborted } = await waitForWindowReset(100, {
      delayFn,
      onTick: (remaining) => ticks.push(remaining),
      now: () => clock,
      tickMs: 40,
    });

    expect(aborted).toBe(false);
    expect(sleptMs).toBe(100);
    // 40 + 40 + 20 — the final slice is trimmed to the deadline, never overshoots.
    expect(delayFn.mock.calls.map((c) => c[0])).toEqual([40, 40, 20]);
    expect(ticks).toEqual([100, 60, 20]);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const delayFn = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort();

    const { aborted } = await waitForWindowReset(10 * HOUR, {
      delayFn,
      signal: controller.signal,
      now: () => 0,
    });

    expect(aborted).toBe(true);
    expect(delayFn).not.toHaveBeenCalled();
  });

  it("registers exactly one abort listener regardless of tick count", async () => {
    // A 5-hour wait is ~1200 ticks. Racing against a listener created inside
    // the loop would register one per tick — Node's max-listeners warning plus
    // ~1200 pending promises retained for the whole wait.
    let clock = 0;
    const delayFn = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");

    await waitForWindowReset(1000, {
      delayFn,
      signal: controller.signal,
      now: () => clock,
      tickMs: 10, // 100 ticks
    });

    expect(delayFn.mock.calls.length).toBe(100);
    expect(addSpy.mock.calls.filter(([type]) => type === "abort").length).toBe(
      1,
    );
  });

  it("aborts mid-wait without blocking until the wake — Ctrl-C during a multi-hour pause", async () => {
    const controller = new AbortController();
    let clock = 0;
    // A delay that never resolves: only the abort race can end this wait. If
    // the implementation awaited delayFn directly, this test would hang.
    const delayFn = vi.fn(() => new Promise<void>(() => {}));

    const promise = waitForWindowReset(5 * HOUR, {
      delayFn,
      signal: controller.signal,
      now: () => clock,
      tickMs: 15_000,
    });

    clock = 1234;
    controller.abort();

    const { aborted, sleptMs } = await promise;
    expect(aborted).toBe(true);
    expect(sleptMs).toBe(1234);
  });
});

describe("#804 executePhaseWithRetry — auto-wait in the retry ladder", () => {
  it("AC-2: with the default config, a window-exhausted limit still halts on the first attempt", async () => {
    const executePhaseFn = vi.fn().mockResolvedValue(windowFailure(2 * HOUR));
    const delayFn = vi.fn(async () => {});

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig, // no autoWaitMinutes
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(false);
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
    expect(delayFn).not.toHaveBeenCalled();
  });

  it("AC-9: waits and retries when the reset fits the budget, calling delayFn with the computed duration", async () => {
    const now = Date.now();
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(windowFailure(30 * MINUTE, now))
      .mockResolvedValueOnce(makeResult({ success: true }));
    const delayFn = vi.fn(async () => {});

    const result = await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, autoWaitMinutes: 120 },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(2);

    // The wait is chunked, so assert on the SUM rather than a single call —
    // and that no slice exceeds the tick.
    const slept = delayFn.mock.calls.reduce((a, c) => a + (c[0] as number), 0);
    const expected = 30 * MINUTE + AUTO_WAIT_BUFFER_MS;
    // Tolerance covers the real clock advancing between the failure and the
    // decision; the sum must not overshoot the computed wait.
    expect(slept).toBeGreaterThan(expected - 5000);
    expect(slept).toBeLessThanOrEqual(expected);
  });

  it("AC-6: a wait does not consume a cold-start retry", async () => {
    const now = Date.now();
    // Wait, then three ordinary cold-start failures. If the wait had eaten an
    // attempt slot, the ladder would spawn fewer than 4 times total.
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(windowFailure(10 * MINUTE, now))
      .mockResolvedValue(makeResult({ durationSeconds: 5 }));
    const delayFn = vi.fn(async () => {});

    await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, mcp: false, autoWaitMinutes: 120 },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    // 1 window failure + 3 cold-start attempts.
    expect(executePhaseFn).toHaveBeenCalledTimes(4);
  });

  it("AC-6: at most AUTO_WAIT_MAX_WAITS waits per issue, then today's halt", async () => {
    const now = Date.now();
    // Every attempt hits a fresh window 10 minutes out. Without the bound this
    // would pause forever.
    const executePhaseFn = vi.fn(async () => windowFailure(10 * MINUTE, now));
    const delayFn = vi.fn(async () => {});
    const ledger = createAutoWaitLedger(600);

    const result = await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, autoWaitMinutes: 600 },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
      ledger,
    );

    expect(result.success).toBe(false);
    expect(ledger.waits).toBe(AUTO_WAIT_MAX_WAITS);
    // Original attempt + one re-attempt per granted wait.
    expect(executePhaseFn).toHaveBeenCalledTimes(AUTO_WAIT_MAX_WAITS + 1);
    // The labeled cause survives to the caller unchanged.
    expect(result.error).toBe("Rate limited — resets at 14:30");
  });

  it("AC-6: the total budget is honored across two waits", async () => {
    const now = Date.now();
    // Budget 25 min. First wait ≈ 21 min (20 + buffer) — fits. Second wait
    // would need another ≈21 min but only ~4 min of budget remains, so the
    // run halts after ONE wait rather than spending 42 minutes.
    const executePhaseFn = vi.fn(async () => windowFailure(20 * MINUTE, now));
    const delayFn = vi.fn(async () => {});
    const ledger = createAutoWaitLedger(25);

    await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, autoWaitMinutes: 25 },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
      ledger,
    );

    expect(ledger.waits).toBe(1);
    expect(ledger.spentMs).toBeLessThanOrEqual(ledger.budgetMs);
    expect(executePhaseFn).toHaveBeenCalledTimes(2);
  });

  it("AC-4: a BillingError never waits, even with a generous budget", async () => {
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 120,
        error: "Out of credits",
        structuredError: new BillingError("Out of credits", {
          resetsAt: Date.now() + 30 * MINUTE,
          rateLimitType: "five_hour",
          overageDisabledReason: "out_of_credits",
        }),
      }),
    );
    const delayFn = vi.fn(async () => {});

    const result = await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, autoWaitMinutes: 600 },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(false);
    expect(delayFn).not.toHaveBeenCalled();
  });

  it("AC-4: a metadata-absent rate limit takes the transient backoff, not a wait", async () => {
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 5,
        error: "Rate limited",
        structuredError: new RateLimitError("Rate limited", {}),
      }),
    );
    const delayFn = vi.fn(async () => {});

    await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, mcp: false, autoWaitMinutes: 600 },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    // The transient ladder's exponential backoff (5s, 10s) — NOT a window wait.
    expect(delayFn.mock.calls.map((c) => c[0])).toEqual([
      RATE_LIMIT_RETRY_BACKOFF_MS,
      RATE_LIMIT_RETRY_BACKOFF_MS * 2,
    ]);
  });

  it("AC-7: an aborted wait halts instead of retrying", async () => {
    const now = Date.now();
    const executePhaseFn = vi.fn(async () => windowFailure(10 * MINUTE, now));
    const shutdownManager = new ShutdownManagerStub();
    // Abort as soon as the wait registers its controller.
    const delayFn = vi.fn(async () => {
      shutdownManager.abortAll();
    });

    const result = await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, autoWaitMinutes: 600 },
      undefined,
      undefined,
      shutdownManager as unknown as ShutdownManager,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(false);
    // Only the original attempt: the interrupted wait must not re-spawn.
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
  });

  it("AC-7: emits onAutoWait liveness notices, ending with a terminal one", async () => {
    const now = Date.now();
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(windowFailure(10 * MINUTE, now))
      .mockResolvedValueOnce(makeResult({ success: true }));
    const delayFn = vi.fn(async () => {});
    const notices: Array<{ done: boolean; message: string }> = [];

    await executePhaseWithRetry(
      1,
      "exec",
      {
        ...baseConfig,
        autoWaitMinutes: 600,
        onAutoWait: (n) => notices.push({ done: n.done, message: n.message }),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(notices.length).toBeGreaterThan(1);
    expect(notices.filter((n) => n.done)).toHaveLength(1);
    expect(notices[notices.length - 1].done).toBe(true);
    // AC-5: the cause is the driver's formatted message; the wake time is a
    // distinct value, never the raw resetsAt appended to a formatted string.
    expect(notices[0].message).toContain("Rate limited — resets at");
    expect(notices[0].message).toContain("auto-wait 1/2");
    expect(notices[0].message).not.toMatch(/resets at .*resets at/);
  });

  it("#804: auto-wait also covers the loop phase (maxRetries: 0 path)", async () => {
    const now = Date.now();
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(windowFailure(10 * MINUTE, now))
      .mockResolvedValueOnce(makeResult({ phase: "loop", success: true }));
    const delayFn = vi.fn(async () => {});

    const result = await executePhaseWithRetry(
      1,
      "loop",
      { ...baseConfig, autoWaitMinutes: 600 },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    // Without the auto-wait branch in the skipColdStartRetry arm, `loop` would
    // halt on the first window failure even with the flag set.
    expect(result.success).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(2);
  });
});

/** Minimal stand-in exposing just the abort surface auto-wait uses. */
class ShutdownManagerStub {
  private controllers = new Set<AbortController>();
  addAbortController(c: AbortController): void {
    this.controllers.add(c);
  }
  removeAbortController(c: AbortController): void {
    this.controllers.delete(c);
  }
  abortAll(): void {
    for (const c of this.controllers) c.abort();
  }
}

describe("#804 halt predicate separability (AC-8)", () => {
  // Built per-test, not once at collection time: `isWindowExhaustedRateLimit`
  // compares `resetsAt` against the clock at ASSERTION time, so a fixture
  // frozen at collection silently decays into a transient limit if the suite
  // runs long enough.
  const windowResult = (): PhaseResult => ({
    phase: "qa",
    success: false,
    structuredError: new RateLimitError("Rate limited", {
      resetsAt: Date.now() + 2 * HOUR,
    }),
  });
  const billingResult = (): PhaseResult => ({
    phase: "qa",
    success: false,
    structuredError: new BillingError("Out of credits", {
      overageDisabledReason: "out_of_credits",
    }),
  });

  it("separates the two causes", () => {
    expect(isBillingHalt(billingResult())).toBe(true);
    expect(isWindowHalt(billingResult())).toBe(false);

    expect(isWindowHalt(windowResult())).toBe(true);
    expect(isBillingHalt(windowResult())).toBe(false);
  });

  it("preserves the union — current behavior when auto-wait did not fire", () => {
    expect(isBillingOrWindowHalt(billingResult())).toBe(true);
    expect(isBillingOrWindowHalt(windowResult())).toBe(true);
  });

  it("a phase that auto-waited and then SUCCEEDED is never a halt", () => {
    // Pins the reason AC-8 needed no behavioral change: every call site guards
    // on `!result.success`, and a successful result carries no structuredError
    // for the predicate to fire on. Were a future refactor to consult the
    // predicate on the success path, this test fails.
    const recovered: PhaseResult = { phase: "qa", success: true };
    expect(isBillingOrWindowHalt(recovered)).toBe(false);
    expect(isWindowHalt(recovered)).toBe(false);
    expect(isBillingHalt(recovered)).toBe(false);
  });
});

describe("#804 configuration plumbing (AC-1)", () => {
  // Build from the real DEFAULT_SETTINGS rather than a `{ run }`-only stub:
  // `resolveRunOptions` also reads `settings.agents`, so a partial cast
  // produces a TypeError that has nothing to do with what is under test.
  const withRun = (run: Partial<SequantSettings["run"]>): SequantSettings => ({
    ...DEFAULT_SETTINGS,
    run: RunSettingsSchema.parse(run),
  });
  const settings = withRun({});

  it("defaults to 0 — off — at every layer", () => {
    expect(DEFAULT_CONFIG.autoWaitMinutes).toBe(0);
    expect(RunSettingsSchema.parse({}).autoWaitMinutes).toBe(0);
    expect(buildExecutionConfig({}, settings, 1).autoWaitMinutes).toBe(0);
  });

  it("the CLI flag reaches ExecutionConfig", () => {
    expect(
      buildExecutionConfig({ autoWaitMinutes: 90 }, settings, 1)
        .autoWaitMinutes,
    ).toBe(90);
  });

  it("AC-1: Commander's `autoWait` key maps onto `autoWaitMinutes` end-to-end", () => {
    // Commander derives the option key from the FLAG (`--auto-wait`), so it
    // emits `autoWait` — NOT `autoWaitMinutes`. Without the normalization in
    // `normalizeCommanderOptions`, the flag parses, appears in `--help`, and
    // silently does nothing: the #305 failure mode, and the reason AC-1 says
    // "end-to-end" rather than "the option is registered".
    const fromCommander = { autoWait: 90 } as RunOptions;
    const resolved = resolveRunOptions(fromCommander, settings);
    expect(resolved.autoWaitMinutes).toBe(90);
    expect(buildExecutionConfig(resolved, settings, 1).autoWaitMinutes).toBe(
      90,
    );
  });

  it("an explicit `--auto-wait 0` overrides a non-zero setting", () => {
    // Guarded on `undefined` rather than truthiness — 0 is a meaningful value
    // (it is how a user turns auto-wait OFF for one run).
    const withSetting = withRun({ autoWaitMinutes: 120 });
    const resolved = resolveRunOptions(
      { autoWait: 0 } as RunOptions,
      withSetting,
    );
    expect(resolved.autoWaitMinutes).toBe(0);
    expect(buildExecutionConfig(resolved, withSetting, 1).autoWaitMinutes).toBe(
      0,
    );
  });

  it("settings supply the value when the flag is absent", () => {
    const withSetting = withRun({ autoWaitMinutes: 45 });
    expect(buildExecutionConfig({}, withSetting, 1).autoWaitMinutes).toBe(45);
  });

  it("the schema rejects a negative budget", () => {
    expect(() => RunSettingsSchema.parse({ autoWaitMinutes: -1 })).toThrow();
  });

  it("SEQUANT_AUTO_WAIT_MINUTES is read, and junk is ignored", () => {
    const prev = process.env.SEQUANT_AUTO_WAIT_MINUTES;
    try {
      process.env.SEQUANT_AUTO_WAIT_MINUTES = "120";
      expect(getEnvConfig().autoWaitMinutes).toBe(120);

      process.env.SEQUANT_AUTO_WAIT_MINUTES = "not-a-number";
      expect(getEnvConfig().autoWaitMinutes).toBeUndefined();

      // A negative budget must not silently become an unbounded wait.
      process.env.SEQUANT_AUTO_WAIT_MINUTES = "-30";
      expect(getEnvConfig().autoWaitMinutes).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SEQUANT_AUTO_WAIT_MINUTES;
      else process.env.SEQUANT_AUTO_WAIT_MINUTES = prev;
    }
  });
});

describe("#804 against the real 2026-07-18 capture (#782)", () => {
  const CAPTURE_DIR = new URL(
    "../../../docs/incidents/782/captures/2026-07-18/",
    import.meta.url,
  );
  const CAPTURES = [
    "run-2026-07-18T16-05-05-43494f55-7967-40b9-b04d-e0fb10475255.json",
    "run-2026-07-18T16-05-33-e9576956-94dd-4308-b886-52c8d025c3c7.json",
  ];

  function loadMetadata(file: string): RateLimitInfoLike {
    const raw = JSON.parse(
      readFileSync(new URL(file, CAPTURE_DIR), "utf8"),
    ) as {
      issues: {
        phases: { errorContext: { errorMetadata: RateLimitInfoLike } }[];
      }[];
    };
    return raw.issues[0].phases[0].errorContext.errorMetadata;
  }

  it.each(CAPTURES)(
    "%s: the real payload is a BillingError and must NOT auto-wait despite carrying resetsAt",
    (file) => {
      const metadata = loadMetadata(file);
      const error = createRateLimitError(metadata);

      // The load-bearing fact from docs/incidents/782/validation.md: real
      // window-exhaustion metadata is present, but this rejection also carried
      // `out_of_credits`, so it classifies as BillingError.
      expect(error).toBeInstanceOf(BillingError);
      expect(typeof metadata.resetsAt).toBe("number");
      expect(
        shouldAutoWaitForReset(error, createAutoWaitLedger(600), Date.now()),
      ).toBeNull();
    },
  );

  it.each(CAPTURES)(
    "%s: the counterfactual — the same metadata WITHOUT out_of_credits would auto-wait",
    (file) => {
      const metadata = loadMetadata(file);
      // Strip only the billing discriminators; keep the real resetsAt/type.
      const { overageDisabledReason: _o, errorCode: _e, ...rest } = metadata;
      const error = createRateLimitError(rest);
      expect(error).toBeInstanceOf(RateLimitError);

      // Evaluate at the captured phase's own start time, where the reset was
      // ~24.8 minutes out — well past the 5-minute exhaustion threshold.
      const capturedNow = resetsAtToMs(metadata.resetsAt!) - 24.8 * MINUTE;
      expect(isWindowExhaustedRateLimit(error, capturedNow)).toBe(true);

      const decision = shouldAutoWaitForReset(
        error,
        createAutoWaitLedger(60),
        capturedNow,
      );
      expect(decision).not.toBeNull();
      expect(decision!.wakeAtMs).toBe(
        resetsAtToMs(metadata.resetsAt!) + AUTO_WAIT_BUFFER_MS,
      );
    },
  );
});
