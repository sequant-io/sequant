/**
 * #1197 AC-1/AC-2 — `settings.run.prIssueLink`/`prNoCloseLabel` reach
 * `ExecutionConfig` through the single producer, `buildExecutionConfig`, so
 * `createPR` (in `worktree-manager.ts`) resolves the same mode a caller
 * reading raw settings would.
 */

import { describe, it, expect } from "vitest";
import { buildExecutionConfig, resolveRunOptions } from "./config-resolver.js";
import type { RunOptions } from "./types.js";
import { DEFAULT_SETTINGS, validateSettings } from "../settings.js";
import type { SequantSettings } from "../settings.js";

function settingsWith(run: Partial<SequantSettings["run"]>): SequantSettings {
  return {
    ...DEFAULT_SETTINGS,
    run: { ...DEFAULT_SETTINGS.run, ...run },
  } as SequantSettings;
}

function resolve(settings: SequantSettings) {
  return buildExecutionConfig(
    resolveRunOptions({} as RunOptions, settings),
    settings,
    1,
  );
}

describe("run.prIssueLink / run.prNoCloseLabel (#1197)", () => {
  it("AC-1: defaults to 'closes' with no setting present", () => {
    expect(resolve(DEFAULT_SETTINGS).prIssueLink).toBe("closes");
  });

  it("AC-1: 'refs' in settings reaches ExecutionConfig.prIssueLink", () => {
    const config = resolve(settingsWith({ prIssueLink: "refs" }));
    expect(config.prIssueLink).toBe("refs");
  });

  it("AC-2: prNoCloseLabel defaults to 'no-autoclose'", () => {
    expect(resolve(DEFAULT_SETTINGS).prNoCloseLabel).toBe("no-autoclose");
  });

  it("AC-2: a configured prNoCloseLabel reaches ExecutionConfig", () => {
    const config = resolve(settingsWith({ prNoCloseLabel: "tracker-only" }));
    expect(config.prNoCloseLabel).toBe("tracker-only");
  });

  it("registers both keys — validateSettings emits no 'Unknown key' warning", () => {
    const { warnings } = validateSettings({
      version: "1.0",
      run: { prIssueLink: "refs", prNoCloseLabel: "tracker-only" },
    });
    expect(
      warnings.filter(
        (w) =>
          w.path.includes("prIssueLink") || w.path.includes("prNoCloseLabel"),
      ),
    ).toEqual([]);
  });
});
