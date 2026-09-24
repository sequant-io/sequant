// Gate test for #993 AC-4 — every recorded `claude plugin eval` result under
// `evals/results/` must carry a `fixture_commit`, and that commit must be an
// ancestor of HEAD. Without this, a result can be credited forever to a
// fixture version that has since been edited or deleted (the #830 failure
// class this issue's cases exist to catch).
//
// Shallow-clone handling (#993 QA finding, #1140): the CI `build` job checks
// out with the default `fetch-depth: 1` (see .github/workflows/ci.yml — only
// the job at the bottom sets `fetch-depth: 0`), and claude.ai cloud sessions
// clone 51 commits deep. In a shallow clone `git merge-base --is-ancestor`
// cannot walk past the shallow boundary, so it fails for a *valid* commit
// exactly as it does for a bogus one. The first guard keyed this on object
// presence, which is not the same thing: fetching other branches pulls the
// fixture commits into the object database while HEAD's history is still cut
// above them (#1140 — present, yet not reachable). The ancestry assertion is
// therefore guarded on `--is-shallow-repository`: a non-ancestor result is
// unevaluable in a shallow clone and a failure in a full one. Presence and
// well-formedness of `fixture_commit` are still asserted everywhere.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESULTS_DIR = join(process.cwd(), "evals", "results");

type Ancestry = "ancestor" | "not-ancestor" | "unevaluable";

function git(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd, encoding: "utf-8" });
}

/** True iff `sha` is present in this clone's object database as a commit. */
function commitObjectPresent(sha: string, cwd = process.cwd()): boolean {
  return git(["cat-file", "-e", `${sha}^{commit}`], cwd).status === 0;
}

function isShallow(cwd: string): boolean {
  return (
    git(["rev-parse", "--is-shallow-repository"], cwd).stdout.trim() === "true"
  );
}

function ancestry(sha: string, cwd = process.cwd()): Ancestry {
  if (git(["merge-base", "--is-ancestor", sha, "HEAD"], cwd).status === 0) {
    return "ancestor";
  }
  // Keyed on shallowness, not presence: a present commit can still sit
  // beyond HEAD's shallow boundary (#1140).
  if (isShallow(cwd)) return "unevaluable";
  return "not-ancestor";
}

function listResultFiles(): string[] {
  return readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
}

function readFixtureCommit(file: string): unknown {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf-8"))
    .fixture_commit;
}

describe("evals/results fixture_commit gate (#993 AC-4)", () => {
  const files = listResultFiles();

  it("finds at least one recorded eval result", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Asserted unconditionally — needs no git history.
  it.each(files)("%s carries a well-formed fixture_commit", (file) => {
    const sha = readFixtureCommit(file);
    expect(typeof sha).toBe("string");
    expect(sha as string).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(files)(
    "%s's fixture_commit is an ancestor of HEAD (where history allows)",
    (file) => {
      const verdict = ancestry(readFixtureCommit(file) as string);
      // Shallow clone: unevaluable rather than false. Enforcement still runs
      // in any full-history clone.
      if (verdict === "unevaluable") return;
      expect(verdict).toBe("ancestor");
    },
  );
});

// Hermetic fixtures for the guard itself, independent of how deep the host
// checkout is. `origin` (full history) has main: F -> G -> M1 -> M2 and a
// branch `side` forked from F. `shallow` is a depth-1 clone of main that then
// fetched `side` — the #1140 shape: F is present, G is absent, and neither is
// reachable from the shallow HEAD although both are real ancestors.
describe("fixture_commit ancestry guard (#1140)", () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  let root: string;
  let origin: string;
  let shallow: string;
  const sha: Record<"F" | "G" | "orphan", string> = {
    F: "",
    G: "",
    orphan: "",
  };

  function run(args: string[], cwd: string): string {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf-8",
      env: GIT_ENV,
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }

  const commit = (msg: string) => {
    run(["commit", "-q", "--allow-empty", "-m", msg], origin);
    return run(["rev-parse", "HEAD"], origin);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sequant-1140-"));
    origin = join(root, "origin");
    shallow = join(root, "shallow");
    run(["init", "-q", "-b", "main", origin], root);
    sha.F = commit("F");
    run(["branch", "side"], origin);
    sha.G = commit("G");
    commit("M1");
    commit("M2");
    run(["checkout", "-q", "side"], origin);
    commit("S1");
    run(["checkout", "-q", "main"], origin);
    const tree = run(["hash-object", "-t", "tree", "/dev/null"], origin);
    sha.orphan = run(["commit-tree", tree, "-m", "orphan"], origin);

    run(
      [
        "clone",
        "-q",
        "--depth",
        "1",
        "--branch",
        "main",
        `file://${origin}`,
        shallow,
      ],
      root,
    );
    run(
      ["fetch", "-q", "origin", "+refs/heads/side:refs/remotes/origin/side"],
      shallow,
    );
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a present commit that is not an ancestor of HEAD in a full clone", () => {
    // Negative control: the orphan is a real commit object never linked into
    // HEAD's history, so it is present and genuinely not an ancestor.
    expect(commitObjectPresent(sha.orphan, origin)).toBe(true);
    expect(ancestry(sha.orphan, origin)).toBe("not-ancestor");
    expect(ancestry(sha.F, origin)).toBe("ancestor");
  });

  it("treats a present commit beyond the shallow boundary as unevaluable", () => {
    expect(isShallow(shallow)).toBe(true);
    expect(commitObjectPresent(sha.F, shallow)).toBe(true);
    expect(ancestry(sha.F, shallow)).toBe("unevaluable");
  });

  it("treats an absent commit in a shallow clone as unevaluable", () => {
    expect(commitObjectPresent(sha.G, shallow)).toBe(false);
    expect(ancestry(sha.G, shallow)).toBe("unevaluable");
  });
});
