/**
 * #1059 F4 — `generateSettingsJsonc` emits `run.agent`.
 *
 * `init --agent <name>` provisions for a driver, and the settings it writes
 * have to name that driver: without the key, `run.agent` stays unset, every
 * later `sequant run` falls back to claude-code, and `doctor` silently runs
 * none of that driver's checks. The key is optional, so it is emitted only
 * when set — a default init keeps writing the file it always wrote.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, generateSettingsJsonc } from "./settings.js";

describe("1059 F4: run.agent in generated settings", () => {
  it("emits the agent key when one is configured", () => {
    const jsonc = generateSettingsJsonc({
      ...DEFAULT_SETTINGS,
      run: { ...DEFAULT_SETTINGS.run, agent: "codex" },
    });

    expect(jsonc).toContain('"agent": "codex"');
    // The generated file is parsed back through the JSONC path, so the
    // addition must not break the shape.
    expect(() => JSON.parse(stripComments(jsonc))).not.toThrow();
    expect(JSON.parse(stripComments(jsonc)).run.agent).toBe("codex");
  });

  it("omits the agent key when none is configured", () => {
    const jsonc = generateSettingsJsonc(DEFAULT_SETTINGS);

    expect(jsonc).not.toContain('"agent"');
  });
});

/** Minimal JSONC comment strip, matching what the loader does. */
function stripComments(jsonc: string): string {
  return jsonc
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}
