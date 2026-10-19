**Tier:** judgment (needs an owner decision)   **Found:** 2026-09-30, verifying #1233 (PR #1239); tracker #1236 (closed). **Restated the same day:** the root-cause investigation showed that gating in batch-executor isn't the controlling lever while the exec skill opens PRs itself. That's #1247, which this is blocked by.

- **Blocked by**: #1247

**Observation.** A `sequant run` in which no qa ran (`--phases exec`, MCP `phases: "spec,exec"`, whose description suggests exactly that "to skip QA" at `src/mcp/tools/run.ts:606-613`, a spec recommendation without qa, or `--resume` past a completed qa) still ends with a PR. Since #1233 such a run records the issue as `in_progress`, but nothing on the PR says it skipped review.

**Why it's blocked.** Today the exec skill opens the PR itself (`gh pr create`, even under the orchestrator), and `createPR` returns an existing PR untouched. So any policy set in batch-executor's gate (`batch-executor.ts:2334`) only covers runs where exec happened not to open a PR. #1247 makes the orchestrator the only producer and lets `createPR` update an existing PR's body. After that, this becomes a pure policy choice with one place to enforce it.

**Decision (owner, 2026-10-04): option A, a "QA has not run" note. No draft PRs, and the gate isn't changed.**

**Re-rooted after #1247.** The orchestrator is now the only PR producer. It opens the PR after each successful exec pass, so QA can read the PR body, and updates it after QA with the verdict note (`openOrUpdatePR` in `batch-executor.ts`). So every PR is unreviewed between exec and QA. The real gap is that a PR whose run never reaches QA looks the same as a reviewed one. That happens with `--phases exec`, MCP `phases: "spec,exec"`, a spec recommendation that drops qa, a crash or timeout before qa, or a resume. Local base rate: 1 PR without QA in 61 exec runs (#1198, a deliberate exec-only run later reviewed by a qa-only run on the same PR).

Why not the other options: a draft-until-QA PR needs a new mark-ready verb and a verdict→ready rule, for a guard the owner already gives by approving every merge. "Require qa before a PR" is impossible after #1247, because QA reads the PR body.

**AC**
- [ ] AC-1: When `buildAutomatedPRBody` builds a body for a run where QA has not run, the body carries one line saying QA has not run and naming the phases that did (for example `> **QA has not run** — phases run: spec, exec. ...`). "QA has run" means QA reviewed the latest exec. In this run, that is a qa result after the run's last exec result, so a quality-loop iteration's after-exec update shows the line. A qa completed by an earlier run (issue state) counts only when this run ran no exec (`--resume` past qa); an exec re-run shows the line. (Amended 2026-10-04 per spec Open Question 1.) Evidence: `npx vitest run src/lib/workflow/worktree-manager.build-pr-body.test.ts src/lib/workflow/batch-executor.test.ts`
- [ ] AC-2: The update after QA replaces that line. The body never carries both the not-run line and a verdict note. A READY_FOR_MERGE verdict, which has no verdict note, also removes the line. A later qa-only run on the same PR (the #1198 pattern) removes it as well. Evidence: `npx vitest run src/lib/workflow/batch-executor.test.ts`, asserting the body passed to `createPR` on the after-exec call and on the post-QA call
- [ ] AC-3: A run where qa ran leaves the body as today apart from the line's absence, and the PR is never opened as a draft. Evidence: `npx vitest run src/lib/workflow/batch-executor.test.ts src/lib/workflow/worktree-manager.build-pr-body.test.ts`
- [ ] AC-4: The MCP `sequant_run` `phases` description no longer offers `'spec,exec'` as a plain way to "skip QA". It says a run without qa opens a PR marked as not reviewed. Evidence: `npx vitest run src/mcp/tools/run.test.ts`

## Non-Goals
- Draft PRs, a mark-ready step, or changing the PR-creation gate.
- Fixing spec's phase-recommendation parsing (separate: it can drop qa silently).
- #1297 (exec summary missing from the body). It touches `buildAutomatedPRBody` too, so run it sequentially, not in parallel.

## Graph metadata

- **Blocked by**: #1247
- It touches the same `batch-executor.ts` region as #1245, so don't run the two in parallel.

## May touch

- `src/lib/workflow/batch-executor.ts`, `src/lib/workflow/batch-executor.test.ts`
- `src/lib/workflow/worktree-manager.ts` (`createPR` / `buildAutomatedPRBody`), `src/lib/workflow/worktree-manager.build-pr-body.test.ts`
- `src/lib/workflow/platforms/github.ts` (only if draft creation needs a flag)
- `src/mcp/tools/run.ts`, `src/mcp/tools/run.test.ts`



