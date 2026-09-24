// `fixture_commit` checks for recorded `claude plugin eval` results under
// `evals/results/` (#993 AC-4). Gated by `__tests__/evals-fixture-commit.test.ts`.
//
// Ancestry is three-valued because a shallow clone cannot answer "no": `git
// merge-base --is-ancestor` does not walk past the shallow boundary, so a real
// ancestor and a bogus commit look the same there. Object presence is not a
// substitute — fetching other branches pulls fixture commits into a shallow
// clone's object database while HEAD's history is still cut above them (#1140).

import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type Ancestry = "ancestor" | "not-ancestor" | "unevaluable";

function git(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd, encoding: "utf-8" });
}

/** True iff `sha` is present in the clone's object database as a commit. */
export function commitObjectPresent(sha: string, cwd = process.cwd()): boolean {
  return git(["cat-file", "-e", `${sha}^{commit}`], cwd).status === 0;
}

export function isShallowRepository(cwd = process.cwd()): boolean {
  return (
    git(["rev-parse", "--is-shallow-repository"], cwd).stdout.trim() === "true"
  );
}

/**
 * Whether `sha` is an ancestor of HEAD. A negative answer in a shallow clone is
 * `unevaluable`, whether or not the object is present.
 */
export function fixtureCommitAncestry(
  sha: string,
  cwd = process.cwd(),
): Ancestry {
  if (git(["merge-base", "--is-ancestor", sha, "HEAD"], cwd).status === 0) {
    return "ancestor";
  }
  if (isShallowRepository(cwd)) return "unevaluable";
  return "not-ancestor";
}

export function listResultFiles(resultsDir: string): string[] {
  return readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
}

export function readFixtureCommit(resultsDir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(resultsDir, file), "utf-8"))
    .fixture_commit;
}
