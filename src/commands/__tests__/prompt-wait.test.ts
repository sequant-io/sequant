/**
 * Tests for `sequant prompt --wait` reply-tailing (#645, Gap 4).
 */

import {
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptCommand } from "../prompt.ts";
import { writePidFile } from "../../lib/relay/pid.ts";
import { StateManager } from "../../lib/workflow/state-manager.ts";

describe("sequant prompt --wait (#645, Gap 4)", () => {
  let tmp: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "sequant-prompt-wait-test-"));
    process.chdir(tmp);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
    process.exitCode = 0;
  });

  async function seedActiveRun(issue: number): Promise<void> {
    writePidFile(issue, process.pid, tmp);
    const relayDir = join(tmp, ".sequant", "relay", String(issue));
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, "outbox.jsonl"), "");
    // Seed state.json so prompt's state-manager finds the issue.
    const sm = new StateManager({
      statePath: join(tmp, ".sequant", "state.json"),
    });
    const now = new Date().toISOString();
    await sm.saveState({
      version: 1,
      lastUpdated: now,
      issues: {
        [String(issue)]: {
          number: issue,
          title: "test",
          status: "in_progress",
          phases: {},
          relay: {
            enabled: true,
            pid: process.pid,
            startedAt: now,
            messageCount: 0,
          },
          lastActivity: now,
          createdAt: now,
        },
      },
    });
  }

  it("returns 0 and prints the reply when one arrives within the window", async () => {
    const issue = 70001;
    await seedActiveRun(issue);

    // Write a matching reply after a short delay.
    setTimeout(() => {
      const outboxPath = join(
        tmp,
        ".sequant",
        "relay",
        String(issue),
        "outbox.jsonl",
      );
      // We can't know the message id ahead of time, so write a reply for the
      // most-recently-appended inbox line. The test below uses a fixed expected
      // id pattern by inspecting the JSON output.
      const inboxLine = require("fs")
        .readFileSync(
          join(tmp, ".sequant", "relay", String(issue), "inbox.jsonl"),
          "utf-8",
        )
        .trim()
        .split("\n")
        .filter(Boolean)
        .pop();
      const msgId = JSON.parse(inboxLine).id;
      appendFileSync(
        outboxPath,
        JSON.stringify({
          id: "reply_aaaa",
          inReplyTo: msgId,
          timestamp: new Date().toISOString(),
          message: "ok",
        }) + "\n",
      );
    }, 80);

    await promptCommand({
      args: [String(issue), "status?"],
      options: { waitSeconds: 3, waitPollIntervalMs: 30, json: true },
    });

    expect(process.exitCode).toBe(0);
    const replyLine = logSpy.mock.calls.find((c) =>
      String(c[0]).includes('"reply"'),
    );
    expect(replyLine).toBeTruthy();
    const parsed = JSON.parse(String(replyLine![0]));
    expect(parsed.reply.message).toBe("ok");
  });

  it("returns 1 with timeout message when no reply arrives", async () => {
    const issue = 70002;
    await seedActiveRun(issue);

    await promptCommand({
      args: [String(issue), "status?"],
      options: { waitSeconds: 0.2, waitPollIntervalMs: 30, json: true },
    });

    expect(process.exitCode).toBe(1);
    const timeoutLine = logSpy.mock.calls.find((c) =>
      String(c[0]).includes('"timeout":true'),
    );
    expect(timeoutLine).toBeTruthy();
  });

  it("skips --wait when type is abort (no reply expected)", async () => {
    const issue = 70003;
    await seedActiveRun(issue);

    await promptCommand({
      args: [String(issue), "stop"],
      options: {
        type: "abort",
        waitSeconds: 0.2,
        waitPollIntervalMs: 30,
        json: true,
      },
    });

    expect(process.exitCode).toBe(0);
    const timeoutLine = logSpy.mock.calls.find((c) =>
      String(c[0]).includes('"timeout":true'),
    );
    expect(timeoutLine).toBeUndefined();
  });
});
