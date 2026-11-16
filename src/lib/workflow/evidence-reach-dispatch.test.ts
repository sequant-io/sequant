/**
 * #1688: every phase dispatch gets #1652's do-not-run block, built at the one
 * site that turns a config into a prompt (`executePhase`). Drives the real
 * `executePhaseWithRetry` in dry-run mode, which returns the built prompt as
 * `output`. AC-2: an issue with no state record is classified from its body
 * on the `sequant ready` paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecutionConfig, Phase } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { StateManager } from "./state-manager.js";

vi.mock("../../commands/run-progress.js", () => ({
  buildProgressWiring: vi.fn().mockReturnValue({
    renderer: null,
    heartbeat: null,
    onProgress: undefined,
  }),
}));
vi.mock("./worktree-manager.js", async (importActual) => ({
  ...(await importActual<typeof import("./worktree-manager.js")>()),
  listWorktrees: vi.fn(),
}));
vi.mock("./platforms/github.js", () => ({ GitHubProvider: vi.fn() }));
vi.mock("./state-manager.js", () => ({ getStateManager: vi.fn() }));
vi.mock("../settings.js", async (importActual) => ({
  ...(await importActual<typeof import("../settings.js")>()),
  getSettings: vi.fn(),
}));

import {
  executePhaseWithRetry,
  PROMPT_CONTEXT_SENTINEL,
} from "./phase-executor.js";
import {
  runReadyGateForIssue,
  withEvidenceReachContext,
} from "./batch-executor.js";
import { readyCommand } from "../../commands/ready.js";
import { buildPhaseConfig, runReadyGate } from "./ready-gate.js";
import type { RunReadyGateOptions } from "./ready-gate.js";
import { getStateManager } from "./state-manager.js";
import { listWorktrees } from "./worktree-manager.js";
import { GitHubProvider } from "./platforms/github.js";
import { getSettings } from "../settings.js";
import { needsHumanAcs } from "../evidence-reach.js";

const ISSUE = 1688;
const COMMAND = "npx tsx --env-file=.env.local scripts/smoke-check.ts";
const OPEN = `<!-- ${PROMPT_CONTEXT_SENTINEL} -->`;
const HEADING = "## Evidence a person runs";
const LINE = `- AC-2: \`${COMMAND}\``;

const ONE_NEEDS_HUMAN = [
  { id: "AC-1", evidence: "`npx vitest run a.test.ts` → `3 passed`" },
  { id: "AC-2", evidence: `\`${COMMAND}\` → ok` },
];
const NONE = [{ id: "AC-1", evidence: "`npx vitest run a.test.ts`" }];

const BODY = [
  "## Acceptance Criteria",
  "",
  "- [ ] AC-1: Unit tests pass. Evidence: `npx vitest run a.test.ts` → `3 passed`",
  `- [ ] AC-2: The smoke check passes. Evidence: \`${COMMAND}\` → ok`,
].join("\n");

const DRY: ExecutionConfig = { ...DEFAULT_CONFIG, dryRun: true, retry: false };

function managerWith(
  items: Array<{ id: string; evidence?: string }> | null,
): StateManager {
  return {
    getIssueState: vi.fn().mockResolvedValue(
      items === null
        ? null
        : {
            issueNumber: ISSUE,
            acceptanceCriteria: {
              items: items.map((item) => ({
                ...item,
                description: item.id,
                verificationMethod: "unit_test",
                status: "pending",
              })),
            },
          },
    ),
    updateAcceptanceCriteria: vi.fn().mockResolvedValue(undefined),
    initializeIssue: vi.fn().mockResolvedValue(undefined),
    updateIssueStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateManager;
}

function useState(manager: StateManager): void {
  vi.mocked(getStateManager).mockReturnValue(manager);
}

async function dispatchPrompt(
  phase: Phase,
  config: ExecutionConfig = DRY,
): Promise<string> {
  const result = await executePhaseWithRetry(ISSUE, phase, config);
  return result.output ?? "";
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text inside the one sentinel block. */
function block(prompt: string): string {
  return prompt.slice(prompt.indexOf(OPEN));
}

describe("every phase dispatch carries the needs-human block (#1688 AC-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each(["spec", "exec", "qa", "loop"] as const)(
    "the %s prompt names the needs-human AC and its command in one block",
    async (phase) => {
      useState(managerWith(ONE_NEEDS_HUMAN));
      const prompt = await dispatchPrompt(phase);

      expect(count(prompt, OPEN)).toBe(1);
      expect(count(prompt, HEADING)).toBe(1);
      expect(block(prompt)).toContain(LINE);
      expect(block(prompt)).not.toContain("AC-1");
      if (phase === "qa") {
        expect(block(prompt)).toContain("`PENDING`");
      } else {
        expect(block(prompt)).toContain("including to check your own work");
        expect(block(prompt)).not.toContain("PENDING");
      }
    },
  );

  it("gives an issue with no needs-human AC no block", async () => {
    useState(managerWith(NONE));
    for (const phase of ["spec", "exec", "qa", "loop"] as const) {
      const prompt = await dispatchPrompt(phase);
      expect(prompt).not.toContain(OPEN);
      expect(prompt).not.toContain(HEADING);
    }
  });

  it("joins the loop's own context and the block into one sentinel block", async () => {
    useState(managerWith(ONE_NEEDS_HUMAN));
    const prompt = await dispatchPrompt("loop", {
      ...DRY,
      promptContext: "## QA findings",
    });
    expect(count(prompt, OPEN)).toBe(1);
    expect(block(prompt)).toContain("## QA findings");
    expect(block(prompt)).toContain(LINE);
  });

  it("does not repeat a block the qa dispatch site already joined (#1652)", async () => {
    useState(managerWith(ONE_NEEDS_HUMAN));
    const wrapped = withEvidenceReachContext(
      DRY,
      "qa",
      needsHumanAcs(ONE_NEEDS_HUMAN),
    );
    const prompt = await dispatchPrompt("qa", wrapped);
    expect(count(prompt, HEADING)).toBe(1);
    expect(count(prompt, LINE)).toBe(1);
  });
});

describe("an issue with no state record is classified from its body (#1688 AC-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("no state record: --ready-gate's qa and loop passes carry the block and state is not written", async () => {
    const manager = managerWith(null);
    useState(manager);
    const prompts: Record<string, string> = {};
    const runGate = vi.fn(async (opts: RunReadyGateOptions) => {
      for (const [phase, overrides] of [
        ["qa", { fullQa: true }],
        ["loop", { promptContext: "## QA findings" }],
      ] as const) {
        const result = await opts.runPhase(
          phase,
          { ...buildPhaseConfig(opts, overrides), dryRun: true },
          "/tmp/wt",
        );
        prompts[phase] = result.output ?? "";
      }
      return { ready: true, report: "" } as Awaited<
        ReturnType<typeof runReadyGate>
      >;
    });

    await runReadyGateForIssue({
      issueNumber: ISSUE,
      worktreePath: "/tmp/wt",
      config: DRY,
      stateManager: manager,
      log: () => {},
      runGate: runGate as unknown as typeof runReadyGate,
      getSettingsFn: vi
        .fn()
        .mockResolvedValue({ ready: { policy: "ac" } }) as never,
      fetchBody: () => BODY,
      postComment: vi.fn().mockResolvedValue(undefined),
    });

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(count(prompts.qa, LINE)).toBe(1);
    expect(block(prompts.qa)).toContain("`PENDING`");
    expect(count(prompts.loop, OPEN)).toBe(1);
    expect(block(prompts.loop)).toContain("## QA findings");
    expect(count(prompts.loop, LINE)).toBe(1);
    expect(block(prompts.loop)).toContain("including to check your own work");
    expect(manager.updateAcceptanceCriteria).not.toHaveBeenCalled();
  });

  it("no state record: sequant ready's dispatched prompt carries the block", async () => {
    const manager = managerWith(null);
    useState(manager);
    vi.mocked(getSettings).mockResolvedValue({
      ready: { policy: "ac" },
      run: { maxIterations: 3, timeout: 1800 },
      agents: {},
    } as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(listWorktrees).mockReturnValue([
      { issue: ISSUE, path: "/tmp/wt", branch: "feature/1688" },
    ] as ReturnType<typeof listWorktrees>);
    vi.mocked(GitHubProvider).mockImplementation(function () {
      return {
        fetchIssueBodySync: () => BODY,
        fetchIssueTitleSync: () => "Title",
        postComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitHubProvider;
    });
    let prompt = "";
    const gateModule = await import("./ready-gate.js");
    vi.spyOn(gateModule, "runReadyGate").mockImplementation(async (opts) => {
      const result = await opts.runPhase(
        "qa",
        { ...buildPhaseConfig(opts, { fullQa: true }), dryRun: true },
        "/tmp/wt",
      );
      prompt = result.output ?? "";
      return { ready: true, report: "" } as Awaited<
        ReturnType<typeof runReadyGate>
      >;
    });

    await readyCommand(String(ISSUE), { json: true });

    expect(count(prompt, OPEN)).toBe(1);
    expect(count(prompt, LINE)).toBe(1);
    expect(manager.updateAcceptanceCriteria).not.toHaveBeenCalled();
  });
});
