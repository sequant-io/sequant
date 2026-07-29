/**
 * Exit-code coverage for the `sequant state` subcommands (#848, AC-3 audit).
 *
 * `state init` / `state rebuild` / `state clean` each printed a red failure and
 * bare-returned at exit 0. Both the human (`chalk.red`) and the `--json` failure
 * branches must now set a non-zero exit code so scripted consumers can gate on
 * `$?`. The underlying utilities are mocked to force the failure branches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/workflow/state-utils.js", () => ({
  discoverUntrackedWorktrees: vi.fn(),
  rebuildStateFromLogs: vi.fn(),
  cleanupStaleEntries: vi.fn(),
}));

import {
  discoverUntrackedWorktrees,
  rebuildStateFromLogs,
  cleanupStaleEntries,
} from "../lib/workflow/state-utils.js";
import {
  stateInitCommand,
  stateRebuildCommand,
  stateCleanCommand,
} from "./state.js";

const mockDiscover = vi.mocked(discoverUntrackedWorktrees);
const mockRebuild = vi.mocked(rebuildStateFromLogs);
const mockCleanup = vi.mocked(cleanupStaleEntries);

describe("state subcommand exit codes (#848)", () => {
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

  describe("state init", () => {
    it("sets exit 1 when discovery fails", async () => {
      mockDiscover.mockResolvedValue({
        success: false,
        error: "boom",
      } as never);

      await stateInitCommand();

      expect(process.exitCode).toBe(1);
    });

    it("sets exit 1 when discovery fails in --json mode", async () => {
      mockDiscover.mockResolvedValue({
        success: false,
        error: "boom",
      } as never);

      await stateInitCommand({ json: true });

      expect(process.exitCode).toBe(1);
    });

    it("negative: leaves the exit code unset when discovery succeeds", async () => {
      mockDiscover.mockResolvedValue({
        success: true,
        discovered: [],
        worktreesScanned: 0,
        alreadyTracked: 0,
        skipped: [],
      } as never);

      await stateInitCommand();

      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("state rebuild", () => {
    it("sets exit 1 when the log rebuild fails", async () => {
      mockRebuild.mockResolvedValue({ success: false, error: "boom" } as never);

      // --force skips the confirmation gate so we reach the rebuild call.
      await stateRebuildCommand({ force: true });

      expect(process.exitCode).toBe(1);
    });

    it("sets exit 1 when the log rebuild fails in --json mode", async () => {
      mockRebuild.mockResolvedValue({ success: false, error: "boom" } as never);

      await stateRebuildCommand({ json: true });

      expect(process.exitCode).toBe(1);
    });
  });

  describe("state clean", () => {
    it("sets exit 1 when cleanup fails", async () => {
      mockCleanup.mockResolvedValue({ success: false, error: "boom" } as never);

      await stateCleanCommand();

      expect(process.exitCode).toBe(1);
    });

    it("sets exit 1 when cleanup fails in --json mode", async () => {
      mockCleanup.mockResolvedValue({ success: false, error: "boom" } as never);

      await stateCleanCommand({ json: true });

      expect(process.exitCode).toBe(1);
    });
  });
});
