/**
 * #1387 AC-3: doctor's `Warnings:` count equals the `!` lines it printed,
 * the upstream subagent-routing notice included.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDoctorSummary, emitUpstreamWarning } from "./doctor.js";

function captureLogs(fn: () => void): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

afterEach(() => vi.restoreAllMocks());

describe("doctor summary (#1387)", () => {
  describe("AC-3: Warnings count includes the upstream notice", () => {
    it("reports Warnings: 2 for one check warning plus the #43869 notice", () => {
      let printed = false;
      const logs = captureLogs(() => {
        printed = emitUpstreamWarning({
          agentsModel: "haiku",
          defaultAgentsModel: "haiku",
        });
      });
      const noticeLines = logs
        .map(stripAnsi)
        .filter((l) => l.trimStart().startsWith("!"));
      expect(noticeLines).toHaveLength(1);

      // One check warning (Skills Committed) + the notice, as the caller counts.
      const warn = 1 + (printed ? 1 : 0);
      const summary = buildDoctorSummary({ pass: 19, warn, fail: 0 });
      expect(summary.message).toContain("Warnings: 2");
      expect(summary.message).toContain("Passed: 19/21");
      expect(summary.level).toBe("warning");
    });

    describe("error handling", () => {
      it("does not print or count the notice under --quiet", () => {
        let printed = true;
        const logs = captureLogs(() => {
          printed = emitUpstreamWarning({
            quiet: true,
            agentsModel: "haiku",
            defaultAgentsModel: "haiku",
          });
        });
        expect(printed).toBe(false);
        expect(logs).toHaveLength(0);
      });

      it("counts the inert-field second line as part of the same single warning", () => {
        const logs = captureLogs(() => {
          expect(
            emitUpstreamWarning({
              agentsModel: "opus",
              defaultAgentsModel: "haiku",
            }),
          ).toBe(true);
        });
        const bang = logs
          .map(stripAnsi)
          .filter((l) => l.trimStart().startsWith("!"));
        expect(bang).toHaveLength(1);
      });

      it("keeps the fail and healthy summaries unchanged", () => {
        expect(buildDoctorSummary({ pass: 3, warn: 0, fail: 0 })).toMatchObject(
          {
            level: "success",
            title: "All 3 checks passed!",
          },
        );
        const failed = buildDoctorSummary({ pass: 2, warn: 1, fail: 1 });
        expect(failed.level).toBe("error");
        expect(failed.message).toContain("Passed: 2/4");
        expect(failed.message).toContain("Warnings: 1");
        expect(failed.message).toContain("Failed: 1");
      });
    });
  });
});
