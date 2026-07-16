import { describe, it, expect } from "vitest";
import { pipelineHasFailed } from "./status-derivation.js";
import { deriveIssueLogStatus } from "./run-log-schema.js";
import type { PhaseLog } from "./run-log-schema.js";

/**
 * #766 — the shared derivation that both live state machines (orchestrator card
 * + renderer) and the JSON log now use instead of pinning `failed`/`partial`.
 */

describe("pipelineHasFailed (#766)", () => {
  it("is false when every non-loop phase's latest slot is done", () => {
    expect(
      pipelineHasFailed([
        { name: "spec", status: "done" },
        { name: "exec", status: "done" },
        { name: "qa", status: "done" },
      ]),
    ).toBe(false);
  });

  it("is true when a non-loop phase's latest slot is failed", () => {
    expect(
      pipelineHasFailed([
        { name: "exec", status: "done" },
        { name: "qa", status: "failed" },
      ]),
    ).toBe(true);
  });

  it("ignores a failed loop slot when the pipeline recovered (AC-1/AC-8)", () => {
    // #760's shape: qa recovered on a later iteration (slot overwritten to
    // done), but the loop that failed on the early iteration never re-ran.
    expect(
      pipelineHasFailed([
        { name: "spec", status: "done" },
        { name: "exec", status: "done" },
        { name: "qa", status: "done" },
        { name: "loop", status: "failed" },
      ]),
    ).toBe(false);
  });

  it("still reports failed when a real phase failed alongside a failed loop (#762 guard)", () => {
    expect(
      pipelineHasFailed([
        { name: "exec", status: "done" },
        { name: "qa", status: "failed" },
        { name: "loop", status: "failed" },
      ]),
    ).toBe(true);
  });

  it("is false while phases are still pending/running (no failure yet)", () => {
    expect(
      pipelineHasFailed([
        { name: "spec", status: "done" },
        { name: "exec", status: "running" },
        { name: "qa", status: "pending" },
      ]),
    ).toBe(false);
  });
});

function phaseLog(phase: string, status: PhaseLog["status"]): PhaseLog {
  return {
    phase,
    issueNumber: 1,
    startTime: "2026-07-15T00:00:00.000Z",
    endTime: "2026-07-15T00:01:00.000Z",
    durationSeconds: 60,
    status,
  };
}

describe("deriveIssueLogStatus (#766)", () => {
  it("uses the latest attempt of each phase (qa fails twice then succeeds → success)", () => {
    expect(
      deriveIssueLogStatus([
        phaseLog("spec", "success"),
        phaseLog("exec", "success"),
        phaseLog("qa", "failure"),
        phaseLog("qa", "failure"),
        phaseLog("qa", "success"),
      ]),
    ).toBe("success");
  });

  it("de-escalates a timeout-pinned partial when a later attempt succeeds (AC-5)", () => {
    expect(
      deriveIssueLogStatus([
        phaseLog("qa", "timeout"),
        phaseLog("qa", "success"),
      ]),
    ).toBe("success");
  });

  it("a lone timeout with no recovery is partial (AC-4)", () => {
    expect(
      deriveIssueLogStatus([
        phaseLog("exec", "success"),
        phaseLog("qa", "timeout"),
      ]),
    ).toBe("partial");
  });

  it("excludes a failed loop from the verdict when the pipeline recovered", () => {
    expect(
      deriveIssueLogStatus([
        phaseLog("exec", "success"),
        phaseLog("qa", "failure"),
        phaseLog("loop", "failure"),
        phaseLog("qa", "success"),
      ]),
    ).toBe("success");
  });

  it("keeps failure when the last qa attempt fails and never recovers (#762 guard)", () => {
    expect(
      deriveIssueLogStatus([
        phaseLog("qa", "timeout"),
        phaseLog("qa", "timeout"),
        phaseLog("qa", "failure"),
      ]),
    ).toBe("failure");
  });

  it("prioritises a failure in one phase over a timeout in another", () => {
    expect(
      deriveIssueLogStatus([
        phaseLog("exec", "failure"),
        phaseLog("qa", "timeout"),
      ]),
    ).toBe("failure");
  });
});
