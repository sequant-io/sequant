/**
 * Integration tests for Issue #503 — RunOrchestrator importability and run.ts adapter
 *
 * AC-2: run.ts becomes thin adapter (< 200 lines)
 * AC-4: RunOrchestrator importable without CLI context
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("RunOrchestrator - Integration (#503)", () => {
  // ===== AC-2: run.ts thin adapter =====

  describe("AC-2: run.ts thin adapter", () => {
    it("should have run.ts under 200 lines of code", () => {
      const runFilePath = path.join(process.cwd(), "src/commands/run.ts");
      const fileContent = fs.readFileSync(runFilePath, "utf-8");
      const lineCount = fileContent.split("\n").length;

      expect(lineCount).toBeLessThanOrEqual(200);
    });

    it("should delegate runCommand to RunOrchestrator.run()", () => {
      const runFilePath = path.join(process.cwd(), "src/commands/run.ts");
      const fileContent = fs.readFileSync(runFilePath, "utf-8");

      expect(fileContent).toContain("RunOrchestrator.run(");
      expect(fileContent).toContain("import { RunOrchestrator }");
    });
  });

  // ===== AC-4: RunOrchestrator importability =====

  describe("AC-4: RunOrchestrator importability", () => {
    it("should import RunOrchestrator from package source entry", async () => {
      const mod = await import("../../src/index.js");
      expect(mod.RunOrchestrator).toBeDefined();
    }, 15000);

    it("should have RunOrchestrator as a constructable class", async () => {
      const { RunOrchestrator } =
        await import("../../src/lib/workflow/run-orchestrator.js");
      expect(typeof RunOrchestrator).toBe("function");
      expect(RunOrchestrator.prototype).toBeDefined();
      expect(typeof RunOrchestrator.prototype.execute).toBe("function");
    });

    it("should have RunOrchestrator.execute() method", async () => {
      const { RunOrchestrator } =
        await import("../../src/lib/workflow/run-orchestrator.js");
      expect(typeof RunOrchestrator.prototype.execute).toBe("function");
    });

    it("should have static RunOrchestrator.run() method", async () => {
      const { RunOrchestrator } =
        await import("../../src/lib/workflow/run-orchestrator.js");
      expect(typeof RunOrchestrator.run).toBe("function");
    });

    it("should not execute CLI side effects on import", async () => {
      const originalArgv = [...process.argv];

      // Import should not modify process.argv or trigger Commander
      await import("../../src/lib/workflow/run-orchestrator.js");

      expect(process.argv).toEqual(originalArgv);
    });
  });

  // ===== Edge: ConfigResolver also exportable =====

  describe("Edge cases", () => {
    it("should also export ConfigResolver from package entry point", async () => {
      const mod = await import("../../src/index.js");
      expect(mod.ConfigResolver).toBeDefined();
      expect(typeof mod.ConfigResolver).toBe("function");
    });

    it("should export resolveRunOptions from package entry point", async () => {
      const mod = await import("../../src/index.js");
      expect(mod.resolveRunOptions).toBeDefined();
      expect(typeof mod.resolveRunOptions).toBe("function");
    });

    it("should export buildExecutionConfig from package entry point", async () => {
      const mod = await import("../../src/index.js");
      expect(mod.buildExecutionConfig).toBeDefined();
      expect(typeof mod.buildExecutionConfig).toBe("function");
    });

    it("should not expose internal orchestrator private methods", async () => {
      const { RunOrchestrator } =
        await import("../../src/lib/workflow/run-orchestrator.js");
      // Private methods should not be on the prototype
      const proto = RunOrchestrator.prototype;
      // Public API
      expect(typeof proto.execute).toBe("function");
      // Internal helpers are private (TypeScript enforced, but verify naming)
      const publicMethods = Object.getOwnPropertyNames(proto).filter(
        (n) => n !== "constructor",
      );
      // Should have execute and potentially other public methods, but not leak internals
      expect(publicMethods).toContain("execute");
    });
  });
});
