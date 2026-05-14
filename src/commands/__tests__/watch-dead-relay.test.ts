/**
 * Verifies that `sequant watch` detects relay deactivation (#645, Gap 3) and
 * exits cleanly instead of tailing a dead relay forever.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCommand } from "../watch.ts";
import { writePidFile } from "../../lib/relay/pid.ts";

describe("sequant watch dead-relay detection (#645)", () => {
  let tmp: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sequant-watch-test-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits immediately with no-active-relay when pidfile and outbox are both missing", async () => {
    await watchCommand({
      args: ["12345"],
      options: { cwd: tmp, json: true },
    });

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.length).toBe(1);
    const parsed = JSON.parse(calls[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("no-active-relay");
    expect(parsed.issue).toBe(12345);
  });

  it("exits with relay-ended when the pidfile is removed mid-watch", async () => {
    const issue = 67890;
    // Seed an active relay: pidfile + empty outbox.
    writePidFile(issue, process.pid, tmp);
    const relayDir = join(tmp, ".sequant", "relay", String(issue));
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, "outbox.jsonl"), "");

    // Remove the pidfile after a short delay to simulate deactivation.
    const timer = setTimeout(() => {
      try {
        unlinkSync(join(tmp, ".sequant", "pids", `${issue}.pid`));
      } catch {
        /* swallow */
      }
    }, 60);

    await watchCommand({
      args: [String(issue)],
      options: { cwd: tmp, pollIntervalMs: 30, json: true },
    });
    clearTimeout(timer);

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const ended = lines.find(
      (l) =>
        l.includes('"reason":"relay-ended"') && l.includes(`"issue":${issue}`),
    );
    expect(ended).toBeTruthy();
  });
});
