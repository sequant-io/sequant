# 03 — #956 fix(qa): tautology detector recognizes `__dirname`- and segment-built spawn paths

**Epic:** M0   **Blocked by:** —   **Tier:** judgment   **Doc:** PLAN §7 D12, §9 OQ-10, Lab §1

## Why
Measured on main: the target file is 6/6 flagged (issue says 5/5), and the
corpus of spawn tests that build paths via `__dirname` or `join(REPO_ROOT, …)` is
33 files, 20 of them flagged. Some of those 20 are file-content gate tests that
are tautological by the detector's own definition; the rest are the false-positive
class. Telling them apart is the judgment in this node.

## Scope
- may touch: `src/lib/test-tautology-detector.ts`, `src/lib/test-tautology-detector.test.ts`, detector fixture files, a new `src/lib/test-tautology-detector.corpus.test.ts`
- not in scope: CI workflow, `scripts/qa/tautology-detector-cli.ts`, per-block skip pragma, enforcement mode.

## Acceptance criteria
- [ ] AC-1: `scripts/qa/tautology-detector-cli.test.ts` scores 0 tautological — Verify: `npx vitest run src/lib/test-tautology-detector.corpus.test.ts -t "956 target"` → passes (the test runs `analyzeTestFile` on the real file and asserts `tautologicalCount === 0`).
- [ ] AC-2: a genuinely tautological test using the same `path.resolve(__dirname, …)` spawn idiom is still flagged — Verify: same file, `-t "956 negative"` → passes on a committed fixture whose spawn is real but whose assertions never touch its output; PR body carries `Mutation-verified: AC-2 — removed the __dirname recognition; <test> failed; restored.`
- [ ] AC-3: the #966 remainder (`__tests__/pre-tool-hook.integration.test.ts` blocks ~912/926/938: `join(REPO_ROOT, "hooks", "pre-tool.sh")` + `run(preHook, …)` argument binding) is recognized — Verify: same file, `-t "956 segments"` asserts that file's `tautologicalCount ≤ 1` (block ~1529 is legitimately flagged per the issue comment).
- [ ] AC-4: corpus classification recorded — Verify: PR body contains a table with one row per file in `git grep -l -e execSync -e spawnSync -e execFileSync -e 'spawn(' -- '*.test.ts' | xargs grep -l -e __dirname -e 'join(REPO_ROOT' -e 'resolve(REPO_ROOT'` (33 rows today), columns: before, after, class ∈ {subprocess-fp-fixed, file-content-legit, harness-sanity-legit}, and every `subprocess-fp-fixed` row reads `after = 0`.
- [ ] AC-5: existing detector suite green — Verify: `npx vitest run src/lib/test-tautology-detector.test.ts` → passes.

## Done when
No subprocess-driven test in the repo is flagged because its spawn path was built from `__dirname` or from separate string segments, and the remaining flags are each classified as legitimate in the PR.
