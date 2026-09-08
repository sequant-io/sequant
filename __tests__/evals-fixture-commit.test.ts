// Gate test for #993 AC-4 — every recorded `claude plugin eval` result under
// `evals/results/` must carry a `fixture_commit`, and that commit must be an
// ancestor of HEAD. Without this, a result can be credited forever to a
// fixture version that has since been edited or deleted (the #830 failure
// class this issue's cases exist to catch).
//
// Shallow-clone handling (#993 QA finding): the CI `build` job checks out with
// the default `fetch-depth: 1` (see .github/workflows/ci.yml — only the job at
// the bottom sets `fetch-depth: 0`, with a comment explaining that the default
// "checks out only the PR merge commit with no parent links"). In such a
// clone the fixture commits are not in the object database at all, and
// `git merge-base --is-ancestor` fails for a *valid* commit exactly as it does
// for a bogus one — the two are information-theoretically indistinguishable
// without the objects. Asserting unconditionally therefore turned CI red on a
// correct tree. The ancestry assertion is now guarded on object presence:
// enforced wherever history exists (local dev, and any full-history job), and
// reported as skipped where it cannot be evaluated. Presence and
// well-formedness of `fixture_commit` are still asserted everywhere.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const RESULTS_DIR = join(process.cwd(), "evals", "results");

/** True iff `sha` is present in this clone's object database as a commit. */
function commitObjectPresent(sha: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      encoding: "utf-8",
    }).status === 0
  );
}

function isAncestor(sha: string): boolean {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      encoding: "utf-8",
    }).status === 0
  );
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
      const sha = readFixtureCommit(file) as string;

      if (!commitObjectPresent(sha)) {
        // Shallow clone: the object is absent, so ancestry is unevaluable
        // rather than false. Do not assert — a shallow CI checkout would
        // otherwise fail a correct tree. Enforcement still runs anywhere the
        // history is present.
        expect(
          spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
            encoding: "utf-8",
          }).stdout.trim(),
        ).toBe("true");
        return;
      }

      expect(isAncestor(sha)).toBe(true);
    },
  );

  it("rejects a fixture_commit that is not an ancestor of HEAD", () => {
    // Negative control. `orphanSha` is a real, well-formed commit object
    // created in this repo but never linked into HEAD's history — so it is
    // *present* (defeating the shallow-clone guard above) and genuinely not
    // an ancestor. That is a strictly stronger control than an all-zeros SHA,
    // which only exercises the object-missing path.
    const tree = spawnSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
      encoding: "utf-8",
    }).stdout.trim();
    const orphanSha = spawnSync(
      "git",
      ["commit-tree", tree, "-m", "orphan commit for #993 AC-4 negative control"],
      { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } },
    ).stdout.trim();

    expect(orphanSha).toMatch(/^[0-9a-f]{40}$/);
    expect(commitObjectPresent(orphanSha)).toBe(true); // present...
    expect(isAncestor(orphanSha)).toBe(false); // ...but not an ancestor
  });
});
