# Handoff — guard-2026-09, gates

Wave 3 ran 2026-09-20 (record in `issue-graph.md`). Two PRs are open and verified, stop-at-PR: #1127 (#1098 canary + `next` soak) and #1128 (#1094 hook corpus). Each squash re-conflicts the other's CHANGELOG (keep both sides, fold duplicate `###` headings, re-run CI). Do not merge #1082.

## What is left is the owner's

- **Gate #1109** (after #1126 is already on main): apply the `main` ruleset by hand — `scripts/ruleset-main.sh --print` emits the payload (target `~DEFAULT_BRANCH`, block deletion and non-fast-forward, required check `test`, strict up-to-date). Until it is applied, `main` is unprotected.
- **Gate #1110** (after #1127 merges and #1109 is applied): require the `canary` check, publish the next release to `next`, run the soak checklist across the local repo set (`npx sequant@next sync --dry-run` in each), then promote with `--soaked`.

## If a runner session continues

```
/graph-run

Graph `guard-2026-09`. Plan: `docs/internal/graph-2026-09-guard/PLAN.md` (§7 D-13..D-23), graph: `issue-graph.md` (three execution records). No exec nodes remain; #1129 (replay-harness coverage) is a follow-up outside the graph. Verify #1109 and #1110 as human gates: check the ruleset via `gh api repos/{owner}/{repo}/rulesets` and the npm dist-tags via `npm view sequant dist-tags`; record both in `issue-graph.md` and close the graph with a final ledger.
```
