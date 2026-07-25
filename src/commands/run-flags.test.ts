/**
 * Unit tests for run flag resolvers (#705).
 *
 * Covers AC-1 (`-q`/`-Q` both enable the quality loop), AC-3 (boxed TUI default
 * on a TTY), and AC-4 (`--no-tui` and non-TTY degrade to the line renderer).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  deprecatedFlagNotices,
  normalizeQualityLoop,
  resolveTuiEnabled,
  warnDeprecatedFlags,
} from "./run-flags.js";
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

describe("deprecatedFlagNotices (#795 AC-2)", () => {
  it("returns no notices when --qa-gate is absent", () => {
    expect(deprecatedFlagNotices({})).toEqual([]);
    expect(deprecatedFlagNotices({ chain: true })).toEqual([]);
  });

  it("returns a notice when --qa-gate is set", () => {
    const notices = deprecatedFlagNotices({ qaGate: true });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/--qa-gate is deprecated/);
    // The notice must tell the user what to do instead, not just that it died.
    expect(notices[0]).toMatch(/--chain already halts/);
  });

  it("returns the notice regardless of --chain (no longer a hard requirement)", () => {
    // Before #795, --qa-gate without --chain printed an error and aborted the
    // whole run. Both combinations must now produce the same advisory notice.
    expect(deprecatedFlagNotices({ qaGate: true })).toEqual(
      deprecatedFlagNotices({ qaGate: true, chain: true }),
    );
  });

  it("never mentions the removed 'requires --chain' constraint", () => {
    expect(deprecatedFlagNotices({ qaGate: true })[0]).not.toMatch(
      /requires --chain/,
    );
  });
});

describe("warnDeprecatedFlags (#795 AC-2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the notice to stderr, not stdout", () => {
    // Deprecation notices are warnings. Routing them to stdout would pollute
    // the piped output of any script that consumes `sequant run`.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    warnDeprecatedFlags({ qaGate: true });

    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toMatch(/--qa-gate is deprecated/);
    expect(out).not.toHaveBeenCalled();
  });

  it("is NOT suppressed by --quiet", () => {
    // `--quiet` suppresses progress and version chatter; it is not a warning
    // switch. CI scripts are both the likeliest holders of a stale --qa-gate
    // and the likeliest users of --quiet, so gating here would silence the
    // deprecation window for exactly its target audience.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    warnDeprecatedFlags({ qaGate: true, quiet: true });

    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toMatch(/--qa-gate is deprecated/);
  });

  it("emits nothing when no deprecated flag is set", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    warnDeprecatedFlags({ chain: true, quiet: true });

    expect(err).not.toHaveBeenCalled();
  });
});
