import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type {
  ExecutionConfig,
  IssueExecutionContext,
  PhaseResult,
} from "./types.js";
import type {
  Comment,
  Issue,
  PlatformProvider,
} from "./platforms/platform-provider.js";

vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  hasExecChanges: vi.fn().mockReturnValue(true),
}));

vi.mock("./worktree-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./worktree-manager.js")>();
  return {
    composeExecSummary: real.composeExecSummary,
    buildAutomatedPRBody: real.buildAutomatedPRBody,
    createCheckpointCommit: vi.fn(),
    rebaseBeforePR: vi.fn(),
    createPR: vi.fn(),
    readCacheMetrics: vi.fn(),
    filterResumedPhases: vi.fn(),
  };
});

vi.mock("./log-writer.js", () => ({
  LogWriter: vi.fn(),
  createPhaseLogFromTiming: vi.fn(),
}));

vi.mock("./state-manager.js", () => ({ StateManager: vi.fn() }));

import { executePhaseWithRetry } from "./phase-executor.js";
import { createPR } from "./worktree-manager.js";
import { GitHubProvider } from "./platforms/github.js";
import { runIssueWithLogging } from "./batch-executor.js";
import {
  deliverReadFirstComment,
  postReadFirstComment,
} from "./review-residue.post.js";

const PR = 4242;
const ISSUE = 1520;

/** An in-memory PR: comments posted are the comments read back. */
class FakeProvider implements PlatformProvider {
  name = "fake";
  posted: { prId: string; body: string }[] = [];
  constructor(private issueBody: string) {}
  async fetchIssue(id: string): Promise<Issue> {
    return {
      id,
      number: Number(id),
      title: "t",
      body: this.issueBody,
      labels: [],
      state: "open",
    };
  }
  async postComment(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async createPR(): Promise<never> {
    throw new Error("not used");
  }
  async getPRStatus(): Promise<{ state: "open" }> {
    return { state: "open" };
  }
  async postPRComment(prId: string, body: string): Promise<void> {
    this.posted.push({ prId, body });
  }
  async checkAuth(): Promise<boolean> {
    return true;
  }
  async getIssueComments(issueId: string): Promise<Comment[]> {
    return this.posted
      .filter((p) => p.prId === issueId)
      .map((p) => ({ body: p.body, createdAt: "2026-10-24T00:00:00Z" }));
  }
}

const ISSUE_BODY = [
  "## Acceptance Criteria",
  "- [ ] AC-1: a works. Evidence: `npx vitest run src/a.test.ts` → passes",
].join("\n");

let repo: string;

function git(...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, stdio: "pipe" },
  );
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "read-first-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feature/1520");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(repo, "src/a.test.ts"),
    'import { a } from "./a.js";\nit("a", () => expect(a).toBe(1));\n',
  );
  git("add", ".");
  git("commit", "-q", "-m", "feat: a");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

const success = (phase: string): PhaseResult => ({
  phase: phase as PhaseResult["phase"],
  success: true,
  durationSeconds: 1,
});

function ctx(
  provider: PlatformProvider,
  phases: ExecutionConfig["phases"] = ["exec", "qa"],
): IssueExecutionContext {
  return {
    issueNumber: ISSUE,
    title: "t",
    labels: [],
    config: {
      phases,
      phaseTimeout: 60,
      qualityLoop: true,
      maxIterations: 3,
      skipVerification: false,
      sequential: false,
      concurrency: 1,
      parallel: false,
      verbose: false,
      noSmartTests: false,
      dryRun: false,
      mcp: false,
      retry: false,
    },
    options: { autoDetectPhases: false },
    services: { logWriter: null, stateManager: null },
    worktree: { path: repo, branch: "feature/1520" },
    baseBranch: "main",
    postComment: vi.fn().mockResolvedValue(undefined),
    readFirstProvider: provider,
  };
}

/** qa fails once, the loop re-runs exec, the second qa passes. */
function qaLoopsOnce(): () => number {
  let qaPass = 0;
  vi.mocked(executePhaseWithRetry).mockImplementation(async (_i, phase) => {
    if (phase === "qa") {
      qaPass++;
      return {
        ...success("qa"),
        success: qaPass > 1,
        verdict: qaPass > 1 ? "READY_FOR_MERGE" : "AC_NOT_MET",
      } as PhaseResult;
    }
    return success(phase as string);
  });
  return () => qaPass;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(
    GitHubProvider.prototype,
    "fetchIssueCommentBodiesSync",
  ).mockReturnValue([]);
  vi.mocked(createPR).mockReturnValue({
    attempted: true,
    success: true,
    prNumber: PR,
    prUrl: `https://example.test/pr/${PR}`,
  } as ReturnType<typeof createPR>);
});

describe("the Read-first comment after QA (#1520 AC-4)", () => {
  it("posts one comment starting ## Read first after a QA → loop → QA run", async () => {
    const provider = new FakeProvider(ISSUE_BODY);
    const qaPasses = qaLoopsOnce();

    const result = await runIssueWithLogging(ctx(provider));

    expect(qaPasses()).toBe(2);
    expect(result.prNumber).toBe(PR);
    expect(provider.posted).toHaveLength(1);
    expect(provider.posted[0].prId).toBe(String(PR));
    expect(provider.posted[0].body.startsWith("## Read first\n")).toBe(true);
    expect(provider.posted[0].body).toContain("`src/a.test.ts` — AC-1");
    expect(provider.posted[0].body).toContain(
      "`src/a.ts` (+1 −0): no AC's evidence names it",
    );
  });

  it("a second QA run on the same PR does not post a second one", async () => {
    const provider = new FakeProvider(ISSUE_BODY);
    qaLoopsOnce();
    await runIssueWithLogging(ctx(provider));
    qaLoopsOnce();
    await runIssueWithLogging(ctx(provider, ["qa"]));

    expect(provider.posted).toHaveLength(1);
    expect(
      await postReadFirstComment(provider, PR, "## Read first\nagain"),
    ).toBe(false);
  });

  it("a run that ran no qa posts nothing", async () => {
    const provider = new FakeProvider(ISSUE_BODY);
    vi.mocked(executePhaseWithRetry).mockResolvedValue(success("exec"));

    await runIssueWithLogging(ctx(provider, ["exec"]));

    expect(provider.posted).toHaveLength(0);
  });

  it("a collection failure warns, posts nothing and never throws", async () => {
    const provider = new FakeProvider(ISSUE_BODY);
    const fetchIssue = vi.spyOn(provider, "fetchIssue");
    const warn = vi.fn();

    const posted = await deliverReadFirstComment({
      provider,
      worktreePath: join(repo, "does-not-exist"),
      baseBranch: "main",
      prNumber: PR,
      issueNumber: ISSUE,
      mutationMarkers: [],
      warn,
    });

    expect(posted).toBe(false);
    expect(provider.posted).toHaveLength(0);
    expect(fetchIssue).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("Read-first comment not posted");
  });
});
