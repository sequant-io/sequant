/**
 * Phase agents get the resolver's base branch (#1460).
 *
 * Real git, in a temp repo whose default branch is `master` — the case where
 * a hard-coded `main` breaks every `origin/main` in a phase's git commands.
 * Only the driver boundary is mocked, so the env asserted here is the env the
 * phase agent would receive.
 *
 * - AC-1: `SEQUANT_BASE_BRANCH` is set from `resolveBaseRef(cwd)` with the
 *   `origin/` prefix stripped — for a worktree phase with a recorded base, and
 *   for the spec phase, which runs in the main checkout with nothing recorded.
 * - AC-2: `resolveBaseRef`'s no-recorded-base fallback is
 *   `origin/<default branch of cwd>`, not a literal `origin/main`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../agents-md.js", () => ({
  readAgentsMd: vi.fn().mockResolvedValue(null),
}));
vi.mock("./drivers/index.js", () => ({
  getDriver: vi.fn(),
}));
// The spec phase checks the issue for a posted marker via `gh`; keep it local.
vi.mock("./spec-recommendation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spec-recommendation.js")>()),
  specMarkerPostedSince: vi.fn().mockReturnValue(false),
}));

import { executePhaseWithRetry, resolveBaseRef } from "./phase-executor.js";
import { getDriver } from "./drivers/index.js";
import type { AgentDriver } from "./drivers/agent-driver.js";
import { buildExecutionConfig, resolveRunOptions } from "./config-resolver.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { RunOptions } from "./types.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/**
 * A clone of a bare `origin` whose default branch is `master`, with
 * `origin/HEAD` set locally (no network) and no sequant base recorded.
 */
function makeMasterRepo(): { work: string; cleanup: () => void } {
  const origin = mkdtempSync(join(tmpdir(), "sequant-1460-origin-"));
  const work = mkdtempSync(join(tmpdir(), "sequant-1460-work-"));
  git(origin, "init", "--bare", "--initial-branch=master");
  git(work, "init", "--initial-branch=master");
  git(work, "config", "user.email", "test@sequant.test");
  git(work, "config", "user.name", "Test");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "README.md"), "# repo\n");
  git(work, "add", "README.md");
  git(work, "commit", "-m", "M1: baseline");
  git(work, "push", "-u", "origin", "master");
  git(work, "remote", "set-head", "origin", "master");
  return {
    work,
    cleanup: () => {
      rmSync(origin, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

function mockDriver(): AgentDriver {
  return {
    name: "claude-code",
    resolvesSkills: false,
    executePhase: vi.fn().mockResolvedValue({ success: true, output: "ok" }),
    isAvailable: vi.fn().mockResolvedValue(true),
    canResume: vi.fn().mockReturnValue(false),
  };
}

/** The env the first driver call received. */
function firstAgentEnv(): Record<string, string> | undefined {
  const driver = vi.mocked(getDriver).mock.results[0]?.value as AgentDriver;
  return vi.mocked(driver.executePhase).mock.calls[0]?.[1]?.env;
}

function config() {
  const settings = DEFAULT_SETTINGS;
  return buildExecutionConfig(
    resolveRunOptions({} as RunOptions, settings),
    settings,
    1,
  );
}

const noDelay = (): Promise<void> => Promise.resolve();

describe("resolveBaseRef falls back to the cwd's default branch (#1460 AC-2)", () => {
  let work: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ work, cleanup } = makeMasterRepo());
  });
  afterEach(() => cleanup());

  it("returns origin/master for a master-default repo with no recorded base", () => {
    expect(resolveBaseRef(work)).toBe("origin/master");
  });

  it("returns origin/master when HEAD is detached", () => {
    git(work, "checkout", "--detach");
    expect(resolveBaseRef(work)).toBe("origin/master");
  });
});

describe("phase env carries SEQUANT_BASE_BRANCH (#1460 AC-1)", () => {
  let work: string;
  let cleanup: () => void;
  const originalCwd = process.cwd();

  beforeEach(() => {
    ({ work, cleanup } = makeMasterRepo());
    vi.mocked(getDriver).mockReset();
    vi.mocked(getDriver).mockImplementation(() => mockDriver());
  });
  afterEach(() => {
    process.chdir(originalCwd);
    cleanup();
  });

  it("worktree phase: a recorded sequantBaseRef of origin/master yields master", async () => {
    git(work, "checkout", "-b", "feature/1460-test");
    git(
      work,
      "config",
      "branch.feature/1460-test.sequantBaseRef",
      "origin/master",
    );

    await executePhaseWithRetry(
      1460,
      "exec",
      config(),
      undefined,
      work,
      undefined,
      undefined,
      undefined,
      noDelay,
    );

    expect(firstAgentEnv()?.SEQUANT_WORKTREE).toBe(work);
    expect(firstAgentEnv()?.SEQUANT_BASE_BRANCH).toBe("master");
  });

  it("spec phase: no worktree, nothing recorded, origin/HEAD is master — yields master", async () => {
    // Spec runs in process.cwd() (the main checkout); there is no cwd argument.
    process.chdir(work);

    await executePhaseWithRetry(
      1460,
      "spec",
      config(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      noDelay,
    );

    expect(firstAgentEnv()?.SEQUANT_WORKTREE).toBeUndefined();
    expect(firstAgentEnv()?.SEQUANT_BASE_BRANCH).toBe("master");
  });
});
