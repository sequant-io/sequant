/**
 * Unit tests for the shared completed-status predicate (#837).
 *
 * This is the single source of truth both the chain resume planner and the
 * non-chain pre-flight guard consult. The bug it exists to prevent is a status
 * being added to `IssueStatusSchema` without every guard following — which is
 * exactly what #817's `--ready-gate` did with `waiting_for_human_merge`.
 *
 * These are the mutation-sensitive gates: adding or removing an entry in
 * COMPLETED_ISSUE_STATUSES must fail here.
 */

import { describe, it, expect } from "vitest";
import {
  isCompletedIssueStatus,
  COMPLETED_ISSUE_STATUSES,
} from "./completed-status.js";
import { IssueStatusSchema } from "./state-schema.js";

describe("isCompletedIssueStatus (#837)", () => {
  it("treats ready_for_merge and merged as completed (pre-#837 behavior preserved)", () => {
    expect(isCompletedIssueStatus("ready_for_merge")).toBe(true);
    expect(isCompletedIssueStatus("merged")).toBe(true);
  });

  it("treats waiting_for_human_merge as completed — the #817 ready-gate terminal", () => {
    // A gated issue never reaches `ready_for_merge` by design. Before #837 no
    // guard recognised it, so every re-run redid the full pipeline plus gate.
    expect(isCompletedIssueStatus("waiting_for_human_merge")).toBe(true);
  });

  it("does NOT treat blocked as completed — a guard halt needs human attention", () => {
    // `blocked` is generic ("waiting on external input or dependency"), not a
    // ready-gate-exclusive terminal, and skipping it would report an issue as
    // passed when it demonstrably did not.
    expect(isCompletedIssueStatus("blocked")).toBe(false);
  });

  it("does not treat any other schema status as completed", () => {
    for (const status of [
      "not_started",
      "in_progress",
      "waiting_for_qa_gate",
      "abandoned",
    ]) {
      expect(isCompletedIssueStatus(status)).toBe(false);
    }
  });

  it("treats undefined and unknown statuses as incomplete (conservative: re-execute)", () => {
    // Persisted state may predate the schema or be absent. Never skip on
    // unknown data — that would silently drop an issue the user asked to run.
    expect(isCompletedIssueStatus(undefined)).toBe(false);
    expect(isCompletedIssueStatus("")).toBe(false);
    expect(isCompletedIssueStatus("ready")).toBe(false);
    expect(isCompletedIssueStatus("READY_FOR_MERGE")).toBe(false);
  });

  it("every completed status is a real member of IssueStatusSchema", () => {
    // Guards against a typo'd entry silently never matching persisted state.
    for (const status of COMPLETED_ISSUE_STATUSES) {
      expect(IssueStatusSchema.safeParse(status).success).toBe(true);
    }
  });
});
