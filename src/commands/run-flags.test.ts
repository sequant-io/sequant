/**
 * Unit tests for run flag resolvers (#705).
 *
 * Covers AC-1 (`-q`/`-Q` both enable the quality loop), AC-3 (boxed TUI default
 * on a TTY), and AC-4 (`--no-tui` and non-TTY degrade to the line renderer).
 */

import { describe, it, expect } from "vitest";
import { normalizeQualityLoop, resolveTuiEnabled } from "./run-flags.js";
import type { RunOptions } from "../lib/workflow/types.js";

describe("normalizeQualityLoop (#705 AC-1)", () => {
  it("returns true when -Q/--quality-loop is set", () => {
    expect(normalizeQualityLoop({ qualityLoop: true })).toBe(true);
  });

  it("returns true when the hidden -q alias is set", () => {
    expect(normalizeQualityLoop({ qualityLoopAlias: true })).toBe(true);
  });

  it("returns true when both -q and -Q are set (identical behavior)", () => {
    expect(
      normalizeQualityLoop({ qualityLoop: true, qualityLoopAlias: true }),
    ).toBe(true);
  });

  it("returns false when neither is set", () => {
    expect(normalizeQualityLoop({})).toBe(false);
  });

  it("never reads quiet — quiet does not enable the quality loop", () => {
    // Regression guard for the original -q/-Q collision: a quiet flag must not
    // leak into the quality-loop decision.
    expect(normalizeQualityLoop({ quiet: true } as RunOptions)).toBe(false);
  });
});

describe("resolveTuiEnabled (#705 AC-3, AC-4, AC-2)", () => {
  it("AC-3: defaults to true on a TTY (no flags)", () => {
    expect(resolveTuiEnabled({}, true)).toBe(true);
  });

  it("AC-4: --no-tui (tui === false) opts out even on a TTY", () => {
    expect(resolveTuiEnabled({ tui: false }, true)).toBe(false);
  });

  it("AC-4: non-TTY auto-degrades to the line renderer", () => {
    expect(resolveTuiEnabled({}, false)).toBe(false);
  });

  it("AC-2: --quiet suppresses the TUI even on a TTY", () => {
    expect(resolveTuiEnabled({ quiet: true }, true)).toBe(false);
  });

  it("AC-5: --experimental-tui is a no-op (does not gate rendering)", () => {
    // The default already enables the TUI on a TTY; the alias must not be
    // required, and its absence must not disable the default.
    expect(resolveTuiEnabled({ experimentalTui: true }, true)).toBe(true);
    expect(resolveTuiEnabled({ experimentalTui: undefined }, true)).toBe(true);
  });

  it("quiet beats the TUI default regardless of --no-tui (AC-2 precedence)", () => {
    expect(resolveTuiEnabled({ quiet: true, tui: false }, true)).toBe(false);
  });
});
