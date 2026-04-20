import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { IssueBox } from "./IssueBox.js";
import type { IssueRuntimeState } from "../../lib/workflow/run-state.js";
import { PHASE_GLYPHS } from "./theme.js";

function baseState(overrides?: Partial<IssueRuntimeState>): IssueRuntimeState {
  return {
    number: 47,
    title: "Add pagination to blog index",
    branch: "feature/47-blog-pagination",
    status: "running",
    startedAt: new Date(Date.now() - 1000),
    phases: [
      { name: "spec", status: "done", elapsedMs: 38_000 },
      {
        name: "exec",
        status: "running",
        startedAt: new Date(Date.now() - 500),
      },
      { name: "qa", status: "pending" },
    ],
    currentPhase: {
      name: "exec",
      startedAt: new Date(Date.now() - 500),
      lastActivityAt: new Date(Date.now() - 2000),
      nowLine: "running exec",
    },
    ...overrides,
  };
}

describe("IssueBox", () => {
  it("renders header with issue number and title", () => {
    const { lastFrame } = render(
      <IssueBox state={baseState()} slot={0} width={80} now={Date.now()} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("#47");
    expect(frame).toContain("Add pagination to blog index");
  });

  it("renders the phase progression with done glyph and active spinner", () => {
    const { lastFrame } = render(
      <IssueBox state={baseState()} slot={0} width={80} now={Date.now()} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(PHASE_GLYPHS.done); // spec done
    expect(frame).toContain(PHASE_GLYPHS.pending); // qa pending
    expect(frame).toContain(PHASE_GLYPHS.separator); // tees between phases
    expect(frame).toContain("spec");
    expect(frame).toContain("exec");
    expect(frame).toContain("qa");
  });

  it("renders the now line + last-activity stamp when a phase is active", () => {
    const { lastFrame } = render(
      <IssueBox state={baseState()} slot={0} width={80} now={Date.now()} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("running exec");
    expect(frame).toMatch(/last activity \d+s ago/);
  });

  it("shows passed status line when phases are all done", () => {
    const state = baseState({
      status: "passed",
      phases: [
        { name: "spec", status: "done", elapsedMs: 1000 },
        { name: "exec", status: "done", elapsedMs: 1000 },
        { name: "qa", status: "done", elapsedMs: 1000 },
      ],
      currentPhase: undefined,
    });
    const { lastFrame } = render(
      <IssueBox state={state} slot={0} width={80} now={Date.now()} />,
    );
    expect(lastFrame() ?? "").toContain("completed");
  });

  it("renders branch name", () => {
    const { lastFrame } = render(
      <IssueBox state={baseState()} slot={0} width={80} now={Date.now()} />,
    );
    expect(lastFrame() ?? "").toContain("feature/47-blog-pagination");
  });

  it("renders border-colored tee glyphs around gray horizontal dividers", () => {
    const { lastFrame } = render(
      <IssueBox state={baseState()} slot={0} width={80} now={Date.now()} />,
    );
    const frame = lastFrame() ?? "";
    // Two dividers (between header/context and context/activity), each with
    // border-colored tees at start/end and gray fill between.
    expect(frame).toContain("├");
    expect(frame).toContain("┤");
  });
});
