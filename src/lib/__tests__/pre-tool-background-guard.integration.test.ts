/**
 * Background-task guard in `pre-tool.sh` (#1032).
 *
 * Drives the REAL `.claude/hooks/pre-tool.sh` as a subprocess (same harness
 * shape as checkout-lock.integration.test.ts). A phase agent that starts the
 * test suite as a `Monitor` or a backgrounded Bash command and then waits for
 * the notification ends its turn — and under `sequant run` that is the end of
 * the phase, with the work stranded uncommitted. The hook refuses both forms
 * whenever SEQUANT_ORCHESTRATOR is set, and stays out of the way otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const HOOK = join(REPO_ROOT, ".claude/hooks/pre-tool.sh");

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pre-tool-bg-guard-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Payload {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

function runHook(
  payload: Payload,
  orchestrator: string,
): { status: number; stderr: string } {
  const result = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ ...payload, cwd: scratch }),
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: scratch,
      CLAUDE_PLUGIN_DATA: join(scratch, ".hooklogs"),
      CLAUDE_HOOKS_DISABLED: "",
      SEQUANT_ISSUE: "",
      SEQUANT_ORCHESTRATOR: orchestrator,
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

const MONITOR: Payload = {
  tool_name: "Monitor",
  tool_input: {
    command: "until [ -s out.log ]; do sleep 5; done; echo done",
    description: "full test suite",
    timeout_ms: 600000,
    persistent: false,
  },
};
const BACKGROUND_BASH: Payload = {
  tool_name: "Bash",
  tool_input: { command: "npm test 2>&1 | tail -150", run_in_background: true },
};
const FOREGROUND_BASH: Payload = {
  tool_name: "Bash",
  tool_input: { command: "npm test 2>&1 | tail -150" },
};

describe("AC-1: under the orchestrator, background work is refused", () => {
  it("blocks a Monitor tool call", () => {
    const { status, stderr } = runHook(MONITOR, "sequant-run");
    expect(status).toBe(2);
    expect(stderr).toContain("HOOK_BLOCKED: Background tasks never notify");
    expect(stderr).toContain("#1032");
  });

  it("blocks a Bash call with run_in_background: true", () => {
    const { status, stderr } = runHook(BACKGROUND_BASH, "mcp-server");
    expect(status).toBe(2);
    expect(stderr).toContain("HOOK_BLOCKED: Background tasks never notify");
    // The message tells the agent what to do instead.
    expect(stderr).toMatch(/timeout \d+ npm test/);
  });

  it("allows the same command in the foreground", () => {
    const { status, stderr } = runHook(FOREGROUND_BASH, "sequant-run");
    expect(status).toBe(0);
    expect(stderr).not.toContain("HOOK_BLOCKED");
  });
});

describe("AC-2: interactive sessions are untouched", () => {
  it("allows a Monitor tool call without SEQUANT_ORCHESTRATOR", () => {
    const { status, stderr } = runHook(MONITOR, "");
    expect(status).toBe(0);
    expect(stderr).not.toContain("HOOK_BLOCKED");
  });

  it("allows a backgrounded Bash call without SEQUANT_ORCHESTRATOR", () => {
    const { status, stderr } = runHook(BACKGROUND_BASH, "");
    expect(status).toBe(0);
    expect(stderr).not.toContain("HOOK_BLOCKED");
  });
});
