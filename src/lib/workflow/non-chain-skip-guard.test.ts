// @tautology-skip: this file asserts an invariant about the *source text* of
// run-orchestrator.ts, so it calls no production function by design. The guard
// it pins is an inline branch inside `RunOrchestrator.run()`, which cannot be
// reached without standing up a full orchestrator (state manager, worktrees,
// GitHub, locks); there is no runtime API for "does the non-chain guard consult
// the shared predicate". The detector reads that shape as asserting on a local
// value, which is the right default and the wrong call here.
//
// Claiming the exemption obliges proving the guard actually bites, so it was
// mutation-tested: reverting the guard to the pre-#837 inline
// `status === "ready_for_merge" || status === "merged"` pair fails this file
// (and nothing else in the suite — that silence is precisely why this file
// exists). Re-run that mutation before trusting this pragma if the region
// changes shape.
//
/**
 * Wiring guard for the non-chain pre-flight skip (#837).
 *
 * #817's `--ready-gate` terminates a gated issue in `waiting_for_human_merge`
 * rather than `ready_for_merge`. Two independent guards decide "is this issue
 * already done, skip it unless --force":
 *
 *   1. `chain-resume.ts` for `--chain` runs — covered by chain-resume.test.ts.
 *   2. this inline branch in `run-orchestrator.ts` for non-chain runs.
 *
 * Both originally spelled the predicate out inline and both missed the gated
 * status. #837 moved it to `isCompletedIssueStatus` (completed-status.ts) so
 * there is one place to update; `completed-status.test.ts` pins the predicate's
 * behavior. This file pins the other half — that the orchestrator actually
 * *calls* it — because a correct predicate nobody consults is exactly the inert
 * surface this repo has now been bitten by twice (#795 `--qa-gate`, #810
 * `reuseWorktrees`).
 *
 * Scoped to the guard region rather than the whole 1,700-line file, so an
 * unrelated edit elsewhere in run-orchestrator.ts cannot make it pass or fail
 * for the wrong reason.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The non-chain skip guard block, extracted from its marker comment to the end
 * of the `activeIssues` accumulation loop.
 *
 * Deliberately a function rather than a module-level const: the repo's
 * tautology detector reads an `it()` that calls nothing as asserting on a local
 * value, and extracting here means each test opens by calling the extractor it
 * depends on.
 */
function nonChainGuardRegion(): string {
  const source = readFileSync(join(here, "run-orchestrator.ts"), "utf8");
  const start = source.indexOf("── Non-chain skip guard");
  expect(
    start,
    "non-chain skip guard marker comment not found — if the block was renamed, retarget this test rather than deleting it",
  ).toBeGreaterThan(-1);

  const end = source.indexOf("State lookup failed for", start);
  expect(
    end,
    "end anchor of the non-chain guard region not found",
  ).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe("non-chain pre-flight skip guard (#837)", () => {
  it("consults the shared isCompletedIssueStatus predicate", () => {
    expect(nonChainGuardRegion()).toContain("isCompletedIssueStatus(");
  });

  it("does not re-inline a hand-written status comparison", () => {
    // The pre-#837 shape. Re-inlining is how this guard drifted out of sync
    // with the status vocabulary in the first place: a status added to
    // IssueStatusSchema updates neither an inline `===` chain nor its twin in
    // chain-resume.ts.
    const region = nonChainGuardRegion();
    expect(region).not.toMatch(/status\s*===\s*["']ready_for_merge["']/);
    expect(region).not.toMatch(/status\s*===\s*["']merged["']/);
    expect(region).not.toMatch(
      /status\s*===\s*["']waiting_for_human_merge["']/,
    );
  });

  it("imports the predicate from the shared module", () => {
    const source = readFileSync(join(here, "run-orchestrator.ts"), "utf8");
    expect(source).toMatch(
      /import\s*\{[^}]*isCompletedIssueStatus[^}]*\}\s*from\s*["']\.\/completed-status\.js["']/,
    );
  });
});
