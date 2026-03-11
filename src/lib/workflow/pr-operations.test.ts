/**
 * Direct import tests for pr-operations module.
 *
 * These tests verify that pr-operations exports are importable
 * directly and test pure/deterministic behavior.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createCheckpointCommit,
  reinstallIfLockfileChanged,
  rebaseBeforePR,
  createPR,
} from "./pr-operations.js";
import type { RebaseResult, PRCreationResult } from "./pr-operations.js";

describe("pr-operations direct imports", () => {
  describe("exports exist", () => {
    it("should export all expected functions", () => {
      expect(typeof createCheckpointCommit).toBe("function");
      expect(typeof reinstallIfLockfileChanged).toBe("function");
      expect(typeof rebaseBeforePR).toBe("function");
      expect(typeof createPR).toBe("function");
    });
  });

  describe("type exports", () => {
    it("should export RebaseResult type", () => {
      const result: RebaseResult = {
        performed: true,
        success: true,
        reinstalled: false,
      };
      expect(result.performed).toBe(true);
    });

    it("should export PRCreationResult type", () => {
      const result: PRCreationResult = {
        attempted: true,
        success: true,
        prNumber: 42,
        prUrl: "https://example.com/pull/42",
      };
      expect(result.prNumber).toBe(42);
    });
  });
});
