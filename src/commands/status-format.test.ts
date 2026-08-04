/**
 * #892 QA follow-up: the `sequant status` pause lines are display contract —
 * a window-halted issue must read as "resumable at <time>", not as a bare
 * failure, and an auto-waiting issue as a deliberate pause. These pin the
 * `formatIssueState` rendering for both records (and their absence).
 */

import { describe, it, expect } from "vitest";
import type { IssueState } from "../lib/workflow/state-schema.js";
import { MAX_RESUME_REENTRIES } from "../lib/workflow/state-schema.js";
import { formatIssueState } from "./status.js";

const NOW = new Date().toISOString();

function makeIssueState(overrides: Partial<IssueState> = {}): IssueState {
  return {
    number: 892,
    title: "Durable halt-and-resume",
    status: "in_progress",
    phases: {},
    lastActivity: NOW,
    createdAt: NOW,
    ...overrides,
  } as IssueState;
}

describe("formatIssueState — windowHalt display (#892)", () => {
  it("renders a halted issue as resumable, naming phase, time, command, and bound", () => {
    const output = formatIssueState(
      makeIssueState({
        windowHalt: { resumeAt: NOW, phase: "qa", reentries: 1 },
      }),
    );
    expect(output).toContain("Halted: qa hit a rate-limit window");
    expect(output).toContain("resumable at");
    expect(output).toContain("`sequant resume`");
    expect(output).toContain(`re-entries 1/${MAX_RESUME_REENTRIES}`);
  });

  it("renders an auto-waiting issue as a deliberate pause (#860 sibling line)", () => {
    const output = formatIssueState(
      makeIssueState({
        autoWait: { wakeAt: NOW, phase: "exec" },
      }),
    );
    expect(output).toContain("Auto-wait: exec paused");
    expect(output).toContain("resuming at");
  });

  it("emits neither pause line when no wait/halt is recorded", () => {
    const output = formatIssueState(makeIssueState());
    expect(output).not.toContain("Halted:");
    expect(output).not.toContain("Auto-wait:");
  });
});
