/**
 * Tests for the active run registry
 * Issue #394: MCP server real-time progress reporting
 *
 * Covers:
 * - AC-5: Active run registry tracks spawned processes by issue number
 * - AC-6: isRunning returns false after run completes / is unregistered
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRun,
  unregisterRun,
  isRunning,
  getActiveRuns,
  clearRegistry,
} from "./run-registry.js";

describe("Run Registry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  describe("AC-5: registry tracks spawned processes by issue number", () => {
    it("should register and track a run", () => {
      registerRun(42);

      expect(isRunning(42)).toBe(true);
      const runs = getActiveRuns();
      expect(runs.get(42)!.startedAt).toBeDefined();
    });

    it("should track multiple concurrent runs", () => {
      registerRun(42);
      registerRun(100);

      expect(isRunning(42)).toBe(true);
      expect(isRunning(100)).toBe(true);
      expect(getActiveRuns().size).toBe(2);
    });

    it("should replace run if same issue registered again", () => {
      const before = new Date().toISOString();
      registerRun(42);
      registerRun(42);

      expect(isRunning(42)).toBe(true);
      expect(getActiveRuns().size).toBe(1);
      expect(getActiveRuns().get(42)!.startedAt >= before).toBe(true);
    });
  });

  describe("AC-6: isRunning returns false after cleanup", () => {
    it("should return false for untracked issues", () => {
      expect(isRunning(99999)).toBe(false);
    });

    it("should return false after unregisterRun", () => {
      registerRun(42);
      expect(isRunning(42)).toBe(true);

      unregisterRun(42);
      expect(isRunning(42)).toBe(false);
    });

    it("should not throw when unregistering non-existent issue", () => {
      expect(() => unregisterRun(99999)).not.toThrow();
    });

    it("should clear all runs", () => {
      registerRun(1);
      registerRun(2);
      clearRegistry();

      expect(isRunning(1)).toBe(false);
      expect(isRunning(2)).toBe(false);
      expect(getActiveRuns().size).toBe(0);
    });
  });
});
