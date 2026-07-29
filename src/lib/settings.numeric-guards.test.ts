/**
 * #833 — `settings.json` as an entry point for the non-positive-number class.
 *
 * The CLI now rejects `--timeout 0`, but `settings.run.timeout` is the *other*
 * way that value reaches a timer, and it was `z.number()` with no constraint.
 * `commands/ready.ts` falls back to it directly and its value never passes
 * through `buildExecutionConfig`, so a `"timeout": 0` in settings.json reached
 * `setTimeout` as a 0 ms delay and aborted every ready-gate phase instantly —
 * silently, with no warning naming the bad key.
 *
 * The second half of this file covers the salvage bug that fixing the first
 * half would otherwise have made worse: `validateSettings` re-parsed `{}` on
 * any Zod failure, so one bad value discarded the user's whole settings file.
 * Its comment claimed it stripped invalid fields; it did not.
 */

import { describe, it, expect } from "vitest";
import { validateSettings, DEFAULT_SETTINGS } from "./settings.js";

/** A settings blob whose siblings are distinctive enough to prove survival. */
function withRun(run: Record<string, unknown>) {
  return {
    run: { logPath: "custom/logs", pmRun: "pnpm run", ...run },
    agents: { parallel: true },
  };
}

describe("#833 settings schema: non-positive numbers are named, not silently defaulted", () => {
  const GUARDED: Array<[string, number]> = [
    ["timeout", DEFAULT_SETTINGS.run.timeout],
    ["concurrency", DEFAULT_SETTINGS.run.concurrency],
    ["maxIterations", DEFAULT_SETTINGS.run.maxIterations],
  ];

  it.each(GUARDED)(
    "run.%s rejects 0 with a warning naming the key, and restores the default",
    (key, expectedDefault) => {
      const { settings, warnings } = validateSettings(withRun({ [key]: 0 }));

      expect(warnings.some((w) => w.message.includes(`run.${key}`))).toBe(true);
      expect(settings.run[key as "timeout"]).toBe(expectedDefault);
    },
  );

  it.each(GUARDED)("run.%s rejects negatives too", (key, expectedDefault) => {
    const { settings, warnings } = validateSettings(withRun({ [key]: -5 }));

    expect(warnings.some((w) => w.message.includes(`run.${key}`))).toBe(true);
    expect(settings.run[key as "timeout"]).toBe(expectedDefault);
  });

  it.each(GUARDED)("run.%s still accepts a valid positive value", (key) => {
    const { settings, warnings } = validateSettings(withRun({ [key]: 42 }));

    expect(settings.run[key as "timeout"]).toBe(42);
    expect(warnings.filter((w) => w.message.includes(`run.${key}`))).toEqual(
      [],
    );
  });

  it("leaves the resolved value usable as a setTimeout delay", () => {
    // The property that actually matters — a 0 ms delay is the instant abort.
    const { settings } = validateSettings(withRun({ timeout: 0 }));
    const delayMs = settings.run.timeout * 1000;

    expect(Number.isFinite(delayMs)).toBe(true);
    expect(delayMs).toBeGreaterThan(0);
  });

  it("does NOT constrain thresholds where 0 is meaningful", () => {
    // staleBranchThreshold 0 = warn on any drift; resolvedIssueTTL 0 = expire
    // immediately. Both are legitimate, so tightening them would be a
    // regression rather than a fix.
    const { settings } = validateSettings(
      withRun({ staleBranchThreshold: 0, resolvedIssueTTL: 0 }),
    );

    expect(settings.run.staleBranchThreshold).toBe(0);
    expect(settings.run.resolvedIssueTTL).toBe(0);
  });
});

describe("#833 validateSettings salvage: one bad key must not discard the file", () => {
  it("keeps valid siblings when a value fails a constraint", () => {
    const { settings } = validateSettings(withRun({ timeout: 0 }));

    expect(settings.run.logPath).toBe("custom/logs");
    expect(settings.run.pmRun).toBe("pnpm run");
    expect(settings.run.timeout).toBe(DEFAULT_SETTINGS.run.timeout);
  });

  it("keeps valid siblings when a value fails on type", () => {
    // The pre-existing case: this discarded the whole file before #833.
    const { settings } = validateSettings(withRun({ timeout: "fast" }));

    expect(settings.run.logPath).toBe("custom/logs");
    expect(settings.run.pmRun).toBe("pnpm run");
    expect(settings.run.timeout).toBe(DEFAULT_SETTINGS.run.timeout);
  });

  it("keeps valid siblings in OTHER sections", () => {
    const { settings } = validateSettings(withRun({ timeout: 0 }));

    expect(settings.agents.parallel).toBe(true);
  });

  it("salvages across two independent bad keys at once", () => {
    const { settings, warnings } = validateSettings(
      withRun({ timeout: 0, concurrency: -1 }),
    );

    expect(settings.run.timeout).toBe(DEFAULT_SETTINGS.run.timeout);
    expect(settings.run.concurrency).toBe(DEFAULT_SETTINGS.run.concurrency);
    expect(settings.run.logPath).toBe("custom/logs");
    expect(warnings.some((w) => w.message.includes("run.timeout"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("run.concurrency"))).toBe(
      true,
    );
  });

  it("drops a whole array rather than leaving a hole at a bad index", () => {
    // Deleting by index would leave `undefined` in place, which re-parses as a
    // fresh failure. The array is dropped and re-defaulted instead.
    const { settings } = validateSettings({
      run: { logPath: "custom/logs" },
      qa: { markdownOnlySafeCiPatterns: ["build (*)", 42] },
    });

    expect(settings.run.logPath).toBe("custom/logs");
    expect(Array.isArray(settings.qa.markdownOnlySafeCiPatterns)).toBe(true);
    expect(settings.qa.markdownOnlySafeCiPatterns).not.toContain(42);
  });

  it("falls back to defaults when the root itself is not an object", () => {
    for (const bad of ["nope", 42, [1, 2, 3], null, undefined]) {
      const { settings } = validateSettings(bad);
      expect(settings.run.timeout).toBe(DEFAULT_SETTINGS.run.timeout);
    }
  });

  it("never throws, whatever it is handed", () => {
    const nasty = [
      { run: { timeout: NaN } },
      { run: { timeout: Infinity } },
      { run: null },
      { run: { rotation: "not-an-object" } },
      {},
    ];

    for (const input of nasty) {
      expect(() => validateSettings(input)).not.toThrow();
    }
  });

  it("returns valid settings untouched with no warnings", () => {
    const { settings, warnings } = validateSettings(
      withRun({ timeout: 900, concurrency: 2, maxIterations: 5 }),
    );

    expect(settings.run.timeout).toBe(900);
    expect(settings.run.concurrency).toBe(2);
    expect(settings.run.maxIterations).toBe(5);
    expect(settings.run.logPath).toBe("custom/logs");
    expect(warnings).toEqual([]);
  });
});
