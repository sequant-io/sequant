/**
 * Integration tests for `scripts/settle-against-base.sh` (#1093).
 *
 * Git is real here, per the graph's I-6: every case builds an actual
 * repository with `git init`, a real `origin` remote, real commits and real
 * branches. What is substituted is the *test runner* — `SETTLE_TEST_CMD`
 * points at a trivial script that decides pass/fail by reading the fixture
 * file. Nesting a real `vitest` run inside each case would push this file into
 * the orchestrator's 30-minute no-progress wall for no extra coverage: the
 * behaviour under test is the checkout/stash/restore dance around the runner,
 * not the runner itself.
 *
 * The runner lives outside the repository on purpose, so it is byte-identical
 * at base and at head and cannot itself explain a difference in results.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "settle-against-base.sh");

/** Fixture test file, relative to the repo root — the script's `<test-file>`. */
const TEST_FILE = "sample.test.ts";

let root: string;
let repo: string;
let runner: string;

/** Run a git command in the fixture repo with signing and identity pinned. */
function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=settle@example.com",
      "-c",
      "user.name=Settle Fixture",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ],
    { cwd: repo, encoding: "utf-8" },
  );
}

function commitAll(message: string): void {
  git("add", "-A");
  // `--allow-empty`: several cases deliberately give base and head the same
  // fixture body (the point being that nothing about the *diff* explains the
  // result), and git refuses an empty commit by default.
  git("commit", "-q", "--allow-empty", "-m", message);
}

interface SettleResult {
  stdout: string;
  status: number;
}

/** Invoke the script under test in the fixture repo. */
function settle(args: string[] = [TEST_FILE]): SettleResult {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...process.env,
        SETTLE_TEST_CMD: `bash ${runner}`,
        // Keep the fixture's committer identity out of the ambient config so
        // the script's own git calls cannot fail on an unconfigured machine.
        GIT_AUTHOR_NAME: "Settle Fixture",
        GIT_AUTHOR_EMAIL: "settle@example.com",
        GIT_COMMITTER_NAME: "Settle Fixture",
        GIT_COMMITTER_EMAIL: "settle@example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      status: e.status ?? 1,
    };
  }
}

/**
 * Build a repo whose fixture file says `baseBody` on `origin/main` and
 * `headBody` on the checked-out feature branch. A null `baseBody` means the
 * file does not exist at base at all.
 */
function buildRepo(baseBody: string | null, headBody: string): void {
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  if (baseBody !== null) {
    writeFileSync(join(repo, TEST_FILE), baseBody);
  }
  commitAll("base");
  git("push", "-q", "-u", "origin", "main");

  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, TEST_FILE), headBody);
  commitAll("head");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "settle-base-"));
  repo = join(root, "repo");
  mkdirSync(repo);

  // A trivial, deterministic stand-in for vitest: the fixture file's own
  // contents decide the verdict, so a case can make the same named test red at
  // one commit and green at another.
  runner = join(root, "runner.sh");
  writeFileSync(
    runner,
    [
      "#!/usr/bin/env bash",
      'file="$1"',
      'if [ ! -e "$file" ]; then echo "No test files found: $file"; exit 1; fi',
      'if grep -q FAIL "$file"; then echo "RUNNER: 1 failed - $file"; exit 1; fi',
      'echo "RUNNER: 1 passed - $file"',
      "exit 0",
      "",
    ].join("\n"),
  );

  const bare = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("remote", "add", "origin", bare);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("settle-against-base", () => {
  it("prints both base and head results when the test is red at base and green at head", () => {
    buildRepo("FAIL", "PASS");

    const { stdout, status } = settle();

    expect(status).toBe(0);
    expect(stdout).toContain("### Settled against base");
    expect(stdout).toContain("| Head |");
    expect(stdout).toContain("| Base |");
    // Both runner outputs are carried into the block, not just a verdict word.
    expect(stdout).toContain("RUNNER: 1 passed");
    expect(stdout).toContain("RUNNER: 1 failed");
    expect(stdout).toContain("Fixed by this diff");
  });

  it("prints both base and head results when the test is green at base and red at head", () => {
    buildRepo("PASS", "FAIL");

    const { stdout, status } = settle();

    expect(status).toBe(0);
    expect(stdout).toContain("### Settled against base");
    expect(stdout).toContain("RUNNER: 1 passed");
    expect(stdout).toContain("RUNNER: 1 failed");
    expect(stdout).toContain("Introduced by this diff");
    expect(stdout).not.toContain("Pre-existing —");
  });

  it("reports a genuinely pre-existing failure as pre-existing", () => {
    buildRepo("FAIL", "FAIL other");

    const { stdout } = settle();

    expect(stdout).toContain("Pre-existing —");
    expect(stdout).toContain("do not describe it as");
  });

  it("distinguishes a test file absent at base from a failure at base", () => {
    buildRepo(null, "FAIL");

    const { stdout } = settle();

    expect(stdout).toContain("ABSENT AT BASE");
    expect(stdout).toContain("Not pre-existing");
    // The runner's "no test files found" error must not be laundered into a
    // base failure — that is the fake claim this script exists to prevent.
    expect(stdout).not.toContain("Pre-existing —");
  });

  it("preserves uncommitted changes", () => {
    buildRepo("PASS", "PASS");

    const dirtyPath = join(repo, "README.md");
    const dirtyBody = "# fixture\nuncommitted edit, must survive\n";
    writeFileSync(dirtyPath, dirtyBody);
    const untrackedPath = join(repo, "scratch-notes.txt");
    const untrackedBody = "untracked, must survive\n";
    writeFileSync(untrackedPath, untrackedBody);

    const { status } = settle();

    expect(status).toBe(0);
    expect(readFileSync(dirtyPath, "utf-8")).toBe(dirtyBody);
    expect(readFileSync(untrackedPath, "utf-8")).toBe(untrackedBody);
    // Back on the original branch, not left detached at base.
    expect(git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature");
    // And nothing of ours left on the shared stash stack.
    expect(git("stash", "list")).not.toContain("settle-against-base-");
  });

  it("refuses to run on a detached HEAD instead of guessing", () => {
    buildRepo("PASS", "PASS");
    git("checkout", "-q", "--detach", "HEAD");

    const { stdout, status } = settle();

    expect(status).toBe(3);
    expect(stdout).toContain("HEAD is detached");
  });

  it("passes -t through to the runner and names it in the block", () => {
    buildRepo("PASS", "PASS");

    const { stdout, status } = settle([TEST_FILE, "-t", "some case"]);

    expect(status).toBe(0);
    expect(stdout).toContain("-t some case");
  });
});
