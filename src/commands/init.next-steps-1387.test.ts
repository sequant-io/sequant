/**
 * #1387 AC-2: init's next steps name the commit step and `sequant run`.
 */

import { describe, expect, it } from "vitest";
import { buildNextSteps } from "./init.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("buildNextSteps (#1387)", () => {
  describe("AC-2: next steps include commit and run", () => {
    it("includes a commit step naming .claude/skills/ before `sequant run <issue>`", () => {
      const steps = stripAnsi(buildNextSteps());
      const commit = steps.indexOf("git commit");
      const run = steps.indexOf("npx sequant run");
      expect(steps).toContain(".claude/");
      expect(commit).toBeGreaterThan(-1);
      expect(run).toBeGreaterThan(commit);
    });

    describe("error handling", () => {
      it("keeps the existing /spec, /exec, /qa and constitution steps", () => {
        const steps = stripAnsi(buildNextSteps());
        expect(steps).toContain(".claude/memory/constitution.md");
        for (const cmd of ["/spec 123", "/exec 123", "/qa 123"]) {
          expect(steps).toContain(cmd);
        }
      });

      it("uses the npx-style invocation consistent with the README", () => {
        expect(stripAnsi(buildNextSteps())).toMatch(/npx sequant run \d+/);
      });
    });
  });
});
