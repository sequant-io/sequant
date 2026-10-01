import { describe, it, expect } from "vitest";
import {
  NonTTYRenderer,
  TTYRenderer,
  renderRunSummary,
} from "./run-renderer.js";
import type { IssueSummary } from "./run-renderer-types.js";

// #1257: a dry run executes nothing. Its summary used to read
// `#1 ✔ passed` and `1 passed · 0 failed`, even for an issue that does not
// exist, which told a new user their setup worked when nothing had run.
// The per-phase progress lines printed a green check for each planned phase.

const planned: IssueSummary = {
  issueNumber: 1,
  success: true,
  durationSeconds: 0,
  phases: [
    { name: "spec", success: true },
    { name: "exec", success: true },
    { name: "qa", success: true },
  ],
};

function render(columns: number, dryRun: boolean): string {
  let out = "";
  renderRunSummary(
    { issues: [planned], totalDurationSeconds: 0, dryRun },
    { stdoutWrite: (s) => (out += s), noColor: true, columns },
  );
  return out;
}

describe("dry-run summary never reports an issue as passed (#1257)", () => {
  it("grid layout labels the row planned and counts nothing as passed", () => {
    const out = render(120, true);
    expect(out).toContain("○ planned");
    expect(out).toContain("1 planned · nothing executed");
    expect(out).not.toContain("passed");
  });

  it("narrow layout labels the row planned and counts nothing as passed", () => {
    const out = render(50, true);
    expect(out).toContain("○ planned");
    expect(out).toContain("1 planned · nothing executed");
    expect(out).not.toContain("passed");
  });

  it("a real run still reports passed", () => {
    const out = render(120, false);
    expect(out).toContain("✔ passed");
    expect(out).toContain("1 passed · 0 failed");
    expect(out).not.toContain("planned");
  });
});

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function phaseLines(
  make: (write: (s: string) => void) => {
    registerIssue: (r: { issueNumber: number }) => void;
    onEvent: NonTTYRenderer["onEvent"];
    dispose: () => void;
  },
): string {
  let out = "";
  const r = make((s) => (out += s));
  r.registerIssue({ issueNumber: 1 });
  r.onEvent({ issue: 1, phase: "spec", event: "start" });
  r.onEvent({ issue: 1, phase: "spec", event: "complete", durationSeconds: 0 });
  r.dispose();
  return out.replace(ANSI, "");
}

const common = {
  noColor: true,
  now: () => 0,
  wallClock: () => new Date(0),
};

describe("dry-run progress lines never show a completed phase (#1257)", () => {
  it("non-TTY renderer prints the phase as planned, with no check mark", () => {
    const out = phaseLines(
      (stdoutWrite) =>
        new NonTTYRenderer({
          ...common,
          stdoutWrite,
          nonTtyHeartbeatMs: 0,
          dryRun: true,
        }),
    );
    expect(out).toContain("○ #1 spec planned");
    expect(out).not.toContain("✔");
  });

  it("TTY renderer prints the phase as planned, with no check mark", () => {
    const out = phaseLines(
      (stdoutWrite) =>
        new TTYRenderer({
          ...common,
          stdoutWrite,
          isTTY: true,
          columns: 100,
          liveTickMs: 0,
          noSignalListeners: true,
          dryRun: true,
        }),
    );
    expect(out).toContain("○ #1 spec planned");
    expect(out).not.toContain("✔ #1 spec");
  });

  it("a real run still prints the green check", () => {
    const out = phaseLines(
      (stdoutWrite) =>
        new NonTTYRenderer({ ...common, stdoutWrite, nonTtyHeartbeatMs: 0 }),
    );
    expect(out).toContain("✔ #1 spec");
    expect(out).not.toContain("planned");
  });
});
