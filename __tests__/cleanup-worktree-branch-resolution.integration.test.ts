// Tests for Issue #838 — cleanup-worktree.sh must act on the RESOLVED branch
// ref, not the raw argument the caller typed.
//
// The worktree lookup matches by SUBSTRING (`index($0, target) > 0`), so `817`
// and `feature/817-*` both legitimately resolve to a worktree. But three
// downstream consumers need an EXACT ref:
//
//   1. `gh pr list --head`      — exact filter; a shorthand yields no PR, so
//                                 PR_STATUS is empty and the script reports
//                                 "PR not merged" for a merged PR.
//   2. `git branch -D`          — `|| true`-suppressed, so it failed silently
//   3. `git push origin --delete`  and left the branch behind while the script
//                                 printed "Cleanup complete!".
//
// (1) is the loud symptom; (2)/(3) are the silent ones — observed live during
// #817's post-merge cleanup, which reported success yet left the local branch
// needing a manual `git branch -D`.
//
// These run the real script against a real throwaway git repo with a real
// worktree, with `gh` stubbed on PATH so the merge state is controlled and no
// network call happens. Every assertion is parametrized over the three input
// forms so a fix that only handles one of them fails here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCRIPT = join(REPO_ROOT, "templates", "scripts", "cleanup-worktree.sh");

const BRANCH = "feature/838-cleanup-branch-resolution";

/** The three ways a caller names this branch. All must behave identically. */
const INPUT_FORMS: Array<[label: string, arg: string]> = [
  ["issue-number shorthand", "838"],
  ["glob form (as skills/docs prescribe)", "feature/838-*"],
  ["full literal branch name", BRANCH],
];

let sandbox: string;
let repo: string;
let wt: string;
let binDir: string;
let origin: string;

function git(args: string[], cwd = repo): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
}

/**
 * Write a fake `gh` onto PATH. `state` is echoed for the
 * `pr list --head <ref> --state merged --jq '.[0].state'` call, but ONLY when
 * the ref it receives is the exact branch — mirroring real `--head` semantics,
 * which is the whole point under test. It also records the ref it was handed
 * so a test can assert what the script actually passed.
 */
function stubGh(merged: boolean): void {
  const script = `#!/bin/bash
# Record every invocation for assertions.
echo "$@" >> "${join(binDir, "gh-calls.log")}"
# Emulate: --head is an EXACT match filter.
head_ref=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--head" ]; then head_ref="$a"; fi
  prev="$a"
done
if [ "$head_ref" = "${BRANCH}" ] && [ "${merged ? "1" : "0"}" = "1" ]; then
  echo "MERGED"
fi
exit 0
`;
  const p = join(binDir, "gh");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

function runCleanup(arg: string, extraArgs: string[] = []) {
  return spawnSync("bash", [SCRIPT, ...extraArgs, arg], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      // No TTY under vitest, so the script's non-interactive branch is live —
      // exactly the automation path that matters.
    },
  });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "cleanup-wt-838-"));
  repo = join(sandbox, "repo");
  wt = join(sandbox, "wt-838");
  binDir = join(sandbox, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // A real bare `origin` so the script's remote-delete and its trailing
  // "update main" (checkout/fetch/ff) behave as they do in a real repo. Without
  // a remote the script errors out before its final line and the teardown
  // assertions below can't distinguish "worked" from "died early".
  origin = join(sandbox, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  // Contributors with a global `commit.gpgsign=true` have no pinentry in a
  // test run, so every commit below would die with "gpg: signing failed".
  // CI has no signing key and never noticed. Same line the other fixtures use.
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["remote", "add", "origin", origin]);
  git(["push", "-q", "-u", "origin", "main"]);
  git(["worktree", "add", "-q", "-b", BRANCH, wt]);
  git(["push", "-q", "origin", BRANCH]);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("cleanup-worktree.sh branch resolution (#838)", () => {
  describe.each(INPUT_FORMS)("input form: %s", (_label, arg) => {
    it("recognizes a MERGED PR — no warning, no --yes required", () => {
      stubGh(true);
      const r = runCleanup(arg);

      // The regression: this warning fired for every form but the literal one.
      expect(r.stdout).not.toContain("PR for this branch is not merged");
      expect(r.stdout).not.toContain(
        "Non-interactive context and PR not merged",
      );
      expect(r.stdout).toContain("Cleanup complete");
    });

    it("passes the resolved ref to gh, never the raw argument", () => {
      stubGh(true);
      runCleanup(arg);

      const calls = spawnSync("cat", [join(binDir, "gh-calls.log")], {
        encoding: "utf8",
      }).stdout;
      expect(calls).toContain(`--head ${BRANCH}`);
      if (arg !== BRANCH) {
        expect(calls).not.toContain(`--head ${arg}`);
      }
    });

    it("actually deletes the local branch", () => {
      stubGh(true);
      runCleanup(arg);

      // `git branch -D` is `|| true`-suppressed, so a shorthand failure was
      // invisible: "Cleanup complete!" printed while the branch survived.
      const branches = spawnSync("git", ["branch", "--list", BRANCH], {
        cwd: repo,
        encoding: "utf8",
      }).stdout.trim();
      expect(branches).toBe("");
    });

    it("actually deletes the remote branch on a MERGED PR", () => {
      stubGh(true);
      runCleanup(arg);

      // The third consumer of the resolved ref (alongside `gh pr list --head`
      // and `git branch -D`) is `git push origin --delete`, and it is the one
      // this file never asserted. That line is `2>/dev/null || true`, so a
      // regression reintroducing the RAW argument there deletes nothing and
      // still prints "Cleanup complete!" at exit 0 — the exact silent-failure
      // class #838 exists to close.
      const remote = spawnSync(
        "git",
        ["ls-remote", "--heads", "origin", BRANCH],
        { cwd: repo, encoding: "utf8" },
      ).stdout.trim();
      expect(remote).toBe("");
    });

    it("still refuses an UNMERGED PR non-interactively (#750 preserved)", () => {
      stubGh(false);
      const r = runCleanup(arg);

      expect(r.stdout).toContain("PR for this branch is not merged");
      expect(r.stdout).toContain("Exiting without changes");
      // The worktree must survive — this is #750's protection.
      const wtList = spawnSync("git", ["worktree", "list"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout;
      expect(wtList).toContain(wt);
    });

    it("still tears down an UNMERGED PR when --yes is passed (#750 preserved)", () => {
      stubGh(false);
      const r = runCleanup(arg, ["--yes"]);

      expect(r.stdout).toContain("PR for this branch is not merged");
      expect(r.stdout).toContain("Proceeding (--yes/--force)");
      // Remote delete must STILL be skipped — the #750 hard gate.
      expect(r.stdout).toContain("Skipped remote-branch delete");
    });
  });

  it("resolves correctly when the worktree path contains spaces (#575)", () => {
    // The two-line awk emission exists so this case survives; a space-joined
    // single line would split the path here.
    const spaced = join(sandbox, "work tree with spaces");
    const branch2 = "feature/838-spaced";
    git(["worktree", "add", "-q", "-b", branch2, spaced]);
    stubGh(true);

    const r = spawnSync("bash", [SCRIPT, "838-spaced"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(r.stdout).toContain(spaced);
    expect(r.stdout).not.toContain("Worktree not found");
  });
});

// Tests for Issue #844 — the branch resolver was an UNANCHORED substring match
// with first-match-wins and no ambiguity check, so `838` matched
// `feature/1838-other-work` and deleted the wrong branch (local AND remote,
// since #838). The fix anchors bare numbers to the issue-number position and
// makes any 2+-way match fatal. Each documented input form (bare number, glob,
// full name) gets a multi-match fixture here (AC-4).
//
// The module-level beforeEach already provisions `feature/838-cleanup-branch-
// resolution`; these tests add their own worktrees on non-conflicting issue
// numbers so that seed branch never perturbs the assertions.
describe("cleanup-worktree.sh anchored resolution + ambiguity (#844)", () => {
  /** Add a linked worktree on a fresh branch; returns its path. */
  function addWorktree(branch: string, dirName: string): string {
    const p = join(sandbox, dirName);
    git(["worktree", "add", "-q", "-b", branch, p]);
    return p;
  }

  /** Branches that currently exist locally (trimmed, decorators stripped). */
  function localBranches(): string[] {
    return spawnSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: repo,
      encoding: "utf8",
    })
      .stdout.split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
  }

  it("AC-1: a bare number anchors — `900` resolves feature/900-fix, never feature/1900-other", () => {
    addWorktree("feature/900-fix", "wt-900");
    addWorktree("feature/1900-other", "wt-1900");
    stubGh(false); // not merged → resolver runs, then exits before any teardown

    const r = spawnSync("bash", [SCRIPT, "900"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    // Resolved the anchored branch, and the 1838-style decoy was never even a
    // candidate (no ambiguity error, no wrong-branch resolution).
    expect(r.stdout).toContain("feature/900-fix");
    expect(r.stdout).not.toContain("feature/1900-other");
    expect(r.stdout + r.stderr).not.toContain("ambiguous");
    // Nothing torn down (unmerged, non-interactive → safe exit).
    expect(localBranches()).toContain("feature/1900-other");
  });

  it("AC-2/AC-4 (bare number): `901` matching two branches exits non-zero and lists both", () => {
    addWorktree("feature/901-alpha", "wt-901a");
    addWorktree("feature/901-beta", "wt-901b");
    stubGh(true); // even a MERGED PR must not rescue an ambiguous match

    const r = spawnSync("bash", [SCRIPT, "901"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    const out = r.stdout + r.stderr;
    expect(r.status).not.toBe(0);
    expect(out).toContain("ambiguous");
    expect(out).toContain("feature/901-alpha");
    expect(out).toContain("feature/901-beta");
    // First-match-wins is exactly what we refuse: neither branch is deleted.
    const branches = localBranches();
    expect(branches).toContain("feature/901-alpha");
    expect(branches).toContain("feature/901-beta");
  });

  it("AC-3/AC-4 (glob): over-broad `feature/*` matching multiple branches is rejected", () => {
    addWorktree("feature/902-alpha", "wt-902");
    addWorktree("feature/903-beta", "wt-903");
    stubGh(true);

    const r = spawnSync("bash", [SCRIPT, "feature/*"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    const out = r.stdout + r.stderr;
    expect(r.status).not.toBe(0);
    expect(out).toContain("ambiguous");
    // The seed 838 branch plus both new ones are all candidates; none deleted.
    const branches = localBranches();
    expect(branches).toContain("feature/902-alpha");
    expect(branches).toContain("feature/903-beta");
    expect(branches).toContain(BRANCH);
  });

  it("AC-3: a glob matching exactly one branch still resolves normally", () => {
    addWorktree("feature/902-alpha", "wt-902");
    addWorktree("feature/903-beta", "wt-903");
    stubGh(false); // resolves uniquely, then exits (unmerged, non-interactive)

    const r = spawnSync("bash", [SCRIPT, "feature/902-*"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(r.stdout + r.stderr).not.toContain("ambiguous");
    expect(r.stdout).not.toContain("Worktree not found");
    expect(r.stdout).toContain("feature/902-alpha");
  });

  it("AC-4 (full name): exact tier wins — coexisting feature/838-fix{,-more} is not ambiguous", () => {
    // Both are legal simultaneously (new-feature.sh truncates the title slug),
    // so typing the full name must resolve to exactly it, not trip the check.
    addWorktree("feature/838-fix", "wt-838fix");
    addWorktree("feature/838-fix-more", "wt-838fixmore");
    stubGh(false);

    const r = spawnSync("bash", [SCRIPT, "feature/838-fix"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(r.stdout + r.stderr).not.toContain("ambiguous");
    expect(r.stdout).toContain("feature/838-fix");
    // The superstring branch survives — it was never a match.
    expect(localBranches()).toContain("feature/838-fix-more");
  });
});
