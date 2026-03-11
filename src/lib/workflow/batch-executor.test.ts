/**
 * Direct import tests for batch-executor module.
 *
 * These tests verify that batch-executor exports are importable
 * directly and test pure functions.
 */

import { describe, it, expect } from "vitest";
import {
  parseBatches,
  getEnvConfig,
  executeBatch,
  runIssueWithLogging,
} from "./batch-executor.js";
import type { RunOptions } from "./batch-executor.js";

describe("batch-executor direct imports", () => {
  describe("parseBatches", () => {
    it("should parse single batch", () => {
      expect(parseBatches(["1 2 3"])).toEqual([[1, 2, 3]]);
    });

    it("should parse multiple batches", () => {
      expect(parseBatches(["1 2", "3 4"])).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    it("should filter NaN values", () => {
      expect(parseBatches(["1 abc 3"])).toEqual([[1, 3]]);
    });

    it("should handle empty batch", () => {
      expect(parseBatches([""])).toEqual([[]]);
    });
  });

  describe("getEnvConfig", () => {
    const originalEnv = process.env;

    it("should return empty config when no env vars set", () => {
      delete process.env.SEQUANT_QUALITY_LOOP;
      delete process.env.SEQUANT_MAX_ITERATIONS;
      delete process.env.SEQUANT_SMART_TESTS;
      delete process.env.SEQUANT_TESTGEN;
      const config = getEnvConfig();
      expect(config.qualityLoop).toBeUndefined();
      expect(config.maxIterations).toBeUndefined();
    });

    it("should parse SEQUANT_QUALITY_LOOP", () => {
      process.env.SEQUANT_QUALITY_LOOP = "true";
      const config = getEnvConfig();
      expect(config.qualityLoop).toBe(true);
      delete process.env.SEQUANT_QUALITY_LOOP;
    });

    it("should parse SEQUANT_MAX_ITERATIONS", () => {
      process.env.SEQUANT_MAX_ITERATIONS = "5";
      const config = getEnvConfig();
      expect(config.maxIterations).toBe(5);
      delete process.env.SEQUANT_MAX_ITERATIONS;
    });
  });

  describe("RunOptions type", () => {
    it("should accept valid RunOptions", () => {
      const opts: RunOptions = {
        phases: "spec,exec,qa",
        sequential: true,
        dryRun: false,
        chain: true,
      };
      expect(opts.sequential).toBe(true);
    });
  });

  describe("exports exist", () => {
    it("should export async execution functions", () => {
      expect(typeof executeBatch).toBe("function");
      expect(typeof runIssueWithLogging).toBe("function");
    });
  });
});
