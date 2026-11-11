/**
 * #1647 AC-3: a settings file that still sets `run.modelLadder` or
 * `run.effortEscalation` loads with exactly one warning per removed key that
 * names 3.0, and the run proceeds on the remaining settings.
 *
 * Before #1647, `run.effortEscalation` was missing from `KNOWN_KEYS.run`, so a
 * working setting already warned as unknown. The generic unknown-key warning
 * must not fire alongside the removal warning, or a user sees two messages
 * for one key.
 */

import { describe, it, expect } from "vitest";
import { validateSettings } from "./settings.js";
import {
  buildExecutionConfig,
  resolveRunOptions,
} from "./workflow/config-resolver.js";
import type { RunOptions } from "./workflow/types.js";

const RAW = {
  run: {
    timeout: 900,
    modelLadder: ["sonnet", "opus", "fable"],
    effortEscalation: true,
  },
};

describe("#1647 AC-3: removed settings keys", () => {
  it("warns exactly once per removed key, naming 3.0, with no unknown-key warning", () => {
    const { warnings } = validateSettings(RAW);

    for (const key of ["run.modelLadder", "run.effortEscalation"]) {
      const forKey = warnings.filter((w) => w.path === key);
      expect(forKey, key).toHaveLength(1);
      expect(forKey[0].message).toMatch(/removed in 3\.0/);
      expect(forKey[0].message).not.toMatch(/Unknown key/);
    }
    expect(warnings).toHaveLength(2);
  });

  it("loads the remaining settings and drops the removed keys", () => {
    const { settings } = validateSettings(RAW);

    expect(settings.run.timeout).toBe(900);
    expect("modelLadder" in settings.run).toBe(false);
    expect("effortEscalation" in settings.run).toBe(false);
  });

  it("the run proceeds: buildExecutionConfig resolves from those settings", () => {
    const { settings } = validateSettings(RAW);
    const config = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );

    expect(config.phaseTimeout).toBe(900);
    expect("modelLadder" in config).toBe(false);
    expect("effortEscalation" in config).toBe(false);
  });

  it("a removed key with a malformed value still warns once and does not void the file", () => {
    const { settings, warnings } = validateSettings({
      run: { timeout: 900, modelLadder: "sonnet,opus" },
    });

    expect(warnings.map((w) => w.path)).toEqual(["run.modelLadder"]);
    expect(settings.run.timeout).toBe(900);
  });
});

describe("#1648 AC-4: removed run.fullQa", () => {
  const RAW_FULLQA = { run: { timeout: 900, fullQa: true } };

  it("fullQa: warns exactly once, naming 3.0, with no unknown-key warning", () => {
    const { warnings } = validateSettings(RAW_FULLQA);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("run.fullQa");
    expect(warnings[0].message).toMatch(/removed in 3\.0/);
    expect(warnings[0].message).not.toMatch(/Unknown key/);
  });

  it("fullQa: drops the key, keeps sibling settings, and the run resolves without it", () => {
    const { settings } = validateSettings(RAW_FULLQA);
    const config = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );

    expect(settings.run.timeout).toBe(900);
    expect("fullQa" in settings.run).toBe(false);
    expect(config.fullQa).toBeFalsy();
  });
});
