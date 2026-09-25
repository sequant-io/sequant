# Graph 2026-09-w3 — small-fixes wave

Planned 2026-09-24. The owner approved the plan on 2026-09-25, and the AC blocks were written into #1145, #1122 and #1141. Four independent items with no shared files, so this is one parallel wave. There is no founding doc and no Phase 0: every item already has an observed repro (see each issue body).

**Merge consent:** stop at the PR. The owner merges.
**Runner:** one wave. Use `sequant run` with concurrency ≤ 3, because each qa phase runs `npm test`. You can also run `/exec` + `/qa` directly on the mechanical items.

## Nodes

| # | Item | Tier | May touch | Blocked by |
|---|---|---|---|---|
| A | #1145 branch-name divergence | mechanical | `templates/scripts/new-feature.sh` (`scripts/new-feature.sh` is a symlink to it, so there is no second copy), a new gate test | #1159 (found during execution; the earlier edge to C was wrong) |
| B | #1153 Upstream Assessment push to `main` (label already created 09-25) | mechanical | repo label (no PR); `.github/workflows/upstream-assessment.yml` | — |
| C | #1122 writers follow symlinks / crash on directories | judgment | `src/lib/templates.ts`, `src/commands/{init,update,sync}.ts`, `src/lib/__tests__/writer-state-matrix.test.ts` | — |
| D | #1141 root creates `/nonexistent/path` | mechanical | `src/lib/workflow/state-hook.test.ts`, the 5 test files that use `/nonexistent/path` | — |

Shared merge point: `CHANGELOG.md` `[Unreleased]`. Each PR adds one line. Merge `main` in, don't rebase. Each squash can re-conflict this file.

## A — #1145 (proposed AC block for the issue body)

- **Tier:** mechanical
- [ ] AC-1: `new-feature.sh` derives the branch as `feature/<N>-<slug>`, where the slug is `slugify(title)` exactly: lowercase, runs of non-`[a-z0-9]` become `-`, leading/trailing `-` stripped, then cut at 50 characters with no trailing-dash strip afterwards. The whole-branch cut at 58 is removed. — Verify: gate test below
- [ ] AC-2: a gate test runs the script's naming logic as a real bash subprocess and compares it to the exported `slugify()` for (a) a title whose slug exceeds 50 characters and whose 50th character is `-`, (b) a short title, and (c) a title with leading punctuation. It does not compare regex literals (#871). — Verify: `npx vitest run src/lib/workflow/__tests__/new-feature-branch-parity.test.ts`
- [ ] AC-3: the PR body carries the `SEQUANT_MUTATION` marker for AC-2. Mutation: restore the `cut -c1-58`. `failedTest` starts with the test file path. — Verify: `/qa` §6i

Open question for exec: the naming lives inline after `gh issue view`. The test needs an entry point that doesn't call the network. Either extract a `branch_name_for` function behind a `--print-branch <N> <title>` flag, or source a helper. Exec decides; the AC only requires a real bash execution.

## B — Upstream Assessment (#1153)

Observed: 4 consecutive scheduled failures, on 08-31, 09-07, 09-14 and 09-21, all in the step `Run upstream assessment`. The logs have expired. `src/lib/upstream/issues.ts:296` creates issues with labels `["upstream","assessment"]`. `assessment` does not exist (`gh label list`). The cron is `0 9 * * 1`, so the next run is **Monday 09-28 09:00 UTC**, not Sunday.

A second failure is hiding behind the first. The `Commit report and baseline` step (yml:131-146) runs `git push` to `main`. Since #1109 (09-20), `main` rejects direct pushes (GH013), so the run still fails once the label exists.

- B1: ✔ done 2026-09-25. Label `assessment` created (repo state, no PR).
- B2 (filed as #1153): land the report and baseline through a PR instead of a direct push. Branch `upstream/<version>`, then `gh pr create`. That needs `pull-requests: write` added to `permissions:`. The alternative is to drop the committed report and keep only the step summary plus the issue. **Owner decision (09-25):** keep committing reports, via a PR.
  - [ ] AC-1: the workflow never runs `git push` to `main` — Verify: `grep -n "git push" .github/workflows/upstream-assessment.yml` shows no bare push to the checked-out `main`
  - [ ] AC-2: a `workflow_dispatch` run with `version` set to the current latest completes green — Verify: `gh run list --workflow upstream-assessment.yml --limit 1 --json conclusion` → `success`

## C — #1122 (proposed AC block)

- **Tier:** judgment. This is the last data-loss path in the #1053 class, spread across three writers plus the dry-run reader.
- [ ] AC-1: no writer writes through an existing symlink at a sequant-owned destination. The link is replaced and its target is left byte-identical. — Verify: `npx vitest run src/lib/__tests__/writer-state-matrix.test.ts` with `symlink-written-through-at-sequant-owned` removed from `KNOWN_DEFECTS`
- [ ] AC-2: a directory at a template destination produces the named error `<path> is a directory; move it aside` (or a documented skip) and no partial write. `sync --dry-run` and `update --dry-run` report the collision and do not throw. — Verify: same test file with `directory-crashes-writer` removed from `KNOWN_DEFECTS`
- [ ] AC-3: the repro from the issue body, run against a real temp project, leaves the foreign target unchanged — Verify: a named case in the matrix test that asserts the foreign file's content survives `sync`
- [ ] AC-4: `npm run build && npm test` green

## D — #1141 (proposed AC block)

The issue's current verify command (`sudo -E npx vitest …`) can't be run verbatim in QA, and running the suite as root on a Mac leaves root-owned files behind. The ACs below replace it with checks that run as a normal user.

- **Tier:** mechanical
- [ ] AC-1: the "should not throw on state errors" test has no filesystem side effect whatever the user. It simulates the root case by making `fs.mkdirSync` succeed (mocked) and asserts that nothing is written outside a temp dir. — Verify: `npx vitest run src/lib/workflow/state-hook.test.ts`
- [ ] AC-2: no test file hardcodes `/nonexistent/path`. Assumed-absent paths come from `path.join(os.tmpdir(), <unique>)` and are never created. — Verify: `grep -rn "/nonexistent/path" src` produces no output
- [ ] AC-3: a gate test enforces AC-2 and is mutation-verified. Mutation: re-add the literal to one test file. — Verify: `/qa` §6i marker

## Execution log

- 2026-09-25: the plan missed an edge. A (#1145, PR #1156) passes all 3 of its ACs, but it turns the required `canary` check red. The canary fixture's `scripts/dev/new-feature.sh` is a symlink, and `sync` won't write through it. That is C's bug (#1122). So A merges after C, then merges `main` in and re-runs `npx vitest run --project canary`. Lesson for the file-scope pass: a node that changes a template file shares scope with any node that changes the template *writers*.
- 2026-09-25: B (#1153, PR #1155) is held for an owner decision. QA found three blockers, and the runner reproduced each one. (1) `.gitignore:52` `**/.sequant/` overrides the `!.sequant/upstream/` exception, so `git add` rejects new reports. (2) The repo doesn't allow Actions to create PRs, so `gh pr create` returns 403. (3) A PR opened with `GITHUB_TOKEN` starts no runs of the required checks. Items 2 and 3 mean the PR route needs a PAT or GitHub App token, or else a return to the not-committed option.
- 2026-09-25 (correction): A is **not** blocked by C. With C's branch merged into A, the canary still fails 2/4. The real cause is a new issue, #1159. `resolveScriptsSymlinkTarget` points `scripts/dev` at the project's own `node_modules` copy (older version, the #991 design), while the dry-run and drift check compare it against the running CLI's bundled template. It's reproduced against a real `sequant@2.16` project. A is now blocked by #1159, and every future `templates/scripts/*.sh` change is blocked the same way.
- 2026-09-25: C's QA found `.mcp.json` writes (`mcp-config.ts`) bypass the new symlink guard, so C is not the last path in the #1053 class. Filed as #1160.

## Anti-gap passes

1. Journey: each reported symptom maps to exactly one node (A, B, C, D). ✔
2. Artifacts: branch name → A; assessment issue and report → B; template destinations → C; the test fixture path → D. ✔
3. Producer/consumer: A's consumer is `findExistingWorktree(branch)`. B's consumer is `issues.ts:296` plus the ruleset. ✔
4. Shared files: only `CHANGELOG.md`. The rule is one line per PR, merged in. ✔
5. Dry run: B1 is done outside the graph. The owner decided B2 on 09-25. All four nodes (#1145, #1153, #1122, #1141) can start now.

## Not in this wave (unchanged)

#1089, #1049, #856, #934 stay open. Human gates #997, #1026, #1027 and #1060 still hold downstream work. #1137 is **parked** (P-1 failed 09-24), so D is worth doing but not urgent, and nothing needs to be sequenced around #1137.
