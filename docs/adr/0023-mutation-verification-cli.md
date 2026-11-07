# ADR-0023: Mutation verification is a CLI that certifies the named test's own result, with vitest behind an injected runner

**Status:** Proposed
**Date:** 2026-10-26
**Issue:** #1604

## Context

A gate test ships with a recorded mutation result: delete the thing the test asserts, confirm that exactly that test fails, restore, and record the result as a `SEQUANT_MUTATION` marker in the PR body. `/qa` §6i parses the marker. Done by hand, the restore wiped uncommitted work five times (#817, #906, #939, #1044, #1050), and nothing proved that the cited test ran: §6i checks only that the named file is in the diff.

The graph-2026-10-ergonomics design (§4, D-2.1 to D-2.5) makes the procedure a CLI: `sequant mutation begin` refuses a dirty tree; `check` captures the mutation as a patch, runs the test, restores with `git apply -R --index`, runs it again and records the result; `render` prints the markers from the record. The PR body stays the channel QA reads (ADR-0004, #1316).

Two choices were left open by the design:

1. D-2.3 step 4 says the run under the mutation "exits non-zero". A mutation that deletes the test file, or breaks an import the file needs, also makes vitest exit non-zero, but the named test never ran. With exit codes alone, such a mutation would certify a test that proved nothing.
2. How `check` runs vitest so that its own tests stay inside the unit project's 5-second limit and do not run vitest inside vitest.

## Decision

`check` reads vitest's JSON report and requires the named test's own result: `failed` under the mutation and `passed` after the restore, in addition to the exit codes D-2.3 names. This makes D-2.3 stricter, not looser.

vitest is behind a `VitestRunner` interface (`list`, `run`). The default implementation runs `npx vitest list --no-static-parse --json=<tmp>` and `npx vitest run --reporter=json --outputFile=<tmp>`. Tests inject a fake runner whose verdict reads the tree on disk, while git runs for real in a temporary repository.

Two smaller choices made while implementing D-2.3:

- Once the patch is captured, `check` restores the tree before it returns, whatever the run found. D-2.3 says to abort at the first failure. A tree left in the mutated state after a refusal is the state from which an agent commits the mutation by mistake, so the restore comes first and then the refusal.
- `--name` is escaped and anchored at its end (`<escaped>$`) before it goes to `-t`. Without the anchor, a test name that is a prefix of another (`fails` and `fails in --json mode`) can never resolve to one test.

## Options

### Option A: Exit code only (D-2.3 as written)

**Pros:** no report parsing; matches the design text. **Cons:** a mutation that stops the test file from loading certifies the test.

### Option B: Exit code and the named test's own state (chosen)

**Pros:** a record means the named test ran and failed, then ran and passed. **Cons:** depends on the shape of vitest's JSON reporter (`ancestorTitles`, `title`, `status`), which a major vitest release could change.

### Option C: Run real vitest in `check`'s own tests

**Pros:** no seam. **Cons:** each case would spend tens of seconds in nested vitest runs and the repo's global setup, far beyond the unit project's 5-second limit. The git procedure, which is where work is lost, would be tested no better.

## Trade-offs

Option B costs one JSON parse per run and a dependency on the JSON reporter's shape. In exchange, a record cannot come from a run in which the test never executed. That is the guarantee the receipt exists to give. The runner seam keeps the git steps under test against a real repository, which is where the risk is.

## Consequences

- A mutation that removes the whole test file, or breaks its import, is refused with "did not run under the mutation". The agent must change the code the test asserts, not the test's ability to load.
- A vitest upgrade that changes the JSON reporter shows as every `check` refusing with state `missing`. The default runner is the one place to fix.
- Hand-typed markers in exec output still reach the PR body until the skills change (#1606). Until then, the receipt is one of two marker producers, and `buildAutomatedPRBody` dedupes the two by `(ac, mutation, failedTest)`.
