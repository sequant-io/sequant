/**
 * #1688: every phase dispatch gets #1652's do-not-run block, built at the one
 * site that turns a config into a prompt (`executePhase`). Drives the real
 * `executePhaseWithRetry` in dry-run mode, which returns the built prompt as
 * `output`. The ready gate's assertions (#1681) moved here from the config
 * seam: no caller wraps the config, so they check the dispatched prompt.
 * AC-2: an issue with no state record is classified from its body.
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
  dispatchNeedsHumanAcs,
  executePhaseWithRetry,
  PROMPT_CONTEXT_SENTINEL,
} from "./phase-executor.js";
import { runReadyGateForIssue } from "./batch-executor.js";
import { readyCommand } from "../../commands/ready.js";
import { buildPhaseConfig, runReadyGate } from "./ready-gate.js";
import type { RunReadyGateOptions } from "./ready-gate.js";
import { getStateManager } from "./state-manager.js";
import { listWorktrees } from "./worktree-manager.js";
import { GitHubProvider } from "./platforms/github.js";
import { getSettings } from "../settings.js";

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

type Items = Array<{ id: string; evidence?: string }>;

/**
 * A state manager whose issue has `items` as its AC record, no AC record
 * (`"no-record"`), or no state at all (`null`).
 */
function managerWith(items: Items | "no-record" | null): StateManager {
  const acceptanceCriteria = Array.isArray(items)
    ? {
        items: items.map((item) => ({
          ...item,
          description: item.id,
          verificationMethod: "unit_test",
          status: "pending",
        })),
      }
    : undefined;
  return {
    getIssueState: vi
      .fn()
      .mockResolvedValue(
        items === null ? null : { issueNumber: ISSUE, acceptanceCriteria },
      ),
    updateAcceptanceCriteria: vi.fn().mockResolvedValue(undefined),
    initializeIssue: vi.fn().mockResolvedValue(undefined),
    updateIssueStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateManager;
}

function useState(manager: StateManager): void {
  vi.mocked(getStateManager).mockReturnValue(manager);
}

/** `gh` as seen by the dispatch's body fallback and by `sequant ready`. */
function useGitHub(body: string | null = BODY): ReturnType<typeof vi.fn> {
  const fetchIssueBodySync = vi.fn(() => body);
  vi.mocked(GitHubProvider).mockImplementation(function () {
    return {
      fetchIssueBodySync,
      fetchIssueTitleSync: () => "Title",
      postComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitHubProvider;
  });
  return fetchIssueBodySync;
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

/**
 * Runs `--ready-gate` with a gate that dispatches a qa pass and a loop pass in
 * dry-run mode. Returns the config the gate was handed and each pass's prompt.
 */
async function readyGatePrompts(): Promise<{
  gateConfig: ExecutionConfig;
  prompts: Record<"qa" | "loop", string>;
}> {
  const prompts = { qa: "", loop: "" };
  let gateConfig = DRY;
  const runGate = vi.fn(async (opts: RunReadyGateOptions) => {
    gateConfig = opts.config;
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
    log: () => {},
    runGate: runGate as unknown as typeof runReadyGate,
    getSettingsFn: vi
      .fn()
      .mockResolvedValue({ ready: { policy: "ac" } }) as never,
    fetchBody: () => BODY,
    postComment: vi.fn().mockResolvedValue(undefined),
  });
  expect(runGate).toHaveBeenCalledTimes(1);
  return { gateConfig, prompts };
}

/**
 * Runs `sequant ready` with a gate that dispatches one qa pass in dry-run
 * mode. Returns the config the gate was handed and the qa prompt.
 */
async function sequantReadyPrompt(): Promise<{
  gateConfig: ExecutionConfig;
  prompt: string;
}> {
  vi.mocked(getSettings).mockResolvedValue({
    ready: { policy: "ac" },
    run: { maxIterations: 3, timeout: 1800 },
    agents: {},
  } as Awaited<ReturnType<typeof getSettings>>);
  vi.mocked(listWorktrees).mockReturnValue([
    { issue: ISSUE, path: "/tmp/wt", branch: "feature/1688" },
  ] as ReturnType<typeof listWorktrees>);
  let prompt = "";
  let gateConfig = DRY;
  const gateModule = await import("./ready-gate.js");
  vi.spyOn(gateModule, "runReadyGate").mockImplementation(async (opts) => {
    gateConfig = opts.config;
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
  return { gateConfig, prompt };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  useGitHub();
});

describe("every phase dispatch carries the needs-human block (#1688 AC-1)", () => {
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
});

describe("the ready gate's passes carry the block at the prompt (#1681, #1688)", () => {
  it("--ready-gate: the qa and loop prompts name the needs-human AC, and the gate's config is not wrapped", async () => {
    useState(managerWith(ONE_NEEDS_HUMAN));
    const { gateConfig, prompts } = await readyGatePrompts();

    expect(gateConfig.promptContext).toBe(DRY.promptContext);
    expect(count(prompts.qa, LINE)).toBe(1);
    expect(block(prompts.qa)).toContain("`PENDING`");
    expect(block(prompts.qa)).not.toContain("AC-1");
    expect(count(prompts.loop, OPEN)).toBe(1);
    expect(block(prompts.loop)).toContain("## QA findings");
    expect(count(prompts.loop, LINE)).toBe(1);
    expect(block(prompts.loop)).toContain("including to check your own work");
  });

  it("--ready-gate: an issue with no needs-human AC gets no block on any pass", async () => {
    useState(managerWith(NONE));
    const { prompts } = await readyGatePrompts();
    expect(prompts.qa).not.toContain(HEADING);
    expect(prompts.loop).not.toContain(HEADING);
  });

  it("sequant ready: the qa prompt names the needs-human AC, and the gate's config is not wrapped", async () => {
    useState(managerWith(ONE_NEEDS_HUMAN));
    const { gateConfig, prompt } = await sequantReadyPrompt();

    expect(gateConfig.promptContext ?? "").not.toContain(COMMAND);
    expect(count(prompt, OPEN)).toBe(1);
    expect(count(prompt, LINE)).toBe(1);
  });
});

describe("an issue with no state record is classified from its body (#1688 AC-2)", () => {
  it("no state record: a phase dispatch carries the block and state is not written", async () => {
    const manager = managerWith(null);
    useState(manager);
    for (const phase of ["exec", "qa"] as const) {
      const prompt = await dispatchPrompt(phase);
      expect(count(prompt, OPEN)).toBe(1);
      expect(count(prompt, LINE)).toBe(1);
    }
    // The non-dry path takes the same branch for an untracked issue.
    expect(
      await dispatchNeedsHumanAcs(ISSUE, false, () => BODY),
    ).toMatchObject([{ id: "AC-2", commands: [COMMAND] }]);
    expect(manager.updateAcceptanceCriteria).not.toHaveBeenCalled();
    expect(manager.initializeIssue).not.toHaveBeenCalled();
  });

  it("no state record: --ready-gate's qa and loop passes carry the block and state is not written", async () => {
    const manager = managerWith(null);
    useState(manager);
    const { prompts } = await readyGatePrompts();

    expect(count(prompts.qa, LINE)).toBe(1);
    expect(block(prompts.qa)).toContain("`PENDING`");
    expect(count(prompts.loop, LINE)).toBe(1);
    expect(block(prompts.loop)).toContain("including to check your own work");
    expect(manager.updateAcceptanceCriteria).not.toHaveBeenCalled();
  });

  it("no state record: sequant ready's dispatched prompt carries the block", async () => {
    const manager = managerWith(null);
    useState(manager);
    const { prompt } = await sequantReadyPrompt();

    expect(count(prompt, OPEN)).toBe(1);
    expect(count(prompt, LINE)).toBe(1);
    expect(manager.updateAcceptanceCriteria).not.toHaveBeenCalled();
  });

  it("no state record and no body: no block, and nothing throws", async () => {
    useState(managerWith(null));
    expect(await dispatchNeedsHumanAcs(ISSUE, false, () => null)).toEqual([]);
    expect(
      await dispatchNeedsHumanAcs(ISSUE, false, () => {
        throw new Error("gh unavailable");
      }),
    ).toEqual([]);
  });

  it("no state record: the body is fetched once per issue, not once per dispatch", async () => {
    useState(managerWith(null));
    const fetchIssueBodySync = useGitHub();
    const issue = 168801; // not fetched by any other case in this file
    await dispatchNeedsHumanAcs(issue, false);
    await dispatchNeedsHumanAcs(issue, false);
    expect(fetchIssueBodySync).toHaveBeenCalledTimes(1);
    expect(fetchIssueBodySync).toHaveBeenCalledWith(String(issue));
  });
});

describe("a tracked issue with no AC record (#1688)", () => {
  it("is registered from its body on a real dispatch", async () => {
    const manager = managerWith("no-record");
    useState(manager);
    const acs = await dispatchNeedsHumanAcs(ISSUE, false, () => BODY);

    expect(acs).toMatchObject([{ id: "AC-2", commands: [COMMAND] }]);
    expect(manager.updateAcceptanceCriteria).toHaveBeenCalledTimes(1);
  });

  it("is classified from its body without a write in a dry run", async () => {
    const manager = managerWith("no-record");
    useState(manager);
    const acs = await dispatchNeedsHumanAcs(ISSUE, true, () => BODY);

    expect(acs).toMatchObject([{ id: "AC-2", commands: [COMMAND] }]);
    expect(manager.updateAcceptanceCriteria).not.toHaveBeenCalled();
  });
});
