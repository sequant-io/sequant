/**
 * #1475 AC-4: one `formatSignalLine` for `sequant locks` and the orchestrator.
 */
import { describe, it, expect } from "vitest";
import { formatSignalLine } from "./signal-line.js";
import type { SignalReason } from "./types.js";

const REASONS: SignalReason[] = [
  "sent",
  "orchestrator",
  "cross-host",
  "self-or-parent",
  "pid-dead",
  "stale-pid-untrusted",
  "kill-failed",
];

describe("formatSignalLine", () => {
  it("names the issue, and the PID when one was targeted, for every reason", () => {
    for (const reason of REASONS) {
      const line = formatSignalLine(1475, 4242, { sent: false, reason });
      expect(line).toContain("#1475");
      if (reason !== "orchestrator") expect(line).toContain("PID 4242");
      expect(line.startsWith(" ")).toBe(false);
    }
  });

  it("gives each reason its own text", () => {
    const lines = REASONS.map((reason) =>
      formatSignalLine(1475, 4242, { sent: false, reason }),
    );
    expect(new Set(lines).size).toBe(REASONS.length);
  });

  it("the indented line is the unindented line with the prefix", () => {
    for (const reason of REASONS) {
      const result = { sent: reason === "sent", reason };
      expect(formatSignalLine(7, 99, result, { indent: "  " })).toBe(
        `  ${formatSignalLine(7, 99, result)}`,
      );
    }
  });

  it("keeps the full stale-pid text for both callers", () => {
    const result = { sent: false, reason: "stale-pid-untrusted" as const };
    expect(formatSignalLine(7, 99, result, { indent: "  " })).toBe(
      "  Refused to signal PID 99 for #7 (lock is past the age ceiling; that PID has likely been recycled onto an unrelated process)",
    );
  });
});
