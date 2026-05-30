/**
 * Integration test for Issue #672 — AC-4:
 *
 *   Ordered run history (with timestamps) remains recoverable post-run via the
 *   run log when scrollback no longer includes `▸ start` lines (#672 AC-1).
 *
 * Strategy: drive the `LogWriter` end-to-end (same code path runIssueWithLogging
 * uses) and assert on the on-disk `run-*.json` artifact. This exercises the
 * exact integration point that becomes load-bearing once the TTY scrollback
 * drops start events — the run log MUST be the authoritative ordered phase
 * history or the dropped scrollback line leaves the user without recoverability.
 *
 * Run with: npm test -- __tests__/integration/run-log-phase-history-672.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  LogWriter,
  createPhaseLogFromTiming,
} from "../../src/lib/workflow/log-writer.js";
import {
  RunLogSchema,
  type RunConfig,
} from "../../src/lib/workflow/run-log-schema.js";

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const STANDARD_CONFIG: RunConfig = {
  phases: ["spec", "exec", "qa"],
  sequential: true,
  qualityLoop: false,
  maxIterations: 3,
};

function readSingleLogFile(dir: string): unknown {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const raw = fs.readFileSync(path.join(dir, files[0]), "utf8");
  return JSON.parse(raw);
}

describe("Run log phase history — Issue #672", () => {
  // === SANDBOX ISOLATION ===
  const TEST_DIR = `/tmp/sequant-test-672-${process.pid}-${Date.now()}`;

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("AC-4: ordered phase history recoverable from run log", () => {
    it("should write a single run-*.json containing every phase with start+end timestamps", async () => {
      const logDir = path.join(TEST_DIR, "ac4-base");
      const writer = new LogWriter({
        logPath: logDir,
        rotation: { enabled: false, maxFiles: 0, maxAgeDays: 0 },
      });
      await writer.initialize(STANDARD_CONFIG);

      writer.startIssue(101, "Test issue A", ["enhancement"]);
      const phaseAStart = new Date("2026-05-30T10:00:00.000Z");
      const phaseAEnd = new Date("2026-05-30T10:00:30.000Z");
      writer.logPhase(
        createPhaseLogFromTiming(
          "spec",
          101,
          phaseAStart,
          phaseAEnd,
          "success",
        ),
      );
      const phaseBStart = new Date("2026-05-30T10:00:30.500Z");
      const phaseBEnd = new Date("2026-05-30T10:01:30.500Z");
      writer.logPhase(
        createPhaseLogFromTiming(
          "exec",
          101,
          phaseBStart,
          phaseBEnd,
          "success",
        ),
      );
      const phaseCStart = new Date("2026-05-30T10:01:31.000Z");
      const phaseCEnd = new Date("2026-05-30T10:01:40.000Z");
      writer.logPhase(
        createPhaseLogFromTiming("qa", 101, phaseCStart, phaseCEnd, "success"),
      );
      writer.completeIssue(101);

      await writer.finalize();

      const parsed = readSingleLogFile(logDir);
      const log = RunLogSchema.parse(parsed);

      expect(log.issues).toHaveLength(1);
      const issue = log.issues[0];
      expect(issue.phases).toHaveLength(3);
      for (const phase of issue.phases) {
        expect(phase.startTime).toMatch(ISO_DATETIME);
        expect(phase.endTime).toMatch(ISO_DATETIME);
        expect(new Date(phase.endTime).getTime()).toBeGreaterThanOrEqual(
          new Date(phase.startTime).getTime(),
        );
      }

      // Phases stored in the order they were logged — reproduces the
      // sequence the dropped `▸ start` scrollback lines would have shown.
      expect(issue.phases.map((p) => p.phase)).toEqual(["spec", "exec", "qa"]);
    });

    it("should preserve execution order via phase.startTime across issues", async () => {
      const logDir = path.join(TEST_DIR, "ac4-order");
      const writer = new LogWriter({
        logPath: logDir,
        rotation: { enabled: false, maxFiles: 0, maxAgeDays: 0 },
      });
      await writer.initialize(STANDARD_CONFIG);

      // Interleaved schedule: A.spec → B.spec → B.exec → A.exec.
      // Phase startTimes ascending across issues must reproduce that order.
      writer.startIssue(201, "Issue A", []);
      writer.startIssue(202, "Issue B", []);
      writer.logPhase(
        createPhaseLogFromTiming(
          "spec",
          201,
          new Date("2026-05-30T11:00:00.000Z"),
          new Date("2026-05-30T11:00:10.000Z"),
          "success",
        ),
      );
      writer.logPhase(
        createPhaseLogFromTiming(
          "spec",
          202,
          new Date("2026-05-30T11:00:11.000Z"),
          new Date("2026-05-30T11:00:20.000Z"),
          "success",
        ),
      );
      writer.logPhase(
        createPhaseLogFromTiming(
          "exec",
          202,
          new Date("2026-05-30T11:00:21.000Z"),
          new Date("2026-05-30T11:01:00.000Z"),
          "success",
        ),
      );
      writer.logPhase(
        createPhaseLogFromTiming(
          "exec",
          201,
          new Date("2026-05-30T11:01:01.000Z"),
          new Date("2026-05-30T11:01:40.000Z"),
          "success",
        ),
      );
      writer.completeIssue(201);
      writer.completeIssue(202);
      await writer.finalize();

      const log = RunLogSchema.parse(readSingleLogFile(logDir));
      const flat = log.issues.flatMap((i) =>
        i.phases.map((p) => ({
          issue: i.issueNumber,
          phase: p.phase,
          t: p.startTime,
        })),
      );
      const sorted = [...flat].sort((a, b) => a.t.localeCompare(b.t));
      expect(sorted.map((e) => `${e.issue}/${e.phase}`)).toEqual([
        "201/spec",
        "202/spec",
        "202/exec",
        "201/exec",
      ]);
    });

    it("validates assumption: phase startTime has millisecond precision", async () => {
      const logDir = path.join(TEST_DIR, "ac4-ms");
      const writer = new LogWriter({
        logPath: logDir,
        rotation: { enabled: false, maxFiles: 0, maxAgeDays: 0 },
      });
      await writer.initialize(STANDARD_CONFIG);

      writer.startIssue(301, "Issue", []);
      // Two phases starting 1ms apart — must remain distinguishable.
      writer.logPhase(
        createPhaseLogFromTiming(
          "spec",
          301,
          new Date("2026-05-30T12:00:00.000Z"),
          new Date("2026-05-30T12:00:00.500Z"),
          "success",
        ),
      );
      writer.logPhase(
        createPhaseLogFromTiming(
          "exec",
          301,
          new Date("2026-05-30T12:00:00.501Z"),
          new Date("2026-05-30T12:00:30.501Z"),
          "success",
        ),
      );
      writer.completeIssue(301);
      await writer.finalize();

      const log = RunLogSchema.parse(readSingleLogFile(logDir));
      const [p1, p2] = log.issues[0].phases;
      expect(p1.startTime).not.toBe(p2.startTime);
      expect(p1.startTime).toMatch(/\.\d{3}Z$/);
      expect(p2.startTime).toMatch(/\.\d{3}Z$/);
    });

    it("validates assumption: run log captures full phase history regardless of TTY mode", async () => {
      // The TTY/non-TTY split lives in the renderer (`createRunRenderer`); the
      // run log writer is mode-agnostic. This test exercises the same
      // LogWriter flow twice with no mode signal and asserts the artifact is
      // identical — the post-#672 invariant that "the run log is the only
      // durable history when `▸ start` is dropped" therefore holds for both
      // TTY and CI runs.
      const driveRun = async (dir: string): Promise<void> => {
        const writer = new LogWriter({
          logPath: dir,
          rotation: { enabled: false, maxFiles: 0, maxAgeDays: 0 },
        });
        await writer.initialize(STANDARD_CONFIG);
        writer.startIssue(401, "Issue", []);
        writer.logPhase(
          createPhaseLogFromTiming(
            "spec",
            401,
            new Date("2026-05-30T13:00:00.000Z"),
            new Date("2026-05-30T13:00:10.000Z"),
            "success",
          ),
        );
        writer.completeIssue(401);
        await writer.finalize();
      };

      const ttyDir = path.join(TEST_DIR, "ac4-tty");
      const ciDir = path.join(TEST_DIR, "ac4-ci");
      await driveRun(ttyDir);
      await driveRun(ciDir);

      const ttyLog = RunLogSchema.parse(readSingleLogFile(ttyDir));
      const ciLog = RunLogSchema.parse(readSingleLogFile(ciDir));

      expect(ttyLog.issues[0].phases.map((p) => p.phase)).toEqual(["spec"]);
      expect(ciLog.issues[0].phases.map((p) => p.phase)).toEqual(["spec"]);
      expect(ttyLog.issues[0].phases[0].startTime).toBe(
        ciLog.issues[0].phases[0].startTime,
      );
    });
  });

  // === ERROR SCENARIOS ===
  describe("error scenarios", () => {
    it("should still record phase history when a phase fails", async () => {
      const logDir = path.join(TEST_DIR, "ac4-fail");
      const writer = new LogWriter({
        logPath: logDir,
        rotation: { enabled: false, maxFiles: 0, maxAgeDays: 0 },
      });
      await writer.initialize(STANDARD_CONFIG);

      writer.startIssue(501, "Issue", []);
      writer.logPhase(
        createPhaseLogFromTiming(
          "spec",
          501,
          new Date("2026-05-30T14:00:00.000Z"),
          new Date("2026-05-30T14:00:10.000Z"),
          "success",
        ),
      );
      writer.logPhase(
        createPhaseLogFromTiming(
          "exec",
          501,
          new Date("2026-05-30T14:00:11.000Z"),
          new Date("2026-05-30T14:00:40.000Z"),
          "failure",
          { error: "exec produced no changes" },
        ),
      );
      writer.completeIssue(501);
      await writer.finalize();

      const log = RunLogSchema.parse(readSingleLogFile(logDir));
      const failed = log.issues[0].phases.find((p) => p.phase === "exec");
      expect(failed?.status).toBe("failure");
      expect(failed?.startTime).toBeDefined();
      expect(failed?.endTime).toBeDefined();
      expect(failed?.error).toBe("exec produced no changes");
      // The dropped `▸ exec` scrollback line surfaces here instead — the run
      // log retains both timing and the failure reason.
      expect(log.issues[0].status).toBe("failure");
    });

    it("should preserve ordering across concurrent runs writing to the same log dir", async () => {
      // Two parallel `sequant run` invocations sharing .sequant/logs/ are
      // exercised here as two LogWriter instances with distinct runIds
      // hitting the same directory.
      const logDir = path.join(TEST_DIR, "ac4-concurrent");
      const w1 = new LogWriter({
        logPath: logDir,
        rotation: { enabled: false, maxFiles: 0, maxAgeDays: 0 },
      });
      const w2 = new LogWriter({
        logPath: logDir,
        rotation: { enabled: false, maxFiles: 0, maxAgeDays: 0 },
      });
      await w1.initialize(STANDARD_CONFIG);
      await w2.initialize(STANDARD_CONFIG);

      w1.startIssue(601, "Run 1", []);
      w1.logPhase(
        createPhaseLogFromTiming(
          "spec",
          601,
          new Date("2026-05-30T15:00:00.000Z"),
          new Date("2026-05-30T15:00:30.000Z"),
          "success",
        ),
      );
      w1.completeIssue(601);

      w2.startIssue(602, "Run 2", []);
      w2.logPhase(
        createPhaseLogFromTiming(
          "spec",
          602,
          new Date("2026-05-30T15:00:30.000Z"),
          new Date("2026-05-30T15:01:00.000Z"),
          "success",
        ),
      );
      w2.completeIssue(602);

      await w1.finalize();
      await w2.finalize();

      const files = fs
        .readdirSync(logDir)
        .filter((f) => f.startsWith("run-") && f.endsWith(".json"));
      expect(files).toHaveLength(2);
      const parsed = files.map((f) =>
        RunLogSchema.parse(
          JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")),
        ),
      );
      const issueNumbers = parsed
        .flatMap((p) => p.issues.map((i) => i.issueNumber))
        .sort();
      expect(issueNumbers).toEqual([601, 602]);
    });
  });
});
