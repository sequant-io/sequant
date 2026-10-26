import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logsCommand } from "./logs.js";
import {
  createEmptyRunLog,
  RunLogSchema,
} from "../lib/workflow/run-log-schema.js";

function writeLog(dir: string, cost?: { usd?: number; tokens?: number }): void {
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
  fs.writeFileSync(path.join(dir, "run-test.json"), JSON.stringify(log));
}

describe("sequant logs cost line (#1527)", () => {
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-cost-"));
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints the run's cost and tokens", async () => {
    writeLog(dir, { usd: 6.45, tokens: 69641 });
    await logsCommand({ path: dir });
    expect(out.join("\n")).toContain(
      "cost $6.45 (SDK estimate) · 69,641 tokens",
    );
  });

  it("prints cost unrecorded for a log without the field", async () => {
    writeLog(dir);
    await logsCommand({ path: dir });
    expect(out.join("\n")).toContain("cost unrecorded");
    expect(out.join("\n")).not.toContain("$0.00");
  });

  it("still parses a version 1 log with and without cost", () => {
    const base = {
      ...createEmptyRunLog({
        phases: ["spec"],
        sequential: false,
        qualityLoop: false,
        maxIterations: 3,
      }),
      endTime: new Date().toISOString(),
    };
    expect(RunLogSchema.safeParse(base).success).toBe(true);
    expect(
      RunLogSchema.safeParse({ ...base, cost: { usd: 1.5, tokens: 10 } })
        .success,
    ).toBe(true);
  });
});
