# ADR-0021: The "Read first" comment is posted once per PR after the post-QA PR update, deduped by reading the PR

**Status:** Proposed
**Date:** 2026-10-24
**Issue:** #1520

## Context

Agent PRs here merge fast (median 3.7 h open-to-merge) at about 55 issues a week, and a reviewer cannot read every line. The per-AC QA verdict answers "did it do what I asked" and nothing else. #1520 adds a computed partition of the diff, posted where the merge decision is made: residue first (files no AC's evidence names, hot files, weakened tests, tautology hits, size), then test files by seam class, then the files an AC explains.

Two choices needed a decision. Where the orchestrator posts the comment, and how it avoids posting it twice. The "orchestrator posts a receipt" pattern has been re-patched four times (#964, #1247, #1302, #1340), and each fix closed one path the receipt missed.

## Decision

The comment is posted by `postReadFirstForPR` in `batch-executor.ts`, called from `deliverIssueBranch` after the last QA iteration, whatever its verdict. It targets whichever PR the run left behind: the post-QA one when QA passed, the one opened after exec (#1247) when the run ended at a failing verdict, or the PR the state records on a qa-only re-run. That is the one point every path passes through. A run that ran no qa posts nothing, because the comment links to the QA verdict; a `--no-pr` run posts nothing because there is no PR. The mutation records come from the PR body, which `gh pr view <N> --json body` shows, merged with this run's exec output.

Dedup reads the PR: `postReadFirstComment` lists the PR's comments through `PlatformProvider.getIssueComments` and posts only when none starts with `## Read first` or carries the `SEQUANT_READ_FIRST` marker. It does not keep in-memory state.

The partition is a pure function (`review-residue.ts`) of the numstat, the test files' text, the issue body, a `git log` and the mutation markers. The git reads live in `review-residue.post.ts`. A collection failure posts nothing and logs through `warn` (#1315). An empty-looking residue built from partial input would be worse than none.

## Options

### Option A: After the post-QA PR update, dedup by reading the PR (chosen)

**Pros:** one call site for every path that ends with a PR after QA. Dedup survives re-runs, `--resume` and a crashed earlier run. **Cons:** one extra `gh` read per run. A comment posted on an earlier head is not refreshed when a later run changes the diff.

### Option B: Inside the QA loop, next to `postQaVerdictComment`

**Cons:** on a first run the PR may not exist while QA runs, so there is nothing to post on. It would also post once per QA iteration unless more state is added.

### Option C: Dedup by a flag in `.sequant/state.json`

**Cons:** state is per checkout. A run from another checkout or after a state reset posts a second comment, and the flag can say "posted" when the post failed.

### Option D: Edit the PR body's top

**Cons:** exec writes the body, the edit needs the `gh api PATCH` path, and #1520 R-1 defers it until after the freeze.

## Trade-offs

Option A gives up refreshing: the comment describes the head that the first post-QA run saw. A refresh would need an edit path (Option D's problem) or a second comment, which is the noise the dedup exists to prevent. The `SEQUANT_READ_FIRST` marker records the commit, so a reader can tell when the comment is stale.

## Consequences

- Easier: every PR the orchestrator opens and QA reviews gets one comment, and `scripts/qa/residue-outcomes.ts` finds it by the same heading and marker.
- Easier: the partition is unit-tested without git or gh. The post path is tested through `runIssueWithLogging` against a temp repo and an in-memory provider.
- Harder: a later run that changes the diff leaves the earlier comment in place. The marker's `commit` field is the only signal that it is stale.
