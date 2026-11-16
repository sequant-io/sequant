/**
 * #1681: the ready gate's qa passes carry #1652's do-not-run block, on both
 * entry points (`--ready-gate` via `runReadyGateForIssue`, `sequant ready` via
 * `readyCommand`), and the gate's loop pass does not.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecutionConfig, PhaseResult } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { StateManager } from "./state-manager.js";

vi.mock("../../commands/run-progress.js", () => ({
  buildProgressWiring: vi.fn().mockReturnValue({
    renderer: null,
    heartbeat: null,
    onProgress: undefined,
  }),
}));
vi.mock("./worktree-manager.js", () => ({ listWorktrees: vi.fn() }));
vi.mock("./platforms/github.js", () => ({ GitHubProvider: vi.fn() }));
vi.mock("./state-manager.js", () => ({ getStateManager: vi.fn() }));
vi.mock("../settings.js", async (importActual) => ({
  ...(await importActual<typeof import("../settings.js")>()),
  getSettings: vi.fn(),
}));

import { runReadyGateForIssue } from "./batch-executor.js";
import { readyCommand } from "../../commands/ready.js";
import { runReadyGate, buildPhaseConfig } from "./ready-gate.js";
import type { RunReadyGateOptions } from "./ready-gate.js";
import { listWorktrees } from "./worktree-manager.js";
import { getStateManager } from "./state-manager.js";
import { GitHubProvider } from "./platforms/github.js";
import { getSettings } from "../settings.js";

const ISSUE = 1681;
const COMMAND = "npx tsx --env-file=.env.local scripts/dev/query.ts";

function stateManagerWith(
  items: Array<{ id: string; evidence?: string }>,
): StateManager {
  return {
    getIssueState: vi.fn().mockResolvedValue({
      issueNumber: ISSUE,
      acceptanceCriteria: {
        items: items.map((item) => ({
          ...item,
          description: item.id,
          verificationMethod: "unit_test",
          status: "pending",
        })),
      },
    }),
    initializeIssue: vi.fn().mockResolvedValue(undefined),
    updateIssueStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateManager;
}

const ONE_NEEDS_HUMAN = [
  { id: "AC-1", evidence: `\`${COMMAND}\`` },
  { id: "AC-2", evidence: "`npx vitest run a.test.ts`" },
];
const NONE = [{ id: "AC-1", evidence: "`npx vitest run a.test.ts`" }];

const GATE_RESULT = {
  issueNumber: ISSUE,
  policy: "ac",
  ready: true,
  reason: "READY",
  issueStatus: "waiting_for_human_merge",
  iterations: 1,
  finalVerdict: "READY_FOR_MERGE",
  autoFixed: [],
  remaining: [],
  tokensUsed: 0,
  report: "",
} as unknown as Awaited<ReturnType<typeof runReadyGate>>;

function gateCapture(): {
  runGate: typeof runReadyGate;
  received: () => ExecutionConfig;
} {
  const runGate = vi.fn().mockResolvedValue(GATE_RESULT);
  return {
    runGate: runGate as unknown as typeof runReadyGate,
    received: () => runGate.mock.calls[0][0].config,
  };
}

describe("ready gate qa passes carry the do-not-run block (#1681)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("--ready-gate (runReadyGateForIssue)", () => {
    async function run(
      items: Array<{ id: string; evidence?: string }>,
      config: ExecutionConfig = DEFAULT_CONFIG,
    ): Promise<ExecutionConfig> {
      const { runGate, received } = gateCapture();
      await runReadyGateForIssue({
        issueNumber: ISSUE,
        worktreePath: "/tmp/wt",
        config,
        stateManager: stateManagerWith(items),
        log: () => {},
        runGate,
        getSettingsFn: vi
          .fn()
          .mockResolvedValue({ ready: { policy: "ac" } }) as never,
        fetchBody: () => null,
        postComment: vi.fn().mockResolvedValue(undefined),
      });
      return received();
    }

    it("names the needs-human AC and its command", async () => {
      const config = await run(ONE_NEEDS_HUMAN);
      expect(config.promptContext).toContain("AC-1");
      expect(config.promptContext).toContain(COMMAND);
      expect(config.promptContext).not.toContain("AC-2");
    });

    it("leaves the config unchanged when no AC needs a person", async () => {
      const config = await run(NONE);
      expect(config.promptContext).toBe(DEFAULT_CONFIG.promptContext);
    });
  });

  describe("sequant ready (readyCommand)", () => {
    async function run(
      manager: Partial<StateManager>,
    ): Promise<ExecutionConfig> {
      vi.mocked(getSettings).mockResolvedValue({
        ready: { policy: "ac" },
        run: { maxIterations: 3, timeout: 1800 },
        agents: {},
      } as Awaited<ReturnType<typeof getSettings>>);
      vi.mocked(listWorktrees).mockReturnValue([
        { issue: ISSUE, path: "/tmp/wt", branch: "feature/1681" },
      ] as ReturnType<typeof listWorktrees>);
      vi.mocked(GitHubProvider).mockImplementation(function () {
        return {
          fetchIssueBodySync: () => null,
          fetchIssueTitleSync: () => "Title",
          postComment: vi.fn().mockResolvedValue(undefined),
        } as unknown as GitHubProvider;
      });
      vi.mocked(getStateManager).mockReturnValue(
        manager as unknown as ReturnType<typeof getStateManager>,
      );
      const gate = vi.fn().mockResolvedValue(GATE_RESULT);
      const gateModule = await import("./ready-gate.js");
      vi.spyOn(gateModule, "runReadyGate").mockImplementation(gate);
      await readyCommand(String(ISSUE), { json: true });
      return (gate.mock.calls[0][0] as RunReadyGateOptions).config;
    }

    it("names the needs-human AC and its command", async () => {
      const config = await run(stateManagerWith(ONE_NEEDS_HUMAN));
      expect(config.promptContext).toContain("AC-1");
      expect(config.promptContext).toContain(COMMAND);
    });

    it("gives an untracked issue no block and does not throw", async () => {
      const config = await run({
        getIssueState: vi.fn().mockResolvedValue(null),
        initializeIssue: vi.fn().mockResolvedValue(undefined),
        updateIssueStatus: vi.fn().mockResolvedValue(undefined),
      });
      expect(config.promptContext ?? "").not.toContain(COMMAND);
    });
  });

  it("the gate's qa pass keeps the block and its loop pass replaces it", async () => {
    const { runGate, received } = gateCapture();
    await runReadyGateForIssue({
      issueNumber: ISSUE,
      worktreePath: "/tmp/wt",
      config: DEFAULT_CONFIG,
      stateManager: stateManagerWith(ONE_NEEDS_HUMAN),
      log: () => {},
      runGate,
      getSettingsFn: vi
        .fn()
        .mockResolvedValue({ ready: { policy: "ac" } }) as never,
      fetchBody: () => null,
      postComment: vi.fn().mockResolvedValue(undefined),
    });
    const opts = { config: received() } as RunReadyGateOptions;
    const qa = buildPhaseConfig(opts, { fullQa: true });
    const loop = buildPhaseConfig(opts, { promptContext: "loop only" });
    expect(qa.promptContext).toContain(COMMAND);
    expect(loop.promptContext).toBe("loop only");
  });
});

// Keep the type import used for PhaseResult-shaped fixtures out of lint noise.
export type _Unused = PhaseResult;
