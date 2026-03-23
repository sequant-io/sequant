import { describe, it, expect } from "vitest";
import { validateAiderSettings } from "../../../lib/settings.js";

describe("Aider Settings", () => {
  // AC-11: Settings support for aider config
  describe("AC-11: settings.json supports aider config", () => {
    it('should accept "aider" as run.agent value', () => {
      // Agent value is just a string field on RunSettings — validated at
      // driver lookup time. Here we test the aider-specific config parsing.
      const result = validateAiderSettings({
        model: "claude-3-sonnet",
        editFormat: "diff",
        extraArgs: ["--no-pretty"],
      });
      expect(result).toBeDefined();
      expect(result!.model).toBe("claude-3-sonnet");
    });

    it("should parse aider-specific config (model, editFormat, extraArgs)", () => {
      const result = validateAiderSettings({
        model: "claude-3-sonnet",
        editFormat: "diff",
        extraArgs: ["--no-pretty"],
      });
      expect(result!.model).toBe("claude-3-sonnet");
      expect(result!.editFormat).toBe("diff");
      expect(result!.extraArgs).toEqual(["--no-pretty"]);
    });

    it("should work without aider-specific config when agent is aider", () => {
      const result = validateAiderSettings(undefined);
      expect(result).toBeUndefined();
    });

    it("should accept empty object", () => {
      const result = validateAiderSettings({});
      expect(result).toBeDefined();
    });
  });

  // AC-13: Settings validated at load time
  describe("AC-13: aider settings validation", () => {
    it("should reject invalid model value", () => {
      expect(() => validateAiderSettings({ model: 123 })).toThrow(
        /model must be a string/,
      );
    });

    it("should reject invalid extraArgs (non-array)", () => {
      expect(() =>
        validateAiderSettings({ extraArgs: "not-an-array" }),
      ).toThrow(/extraArgs must be an array of strings/);
    });

    it("should reject extraArgs with non-string elements", () => {
      expect(() => validateAiderSettings({ extraArgs: [1, 2] })).toThrow(
        /extraArgs must be an array of strings/,
      );
    });

    it("should reject non-object aider config", () => {
      expect(() => validateAiderSettings("invalid")).toThrow(
        /must be an object/,
      );
    });

    it("should reject array aider config", () => {
      expect(() => validateAiderSettings([])).toThrow(/must be an object/);
    });
  });
});
