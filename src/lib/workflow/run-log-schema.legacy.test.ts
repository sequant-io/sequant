/**
 * #1647 AC-4: a pre-3.0 run log still loads after the model ladder's removal.
 *
 * The fixture is the shape a ladder run wrote before 3.0: a `TOP_OF_LADDER`
 * evidence bundle with a non-empty `escalationHistory`, a `ladder_halt`
 * error category, and the ladder fields on a phase entry. Nothing writes any
 * of that since #1647, but `.sequant/logs/` keeps old files, and both
 * `RunLogSchema` and `sequant logs` must keep reading them (I-2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RunLogSchema } from "./run-log-schema.js";
import { logsCommand } from "../../commands/logs.js";

const FIXTURE = path.join(
  __dirname,
  "__fixtures__",
  "legacy-run-log",
  "pre-3.0-ladder-halt.json",
);

function readFixture(): unknown {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
}

describe("#1647 AC-4: a pre-3.0 run log with ladder data", () => {
  it("validates against RunLogSchema and keeps the halt bundle", () => {
    const log = RunLogSchema.parse(readFixture());
    const issue = log.issues[0];

    expect(issue.evidenceBundle?.reason).toBe("TOP_OF_LADDER");
    expect(issue.evidenceBundle?.escalationHistory).toEqual([
      expect.objectContaining({ rung: 1, base: "sonnet", escalated: "opus" }),
    ]);
    expect(issue.phases[1].errorContext?.category).toBe("ladder_halt");
  });

  describe("sequant logs", () => {
    let dir: string;
    let out: string[];

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-legacy-1647-"));
      fs.copyFileSync(FIXTURE, path.join(dir, "run-legacy.json"));
      out = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        out.push(args.join(" "));
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("renders the log instead of skipping it as unparseable", async () => {
      await logsCommand({ path: dir });
      const printed = out.join("\n");

      expect(printed).not.toMatch(/No logs found|No logs match/);
      expect(printed).toContain("#971");
      expect(printed).toMatch(/0 passed, 1 failed/);
    });
  });
});
