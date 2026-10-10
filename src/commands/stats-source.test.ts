/**
 * Tests for #929 AC-3: `sequant stats` separates `ready` from `run`.
 *
 * Run with: npm test -- src/commands/stats-source.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { statsCommand } from "./stats.js";

vi.mock("fs");
vi.mock("path", async () => {
  const actual = await vi.importActual("path");
  return {
    ...actual,
    join: (...args: string[]) => args.join("/"),
  };
});
vi.mock("../lib/cli-ui.js", () => ({
  configureUI: vi.fn(),
  getUIConfig: vi.fn(() => ({ noColor: true, jsonMode: false })),
  colors: {
    success: (s: string) => s,
    error: (s: string) => s,
    warning: (s: string) => s,
    muted: (s: string) => s,
    info: (s: string) => s,
    bold: (s: string) => s,
    header: (s: string) => s,
    accent: (s: string) => s,
  },
  ui: {
    headerBox: vi.fn((t: string) => t),
    sectionHeader: vi.fn((t: string) => t),
    phaseProgress: vi.fn(() => ""),
    progressBar: vi.fn(() => ""),
    keyValueTable: vi.fn(() => ""),
    table: vi.fn(() => ""),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      warn: vi.fn(),
      text: "",
    })),
  },
}));

function run(
  source: "run" | "ready" | undefined,
  overrides: { filesChanged?: number; outcome?: string } = {},
): Record<string, unknown> {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    date: "2026-10-10T12:00:00.000Z",
    issues: [929],
    phases: ["qa"],
    outcome: overrides.outcome ?? "success",
    ...(source ? { source } : {}),
    duration: 60,
    model: "sonnet",
    flags: [],
    metrics: {
      tokensUsed: 0,
      filesChanged: overrides.filesChanged ?? 0,
      linesAdded: 0,
      acceptanceCriteria: 0,
      qaIterations: 1,
    },
  };
}

describe("statsCommand — #929 by-source breakdown", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  function serveMetrics(runs: unknown[]): void {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => String(p).endsWith("metrics.json"),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ version: 1, runs }),
    );
    (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
  }

  function output(): string {
    return consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("AC-3: ready runs counted separately from run runs", () => {
    it("--json reports bySource.run.total === 1 and bySource.ready.total === 1", async () => {
      serveMetrics([run("run"), run("ready", { outcome: "failed" })]);

      await statsCommand({ json: true });
      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);

      expect(parsed.bySource.run.total).toBe(1);
      expect(parsed.bySource.ready.total).toBe(1);
      expect(parsed.bySource.ready.failed).toBe(1);
      expect(parsed.totalRuns).toBe(1);
    });

    it("shows a 'By source' line only when a ready record exists", async () => {
      serveMetrics([run("run")]);
      await statsCommand({});
      expect(output()).not.toContain("By source");

      consoleSpy.mockClear();
      serveMetrics([run("run"), run("ready")]);
      await statsCommand({});
      expect(output()).toContain("By source: run 1, ready 1");
    });

    it("counts a legacy record with no source as a run", async () => {
      serveMetrics([run(undefined), run("ready")]);

      await statsCommand({ json: true });
      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);

      expect(parsed.bySource.run.total).toBe(1);
    });

    describe("edge cases", () => {
      it("does not throw when every record is source:ready (empty run subset)", async () => {
        serveMetrics([run("ready")]);

        await expect(statsCommand({})).resolves.toBeUndefined();
        consoleSpy.mockClear();
        await statsCommand({ json: true });
        const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);

        expect(parsed.totalRuns).toBe(0);
        expect(parsed.avgFilesChanged).toBe(0);
        expect(parsed.bySource.ready.total).toBe(1);
      });

      it("excludes ready records from headline file/line averages", async () => {
        serveMetrics([run("run", { filesChanged: 10 }), run("ready")]);

        await statsCommand({ json: true });
        const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);

        expect(parsed.avgFilesChanged).toBe(10);
      });
    });
  });
});
