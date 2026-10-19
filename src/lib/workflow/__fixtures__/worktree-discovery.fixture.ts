/**
 * Hermetic `spawnSync` for tests that call `discoverUntrackedWorktrees` (#1322).
 *
 * Unmocked, discovery reads the developer checkout's real `git worktree list`
 * and runs one synchronous `gh issue view` per untracked issue worktree. On a
 * checkout with ~20 issue worktrees that is 10–30 s per test and grows with
 * machine load; the list can also change between two calls in one test while
 * other sessions create worktrees. On CI there are no issue worktrees, so the
 * assertions never ran at all.
 *
 * Install with `installWorktreeDiscoveryFixture(mockSpawnSync, actualSpawnSync)`.
 * The mock answers by command + args (not call order), so extra spawns in the
 * code under test do not shift it; any other command goes to `passthrough`.
 */
import type { spawnSync as SpawnSync } from "child_process";
import type { Mock } from "vitest";

export const FIXTURE_ROOT = "/fixture/repo";

/** Issue worktrees in the fixture — what discovery should report as untracked. */
export const FIXTURE_ISSUE_WORKTREES = [
  {
    issueNumber: 9001,
    branch: "feature/9001-alpha",
    path: `${FIXTURE_ROOT}-wt/9001`,
  },
  {
    issueNumber: 9002,
    branch: "feature/9002-beta",
    path: `${FIXTURE_ROOT}-wt/9002`,
  },
  { issueNumber: 9003, branch: "issue-9003", path: `${FIXTURE_ROOT}-wt/9003` },
] as const;

/** Worktrees discovery must skip: main, a detached HEAD, a non-issue branch. */
export const FIXTURE_SKIPPED_COUNT = 3;

export const FIXTURE_PORCELAIN = [
  `worktree ${FIXTURE_ROOT}`,
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  `worktree ${FIXTURE_ROOT}-wt/detached`,
  "HEAD 2222222222222222222222222222222222222222",
  "detached",
  "",
  `worktree ${FIXTURE_ROOT}-wt/chore`,
  "HEAD 3333333333333333333333333333333333333333",
  "branch refs/heads/chore/tidy-docs",
  "",
  ...FIXTURE_ISSUE_WORKTREES.flatMap((wt, i) => [
    `worktree ${wt.path}`,
    `HEAD ${String(i + 4).repeat(40)}`,
    `branch refs/heads/${wt.branch}`,
    "",
  ]),
].join("\n");

export function fixtureIssueTitle(issueNumber: number): string {
  return `Fixture issue ${issueNumber}`;
}

function ok(stdout: string, asBuffer: boolean) {
  const out = asBuffer ? Buffer.from(stdout) : stdout;
  const err = asBuffer ? Buffer.from("") : "";
  return {
    status: 0,
    stdout: out,
    stderr: err,
    pid: 0,
    output: [null, out, err],
    signal: null,
  };
}

export function installWorktreeDiscoveryFixture(
  mock: Mock<typeof SpawnSync>,
  passthrough: typeof SpawnSync,
): void {
  mock.mockImplementation(((
    cmd: string,
    args?: readonly string[],
    opts?: { encoding?: string },
  ) => {
    const a = args ?? [];
    // getWorktreeDetails passes no encoding and calls stdout.toString().
    if (cmd === "git" && a[0] === "worktree" && a[1] === "list") {
      return ok(FIXTURE_PORCELAIN, !opts?.encoding);
    }
    // GitHubProvider.fetchIssueTitleSync: `gh issue view <N> --json title ...`.
    if (
      cmd === "gh" &&
      a[0] === "issue" &&
      a[1] === "view" &&
      a.includes("title")
    ) {
      return ok(`${fixtureIssueTitle(Number(a[2]))}\n`, !opts?.encoding);
    }
    return (passthrough as (...p: unknown[]) => unknown)(cmd, args, opts);
  }) as unknown as typeof SpawnSync);
}
