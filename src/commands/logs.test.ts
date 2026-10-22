import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logsCommand } from "./logs.js";
import { createEmptyRunLog } from "../lib/workflow/run-log-schema.js";

function writeLog(
  dir: string,
  suppressed?: { total: number; byScope: Record<string, number> },
): void {
  const log = {
    ...createEmptyRunLog({
      phases: ["spec", "exec"],
      sequential: false,
      qualityLoop: false,
      maxIterations: 3,
    }),
    endTime: new Date().toISOString(),
    ...(suppressed ? { suppressed } : {}),
  };
  fs.writeFileSync(path.join(dir, "run-test.json"), JSON.stringify(log));
}

describe("sequant logs suppressed errors line", () => {
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-suppressed-"));
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints the suppressed count with its per-scope breakdown", async () => {
    writeLog(dir, { total: 3, byScope: { state: 2, progress: 1 } });
    await logsCommand({ path: dir });
    expect(out.join("\n")).toMatch(
      /Suppressed errors: 3 \(state 2, progress 1\)/,
    );
  });

  it("prints no suppressed line when the log has no suppressed field", async () => {
    writeLog(dir);
    await logsCommand({ path: dir });
    expect(out.join("\n")).not.toMatch(/Suppressed errors/);
  });
});
