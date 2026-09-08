# 05 — #933 fix(run): run the skills preflight against each provisioned worktree

**Epic:** M0   **Blocked by:** —   **Tier:** mechanical   **Doc:** PLAN §8 (orchestrator region: preflight call), §9 OQ-11, Lab §1

## Why
`run-orchestrator.ts:1097` calls `runSkillsPreflight` without `cwd`; the check
runs against the main checkout, the one place skills are guaranteed. Worktrees
materialize only tracked files. The ad-motion incident is the motivating example.

## Scope
- may touch: `src/lib/workflow/run-orchestrator.ts` (move the preflight call to after worktree provisioning, i.e. after the block ending ~:1181; pass each worktree path as `cwd`), `src/lib/workflow/skills-preflight.ts`, `src/lib/workflow/skills-preflight.test.ts`, one run-orchestrator test file
- not in scope: `skills-check.ts` semantics; the cleanup registration block (node 09); `--dry-run` behavior.

## Acceptance criteria
- [ ] AC-1: untracked `.claude/skills/` fails fast before any phase spawns, naming the worktree path and the fix — Verify: `npx vitest run src/lib/workflow/skills-preflight.test.ts -t "933"` → passes; the orchestrator-level case uses a temp git repo with `.claude/skills` present but untracked, a real `git worktree add`, and asserts (a) the phase runner mock was never called, (b) the error text contains the worktree path and the phrase `commit .claude/skills`.
- [ ] AC-2: committed skills pass and the preflight was invoked with `cwd` = each worktree path — Verify: same test, second case asserts the `cwd` argument observed by the preflight equals the provisioned worktree path, not `process.cwd()`.
- [ ] AC-3: `--dry-run` and non-skill drivers unchanged — Verify: same test, cases assert no preflight call under `dryRun: true` and under `agent: "aider"`.
- [ ] AC-4: the pre-provisioning call is gone (OQ-11: post-provisioning only) — Verify: `grep -c 'runSkillsPreflight(' src/lib/workflow/run-orchestrator.ts` → `1`, and that call sits after the worktree-provisioning block (`grep -n 'runSkillsPreflight(\|Cleanup worktree for' src/lib/workflow/run-orchestrator.ts` → the preflight line number is greater).

## Done when
A run whose worktrees lack skills stops before the first phase with the commit guidance, and a run whose worktrees have skills proceeds with the check having looked at the worktrees themselves.
