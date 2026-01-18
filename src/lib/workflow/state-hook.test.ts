/**
 * Tests for state hook
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  createStateHook,
  isOrchestrated,
  getOrchestrationContext,
} from "./state-hook.js";

describe("state-hook", () => {
  let tempDir: string;
  let statePath: string;
  const originalEnv = process.env;

  beforeEach(() => {
    // Create temp directory for test state files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-hook-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");

    // Reset environment
    vi.stubEnv("SEQUANT_ORCHESTRATOR", "");
    vi.stubEnv("SEQUANT_PHASE", "");
    vi.stubEnv("SEQUANT_ISSUE", "");
    vi.stubEnv("SEQUANT_WORKTREE", "");
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("isOrchestrated", () => {
    it("should return false when SEQUANT_ORCHESTRATOR is not set", () => {
      expect(isOrchestrated()).toBe(false);
    });

    it("should return true when SEQUANT_ORCHESTRATOR is set", () => {
      vi.stubEnv("SEQUANT_ORCHESTRATOR", "sequant-run");
      expect(isOrchestrated()).toBe(true);
    });
  });

  describe("getOrchestrationContext", () => {
    it("should return undefined values when not orchestrated", () => {
      const ctx = getOrchestrationContext();
      expect(ctx.orchestrator).toBeFalsy();
      expect(ctx.phase).toBeFalsy();
      expect(ctx.issue).toBeUndefined();
      expect(ctx.worktree).toBeFalsy();
    });

    it("should return context values when orchestrated", () => {
      vi.stubEnv("SEQUANT_ORCHESTRATOR", "sequant-run");
      vi.stubEnv("SEQUANT_PHASE", "exec");
      vi.stubEnv("SEQUANT_ISSUE", "42");
      vi.stubEnv("SEQUANT_WORKTREE", "/path/to/worktree");

      const ctx = getOrchestrationContext();
      expect(ctx.orchestrator).toBe("sequant-run");
      expect(ctx.phase).toBe("exec");
      expect(ctx.issue).toBe(42);
      expect(ctx.worktree).toBe("/path/to/worktree");
    });
  });

  describe("createStateHook (orchestrated mode)", () => {
    beforeEach(() => {
      vi.stubEnv("SEQUANT_ORCHESTRATOR", "sequant-run");
    });

    it("should return inactive hook", () => {
      const hook = createStateHook(42, "Test Issue");
      expect(hook.isActive).toBe(false);
    });

    it("should have no-op methods that don't throw", async () => {
      const hook = createStateHook(42, "Test Issue");

      // None of these should throw
      await expect(hook.startPhase("exec")).resolves.toBeUndefined();
      await expect(hook.completePhase("exec", true)).resolves.toBeUndefined();
      await expect(hook.skipPhase("spec")).resolves.toBeUndefined();
      await expect(
        hook.updateIssueStatus("in_progress"),
      ).resolves.toBeUndefined();
      await expect(
        hook.updateSessionId("session-123"),
      ).resolves.toBeUndefined();
      await expect(
        hook.updatePRInfo(123, "https://github.com/test"),
      ).resolves.toBeUndefined();
    });
  });

  describe("createStateHook (standalone mode)", () => {
    it("should return active hook", () => {
      const hook = createStateHook(42, "Test Issue", { statePath });
      expect(hook.isActive).toBe(true);
    });

    it("should initialize issue on first operation", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.startPhase("exec");

      // Check state file was created
      expect(fs.existsSync(statePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"]).toBeDefined();
      expect(content.issues["42"].title).toBe("Test Issue");
    });

    it("should update phase status on startPhase", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.startPhase("exec");

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"].phases["exec"]).toBeDefined();
      expect(content.issues["42"].phases["exec"].status).toBe("in_progress");
    });

    it("should update phase status on completePhase (success)", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.startPhase("exec");
      await hook.completePhase("exec", true);

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"].phases["exec"].status).toBe("completed");
    });

    it("should update phase status on completePhase (failure)", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.startPhase("exec");
      await hook.completePhase("exec", false, "Something went wrong");

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"].phases["exec"].status).toBe("failed");
      expect(content.issues["42"].phases["exec"].error).toBe(
        "Something went wrong",
      );
    });

    it("should update phase status on skipPhase", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.skipPhase("spec");

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"].phases["spec"].status).toBe("skipped");
    });

    it("should update issue status", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.startPhase("exec");
      await hook.updateIssueStatus("ready_for_merge");

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"].status).toBe("ready_for_merge");
    });

    it("should update session ID", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.startPhase("exec");
      await hook.updateSessionId("session-abc123");

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"].sessionId).toBe("session-abc123");
    });

    it("should update PR info", async () => {
      const hook = createStateHook(42, "Test Issue", { statePath });

      await hook.startPhase("exec");
      await hook.updatePRInfo(123, "https://github.com/owner/repo/pull/123");

      const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(content.issues["42"].pr).toBeDefined();
      expect(content.issues["42"].pr.number).toBe(123);
      expect(content.issues["42"].pr.url).toBe(
        "https://github.com/owner/repo/pull/123",
      );
    });

    it("should not throw on state errors", async () => {
      // Create hook with invalid path that can't be written to
      const hook = createStateHook(42, "Test Issue", {
        statePath: "/nonexistent/path/state.json",
      });

      // These should not throw even though state can't be written
      await expect(hook.startPhase("exec")).resolves.toBeUndefined();
    });
  });
});
