/**
 * Exit-code coverage for `sequant status` failure paths (#848, AC-3 audit).
 *
 * These three sites were MISSED by the issue's own audit table but are the same
 * defect: `--rebuild` failure, `--cleanup` failure, and the state-read catch all
 * printed a red error and bare-returned at exit 0. Each must now set exit 1.
 * The underlying utilities are mocked to force the failure branches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/workflow/state-utils.js", () => ({
  rebuildStateFromLogs: vi.fn(),
  cleanupStaleEntries: vi.fn(),
}));

vi.mock("../lib/workflow/reconcile.js", () => ({
  reconcileState: vi.fn(),
  getNextActionHint: vi.fn(() => ""),
  formatRelativeTime: vi.fn(() => "just now"),
}));

// displayIssueState returns early unless state exists; stub it to true so the
// reconcile call (mocked to throw) actually reaches the try/catch under test.
vi.mock("../lib/workflow/state-manager.js", () => ({
  StateManager: class {
    stateExists(): boolean {
      return true;
    }
    clearCache(): void {}
  },
}));

import {
  rebuildStateFromLogs,
  cleanupStaleEntries,
} from "../lib/workflow/state-utils.js";
import { reconcileState } from "../lib/workflow/reconcile.js";
import { statusCommand } from "./status.js";

const mockRebuild = vi.mocked(rebuildStateFromLogs);
const mockCleanup = vi.mocked(cleanupStaleEntries);
const mockReconcile = vi.mocked(reconcileState);

describe("status failure-path exit codes (#848)", () => {
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  describe("--rebuild", () => {
    it("sets exit 1 when the rebuild fails", async () => {
      mockRebuild.mockResolvedValue({ success: false, error: "boom" } as never);

      await statusCommand({ rebuild: true });

      expect(process.exitCode).toBe(1);
    });

    it("sets exit 1 when the rebuild fails in --json mode", async () => {
      mockRebuild.mockResolvedValue({ success: false, error: "boom" } as never);

      await statusCommand({ rebuild: true, json: true });

      expect(process.exitCode).toBe(1);
    });
  });

  describe("--cleanup", () => {
    it("sets exit 1 when cleanup fails", async () => {
      mockCleanup.mockResolvedValue({ success: false, error: "boom" } as never);

      await statusCommand({ cleanup: true });

      expect(process.exitCode).toBe(1);
    });

    it("sets exit 1 when cleanup fails in --json mode", async () => {
      mockCleanup.mockResolvedValue({ success: false, error: "boom" } as never);

      await statusCommand({ cleanup: true, json: true });

      expect(process.exitCode).toBe(1);
    });
  });

  describe("state read failure", () => {
    it("sets exit 1 when reconciliation throws", async () => {
      mockReconcile.mockRejectedValue(new Error("state file corrupt"));

      // --issues routes to displayIssueState, whose reconcile call is wrapped
      // in the try/catch that prints "Error reading state".
      await statusCommand({ issues: true });

      expect(process.exitCode).toBe(1);
    });
  });
});
