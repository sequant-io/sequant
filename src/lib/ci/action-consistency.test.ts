/**
 * Consistency tests — verify that sequant-action/action.yml references
 * match the TypeScript constants in types.ts.
 *
 * The action.yml composite action uses inline shell scripts that reference
 * label names and input fields. These tests catch divergence between the
 * tested TypeScript module and the shell code that runs in CI.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRIGGER_LABELS, LIFECYCLE_LABELS, CI_DEFAULTS } from "./types.js";

function loadActionYml(): string {
  const actionPath = join(
    __dirname,
    "..",
    "..",
    "..",
    "sequant-action",
    "action.yml",
  );
  return readFileSync(actionPath, "utf-8");
}

describe("action.yml consistency with TypeScript constants", () => {
  const actionYml = loadActionYml();

  describe("trigger labels", () => {
    for (const [key, label] of Object.entries(TRIGGER_LABELS)) {
      it(`references trigger label ${key} (${label})`, () => {
        expect(actionYml).toContain(label);
      });
    }
  });

  describe("lifecycle labels", () => {
    for (const [key, label] of Object.entries(LIFECYCLE_LABELS)) {
      it(`references lifecycle label ${key} (${label})`, () => {
        expect(actionYml).toContain(label);
      });
    }
  });

  describe("default values", () => {
    it("default agent matches CI_DEFAULTS", () => {
      expect(actionYml).toContain(`default: "${CI_DEFAULTS.agent}"`);
    });

    it("default timeout matches CI_DEFAULTS", () => {
      expect(actionYml).toContain(`default: "${CI_DEFAULTS.timeout}"`);
    });

    it("default phases matches CI_DEFAULTS", () => {
      const phasesStr = CI_DEFAULTS.phases.join(",");
      expect(actionYml).toContain(`default: "${phasesStr}"`);
    });
  });

  describe("required inputs", () => {
    it("defines issues input", () => {
      expect(actionYml).toMatch(/^\s+issues:\s*$/m);
    });

    it("defines phases input", () => {
      expect(actionYml).toMatch(/^\s+phases:\s*$/m);
    });

    it("defines agent input", () => {
      expect(actionYml).toMatch(/^\s+agent:\s*$/m);
    });

    it("defines timeout input", () => {
      expect(actionYml).toMatch(/^\s+timeout:\s*$/m);
    });

    it("defines api-key input", () => {
      expect(actionYml).toMatch(/^\s+api-key:\s*$/m);
    });
  });

  describe("required outputs", () => {
    it("defines success output", () => {
      expect(actionYml).toMatch(/^\s+success:\s*$/m);
    });

    it("defines pr-url output", () => {
      expect(actionYml).toMatch(/^\s+pr-url:\s*$/m);
    });

    it("defines summary output", () => {
      expect(actionYml).toMatch(/^\s+summary:\s*$/m);
    });

    it("defines issue output", () => {
      expect(actionYml).toMatch(/^\s+issue:\s*$/m);
    });

    it("defines duration output", () => {
      expect(actionYml).toMatch(/^\s+duration:\s*$/m);
    });
  });

  describe("security", () => {
    it("does not interpolate inputs directly in run blocks", () => {
      // Extract all run: blocks
      const runBlocks = actionYml.match(
        /^\s+run:\s*\|[\s\S]*?(?=^\s+(?:-|[a-z])|\z)/gm,
      );
      if (!runBlocks) return;

      for (const block of runBlocks) {
        // ${{ inputs.* }} should NOT appear inside run: blocks
        // (they should be passed via env: bindings instead)
        const inputRefs = block.match(/\$\{\{\s*inputs\./g);
        expect(inputRefs).toBeNull();
      }
    });
  });
});
