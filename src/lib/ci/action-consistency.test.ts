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

    it("defines sequant-version input with pinned default", () => {
      expect(actionYml).toMatch(/^\s+sequant-version:\s*$/m);
      // Default must be a pinned range, not "latest"
      expect(actionYml).not.toContain('default: "latest"');
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
    // Extract run: block contents by splitting on YAML step boundaries.
    // Each run: | block ends at the next step (- ), top-level key, or EOF.
    function extractRunBlocks(yml: string): string[] {
      const blocks: string[] = [];
      const lines = yml.split("\n");
      let inRunBlock = false;
      let runIndent = 0;
      let currentBlock: string[] = [];

      for (const line of lines) {
        if (/^\s+run:\s*\|/.test(line)) {
          inRunBlock = true;
          runIndent = line.search(/\S/);
          currentBlock = [];
          continue;
        }

        if (inRunBlock) {
          // End of run block: line at same or lesser indent that isn't blank
          const lineIndent = line.search(/\S/);
          if (line.trim() && lineIndent <= runIndent) {
            blocks.push(currentBlock.join("\n"));
            inRunBlock = false;
            continue;
          }
          currentBlock.push(line);
        }
      }

      // Capture last block if file ends inside a run block
      if (inRunBlock && currentBlock.length > 0) {
        blocks.push(currentBlock.join("\n"));
      }

      return blocks;
    }

    const runBlocks = extractRunBlocks(actionYml);

    it("finds run blocks to test (sanity check)", () => {
      // action.yml has multiple run: | blocks — if this fails, the
      // extraction logic is broken and the security tests are vacuous.
      expect(runBlocks.length).toBeGreaterThanOrEqual(4);
    });

    it("does not interpolate inputs directly in run blocks", () => {
      for (const block of runBlocks) {
        // ${{ inputs.* }} should NOT appear inside run: blocks
        // (they should be passed via env: bindings instead)
        const inputRefs = block.match(/\$\{\{\s*inputs\./g);
        expect(inputRefs).toBeNull();
      }
    });

    it("does not set api-key as both ANTHROPIC and OPENAI env vars", () => {
      // The API key should only be set for the selected agent's env var,
      // not blindly exported as both. Leaking a secret to an unrelated
      // env var is unnecessary exposure.
      const envSection = actionYml.match(/env:[\s\S]*?(?=^\s+run:)/gm);
      if (!envSection) return;
      const envText = envSection.join("\n");
      // Both ANTHROPIC_API_KEY and OPENAI_API_KEY should NOT appear
      // as static env bindings to the same input
      const anthropicBindings = (
        envText.match(/ANTHROPIC_API_KEY:.*inputs\.api-key/g) || []
      ).length;
      const openaiBindings = (
        envText.match(/OPENAI_API_KEY:.*inputs\.api-key/g) || []
      ).length;
      expect(anthropicBindings + openaiBindings).toBeLessThanOrEqual(1);
    });

    it("does not interpolate untrusted event data in run blocks", () => {
      // User-controlled event fields that must never be in run: blocks:
      // - github.event.comment.body (arbitrary user text)
      // - github.event.issue.title (arbitrary user text)
      // - github.event.issue.body (arbitrary user text)
      // - github.event.pull_request.title/body (arbitrary user text)
      const dangerousPatterns = [
        /\$\{\{\s*github\.event\.comment\.body/,
        /\$\{\{\s*github\.event\.issue\.title/,
        /\$\{\{\s*github\.event\.issue\.body/,
        /\$\{\{\s*github\.event\.pull_request\.title/,
        /\$\{\{\s*github\.event\.pull_request\.body/,
      ];

      for (const block of runBlocks) {
        for (const pattern of dangerousPatterns) {
          expect(block).not.toMatch(pattern);
        }
      }
    });
  });
});
