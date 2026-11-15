/**
 * #1652 derived AC-6: the qa dispatch itself hands `executePhaseWithRetry` a
 * config whose `promptContext` carries the reach block. Drives the real
 * `runIssueWithLogging` with the phase executor mocked, so deleting the
 * wiring at the dispatch fails here even though `getPhasePrompt` (AC-2) still
 * builds the block when given one. Also checks the issue result carries the
 * needs-human ACs for the summary (E-4) and the run log gets `reach` (E-3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  PhaseResult,
  IssueExecutionContext,
  RunOptions,
} from "./types.js";
import type { StateManager } from "./state-manager.js";
import type { LogWriter } from "./log-writer.js";

vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  hasExecChanges: vi.fn().mockReturnValue(false),
}));

vi.mock("./worktree-manager.js", () => ({
  createCheckpointCommit: vi.fn(),
  rebaseBeforePR: vi.fn(),
  createPR: vi.fn(),
  readCacheMetrics: vi.fn(),
  filterResumedPhases: vi.fn(),
}));

vi.mock("./git-diff-utils.js", () => ({
  getGitDiffStats: vi.fn(),
  getCommitHash: vi.fn(),
  resolveDiffBase: vi.fn().mockReturnValue("origin/main"),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { runIssueWithLogging } from "./batch-executor.js";

const mockExecutePhase = vi.mocked(executePhaseWithRetry);

const COMMAND = "npx tsx --env-file=.env.local scripts/dev/query.ts";

function stateManagerWith(
  items: Array<{ id: string; evidence?: string }>,
): StateManager {
  const methods: Record<string, unknown> = {
    getIssueState: vi.fn().mockResolvedValue({
      acceptanceCriteria: {
        items: items.map((item) => ({
          ...item,
          description: item.id,
          verificationMethod: "unit_test",
          status: "pending",
        })),
      },
    }),
  };
  return new Proxy(methods, {
    get: (target, prop: string) =>
      (target[prop] ??= vi.fn().mockResolvedValue(undefined)),
  }) as unknown as StateManager;
}

function makeCtx(
  stateManager: StateManager,
  logWriter: LogWriter | null = null,
): IssueExecutionContext {
  return {
    issueNumber: 1652,
    title: "evidence reach",
    labels: [],
    config: {
      phases: ["exec", "qa"],
      phaseTimeout: 1800,
      qualityLoop: false,
      maxIterations: 1,
      sequential: false,
      concurrency: 1,
      parallel: false,
      verbose: false,
      noSmartTests: false,
      dryRun: false,
      mcp: false,
      retry: false,
    } as ExecutionConfig,
    options: { autoDetectPhases: false, noPr: true } as RunOptions,
    services: { logWriter, stateManager },
    worktree: { path: "/tmp/worktree-1652", branch: "feature/1652" },
    postComment: vi.fn().mockResolvedValue(undefined),
  };
}

function configFor(phase: string): ExecutionConfig | undefined {
  return mockExecutePhase.mock.calls.find((c) => c[1] === phase)?.[2];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SEQUANT_ORCHESTRATOR", "");
  mockExecutePhase.mockImplementation(
    async (_issue, phase) =>
      ({
        phase,
        success: true,
        durationSeconds: 1,
        ...(phase === "qa"
          ? {
              verdict: "READY_FOR_MERGE",
              output: "| AC-1 | MET | ok |\n| AC-2 | PENDING | person |",
            }
          : {}),
      }) as PhaseResult,
  );
});

describe("qa dispatch passes the evidence reach block (#1652 AC-6)", () => {
  it("puts the needs-human AC and its command in the qa config's promptContext", async () => {
    const setAcStatuses = vi.fn();
    // Every other LogWriter method is a no-op.
    const logWriter = new Proxy({ setAcStatuses } as Record<string, unknown>, {
      get: (target, prop: string) => (target[prop] ??= vi.fn()),
    }) as unknown as LogWriter;
    const result = await runIssueWithLogging(
      makeCtx(
        stateManagerWith([
          { id: "AC-1", evidence: "`npx vitest run a.test.ts`" },
          { id: "AC-2", evidence: `\`${COMMAND}\`` },
        ]),
        logWriter,
      ),
    );

    const qaConfig = configFor("qa");
    expect(qaConfig?.promptContext).toContain(`- AC-2: \`${COMMAND}\``);
    expect(configFor("exec")?.promptContext).toBeUndefined();

    // E-4: the summary's source, whatever the verdict.
    expect(result.needsHuman).toEqual([
      { id: "AC-2", reasons: ["env-file"], commands: [COMMAND] },
    ]);
    // E-3: the run log's acs[] entries carry reach.
    expect(setAcStatuses).toHaveBeenCalledWith(
      [
        { id: "AC-1", status: "met", notes: "MET | ok", reach: "worktree" },
        {
          id: "AC-2",
          status: "pending",
          notes: "PENDING | person",
          reach: "needs-human",
          reachReasons: ["env-file"],
        },
      ],
      1652,
    );
  });

  it("passes no promptContext to qa when no AC needs a person", async () => {
    const result = await runIssueWithLogging(
      makeCtx(
        stateManagerWith([
          { id: "AC-1", evidence: "`npx vitest run a.test.ts`" },
        ]),
      ),
    );
    expect(configFor("qa")).toBeDefined();
    expect(configFor("qa")?.promptContext).toBeUndefined();
    expect(result.needsHuman).toBeUndefined();
  });
});
