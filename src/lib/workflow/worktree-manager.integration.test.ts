import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { execFileSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { ensureWorktree } from "./worktree-manager.js";

/**
 * #1469 AC-2 / AC-4 — `git worktree add` against a real clone when another
 * process holds `.git/config.lock`.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

function makeClone(root: string): string {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "init", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", ".");
  git(
    seed,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "init",
  );
  git(seed, "push", origin, "main");
  git(root, "clone", origin, clone);
  return clone;
}

function worktreeList(clone: string): string {
  return git(clone, "worktree", "list", "--porcelain");
}

describe("ensureWorktree under a held .git/config lock", () => {
  let root: string;
  let clone: string;
  let originalCwd: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "wt-config-lock-")));
    clone = makeClone(root);
    process.chdir(clone);
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("config.lock released after the first attempt: the retry creates the worktree", async () => {
    const lock = join(clone, ".git", "config.lock");
    writeFileSync(lock, "");
    const failures = new Map<number, string>();
    const sleep = vi.fn(() => rmSync(lock, { force: true }));

    const info = await ensureWorktree(
      101,
      "lock released",
      false,
      undefined,
      undefined,
      false,
      join(root, "worktrees"),
      { failures, lockRetry: { sleep } },
    );

    expect(info).not.toBeNull();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(failures.size).toBe(0);
    expect(existsSync(join(info!.path, "README.md"))).toBe(true);
    expect(worktreeList(clone)).toContain(`branch refs/heads/${info!.branch}`);
  });

  it("config.lock never released: bounded attempts, then the failure is recorded", async () => {
    // A branch that exists only on the remote is built with `worktree add -B
    // <branch> <path> origin/<branch>` (#1405), which writes the upstream on
    // every attempt — unlike `-b`, whose retry adds the branch it already
    // created and needs no config write. So a held lock fails every attempt.
    const branch = "feature/102-lock-held";
    git(clone, "checkout", "-q", "-b", branch);
    writeFileSync(join(clone, "pr.txt"), "pr\n");
    git(clone, "add", ".");
    git(
      clone,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "pr",
    );
    git(clone, "push", "-q", "origin", branch);
    git(clone, "checkout", "-q", "main");
    git(clone, "branch", "-q", "-D", branch);
    writeFileSync(join(clone, ".git", "config.lock"), "");
    const failures = new Map<number, string>();
    const sleep = vi.fn();

    const info = await ensureWorktree(
      102,
      "lock held",
      false,
      undefined,
      undefined,
      false,
      join(root, "worktrees"),
      { failures, lockRetry: { sleep } },
    );

    expect(info).toBeNull();
    // Default budget: four waits, five attempts — then it gives up.
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(failures.get(102)).toContain("could not lock config file");
    expect(worktreeList(clone)).not.toContain(`branch refs/heads/${branch}`);
  });
});

describe("two concurrent runs in one repo", () => {
  let root: string;
  let clone: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "wt-concurrent-")));
    clone = makeClone(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("concurrent ensureWorktree calls from two processes both get their worktree", async () => {
    const barrier = join(root, "go");
    const modulePath = resolve(__dirname, "worktree-manager.ts");
    const script = join(root, "provision.mts");
    // Each child signals ready, spins until the barrier file appears, then
    // provisions — so both `git worktree add` calls start together.
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from "fs";
import { ensureWorktree } from ${JSON.stringify(modulePath)};
const issue = Number(process.argv[2]);
writeFileSync(${JSON.stringify(root)} + "/ready-" + issue, "");
while (!existsSync(${JSON.stringify(barrier)})) {}
const info = await ensureWorktree(issue, "concurrent " + issue, false, undefined, undefined, false, ${JSON.stringify(join(root, "worktrees"))});
process.exit(info ? 0 : 1);
`,
    );
    const tsx = resolve(__dirname, "../../../node_modules/.bin/tsx");
    const children = [201, 202].map((issue) => {
      const child = spawn(tsx, [script, String(issue)], {
        cwd: clone,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      return new Promise<{ code: number | null; output: string }>((done) =>
        child.on("close", (code) => done({ code, output })),
      );
    });

    const deadline = Date.now() + 20_000;
    while (
      !(
        existsSync(join(root, "ready-201")) &&
        existsSync(join(root, "ready-202"))
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    writeFileSync(barrier, "");

    const results = await Promise.all(children);
    for (const r of results) expect(r.code, r.output).toBe(0);
    const list = worktreeList(clone);
    expect(list).toContain("branch refs/heads/feature/201-concurrent-201");
    expect(list).toContain("branch refs/heads/feature/202-concurrent-202");
    // Each branch kept the upstream `worktree add -b` writes.
    const config = readFileSync(join(clone, ".git", "config"), "utf8");
    expect(config).toContain('[branch "feature/201-concurrent-201"]');
    expect(config).toContain('[branch "feature/202-concurrent-202"]');
  }, 60_000);
});
