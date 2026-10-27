/**
 * sequant_logs MCP tool — the run's cost rides along (#1527).
 *
 * The tool builds its JSON field by field, so a new run-log field is invisible
 * to MCP callers until it is named here. `sequant logs` prints the same
 * figure; this keeps the two surfaces showing one number.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createEmptyRunLog } from "../../lib/workflow/run-log-schema.js";

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../lib/run-logs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/run-logs.js")>();
  return { ...actual, resolveLogDir: () => state.dir };
});

const { registerLogsTool } = await import("./logs.js");

type LogsArgs = { runId?: string; limit?: number };
type LogsResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: LogsArgs) => Promise<LogsResult>;

/** Register the tool on a stub server and return its handler. */
function logsHandler(): Handler {
  const registerTool = vi.fn();
  registerLogsTool({ registerTool } as unknown as Parameters<
    typeof registerLogsTool
  >[0]);
  return registerTool.mock.calls[0][2] as Handler;
}

function writeLog(
  dir: string,
  name: string,
  cost?: { usd?: number; tokens?: number },
): void {
  const log = {
    ...createEmptyRunLog({
      phases: ["spec", "exec"],
      sequential: false,
      qualityLoop: false,
      maxIterations: 3,
    }),
    endTime: new Date().toISOString(),
    ...(cost ? { cost } : {}),
  };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(log));
}

async function firstLog(handler: Handler): Promise<Record<string, unknown>> {
  const result = await handler({ limit: 1 });
  const data = JSON.parse(result.content[0].text) as {
    logs: Array<Record<string, unknown>>;
  };
  expect(data.logs).toHaveLength(1);
  return data.logs[0];
}

describe("sequant_logs cost (#1527)", () => {
  beforeEach(() => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-cost-"));
  });

  afterEach(() => {
    fs.rmSync(state.dir, { recursive: true, force: true });
  });

  it("returns the run's cost when the log carries one", async () => {
    writeLog(state.dir, "run-2026-10-26T00-00-00-a.json", {
      usd: 6.45,
      tokens: 69641,
    });
    const log = await firstLog(logsHandler());
    expect(log.cost).toEqual({ usd: 6.45, tokens: 69641 });
  });

  it("omits cost for a log without the field, never $0", async () => {
    writeLog(state.dir, "run-2026-10-26T00-00-00-b.json");
    const log = await firstLog(logsHandler());
    expect(log).not.toHaveProperty("cost");
  });
});
