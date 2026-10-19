tracker: graph-2026-10-review-surface — the acceptance criterion as the unit every surface shows: producer, renderers, cost, verdict attribution, Read-first comment, issue form

**Epic:** graph-2026-10-review-surface   **Tier:** judgment   **Execution:** runner   **Blocked by:** #1502 (launch gate: fundamentals wave 0 merged, #1501 D-1)

- **Blocked by**: #1502

## Problem

The GTM brief's cold reader (2026-10-18) asked for the per-criterion verdict as the first thing seen, the cost of a run, who reviewed, and a copyable issue shape. Measured on this checkout: the per-AC state record exists and is never updated (2 of 25 issues carry one, all items `pending`; `updateACStatus` has no caller); cost is captured for 154 of 420 runs in `metrics.json` and shown only by `sequant stats`; the verdict comment names no reviewer; `init` writes no issue form although the writing-issues guide contains one. This tracker lands the founding doc and graph, creates the label, and records RD-1 and OQ-2..5.

## Acceptance Criteria

- [ ] AC-1: Founding doc, graph and snapshots are on `main`. Evidence: `test -f docs/internal/graph-2026-10-review-surface/PROJECT-DISCUSSION.md && test -f docs/internal/graph-2026-10-review-surface/issue-graph.md && ls docs/internal/graph-2026-10-review-surface/issues/*.md | wc -l | tr -d ' '` → `≥ 7`
- [ ] AC-2: The label exists. Evidence: `gh label list --limit 200 --json name --jq '.[].name' | grep -c '^graph-2026-10-review-surface$'` → `1`
- [ ] AC-3: RD-1 and OQ-2..5 are answered as their own lines before RS-02 launches. Evidence: `gh api repos/sequant-io/sequant/issues/$(gh issue list --label graph-2026-10-review-surface --search 'tracker' --state all --json number --jq '.[0].number')/comments --jq '.[].body' | grep -cE '^(RD-1|OQ-[2-5]): '` → `≥ 5`

## Prior fixes / producers

Isolated: docs-only tracker.

## May touch

`docs/internal/graph-2026-10-review-surface/` only.

## Non-Goals

- No code. No edits under `plugin/`, `.claude/skills/`, `templates/skills/` (I-1).

## Done when

The directory is on `main`, the label exists, and the five decision lines are on this issue.
