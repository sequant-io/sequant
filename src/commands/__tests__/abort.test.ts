/**
 * Tests for `sequant abort` — out-of-band escape hatch (#645, Gap 7).
 *
 * Uses fake `killFn` + `isAlive` so we don't actually signal real processes.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortCommand } from "../abort.ts";
import { writePidFile } from "../../lib/relay/pid.ts";

describe("sequant abort (#645)", () => {
  let tmp: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sequant-abort-test-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("errors with exit code 1 when no PID is found", async () => {
    await abortCommand({
      args: ["12345"],
      options: { cwd: tmp, json: true, killFn: () => {}, isAlive: () => false },
    });

    expect(process.exitCode).toBe(1);
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.ok).toBe(false);
    expect(out.issue).toBe(12345);
  });

  it("reports already-dead when PID exists but process is gone", async () => {
    const issue = 22222;
    writePidFile(issue, 99999, tmp);

    await abortCommand({
      args: [String(issue)],
      options: { cwd: tmp, json: true, killFn: () => {}, isAlive: () => false },
    });

    expect(process.exitCode).toBe(0);
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.ok).toBe(true);
    expect(out.signal).toBeNull();
  });

  it("sends SIGINT first and reports success when the process exits gracefully", async () => {
    const issue = 33333;
    const targetPid = 42424;
    writePidFile(issue, targetPid, tmp);

    const sentSignals: NodeJS.Signals[] = [];
    let aliveFlag = true;

    await abortCommand({
      args: [String(issue)],
      options: {
        cwd: tmp,
        json: true,
        graceSeconds: 1,
        pollIntervalMs: 10,
        killFn: (pid, sig) => {
          expect(pid).toBe(targetPid);
          sentSignals.push(sig);
          if (sig === "SIGINT") {
            // Simulate clean exit after SIGINT.
            setTimeout(() => {
              aliveFlag = false;
            }, 20);
          }
        },
        isAlive: () => aliveFlag,
      },
    });

    expect(sentSignals).toEqual(["SIGINT"]);
    const out = JSON.parse(String(logSpy.mock.calls.at(-1)![0]));
    expect(out.ok).toBe(true);
    expect(out.signal).toBe("SIGINT");
    expect(out.pid).toBe(targetPid);
  });

  it("escalates SIGINT -> SIGTERM -> SIGKILL when the process refuses to die", async () => {
    const issue = 44444;
    const targetPid = 55555;
    writePidFile(issue, targetPid, tmp);

    const sentSignals: NodeJS.Signals[] = [];

    await abortCommand({
      args: [String(issue)],
      options: {
        cwd: tmp,
        json: true,
        graceSeconds: 0.05,
        pollIntervalMs: 10,
        sigtermTimeoutMs: 50,
        sigkillTimeoutMs: 50,
        killFn: (_pid, sig) => {
          sentSignals.push(sig);
          // Never let the process die in this test.
        },
        isAlive: () => true,
      },
    });

    expect(sentSignals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(process.exitCode).toBe(1);
    const out = JSON.parse(String(logSpy.mock.calls.at(-1)![0]));
    expect(out.ok).toBe(false);
    expect(out.signal).toBe("SIGKILL");
  });

  it("with --force, skips SIGINT and starts at SIGTERM", async () => {
    const issue = 55555;
    const targetPid = 66666;
    writePidFile(issue, targetPid, tmp);

    const sentSignals: NodeJS.Signals[] = [];
    let aliveFlag = true;

    await abortCommand({
      args: [String(issue)],
      options: {
        cwd: tmp,
        json: true,
        force: true,
        pollIntervalMs: 10,
        killFn: (_pid, sig) => {
          sentSignals.push(sig);
          if (sig === "SIGTERM") {
            setTimeout(() => {
              aliveFlag = false;
            }, 20);
          }
        },
        isAlive: () => aliveFlag,
      },
    });

    expect(sentSignals).toEqual(["SIGTERM"]);
    expect(process.exitCode).toBe(0);
  });
});
