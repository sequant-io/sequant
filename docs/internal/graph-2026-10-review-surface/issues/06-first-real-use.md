smoke(review-surface): first real use — one testbed run after the producer, renderers and cost land; the owner reads the AC table, the cost line and the verdict against each other

**Epic:** graph-2026-10-review-surface   **Tier:** judgment   **Execution:** runner   **Blocked by:** #RS-03, #RS-04, #1521

- **Blocked by**: #RS-03
- **Blocked by**: #RS-04
- **Blocked by**: #1521

## Problem

Fixtures prove the parse and the renderers against comments that already exist. They do not prove that a live run, with a verdict the QA skill writes today, produces a table that agrees with the comment, a cost that agrees with `sequant stats`, and an attribution line that names the drivers the run used. This is the graph's first-real-use node: one `sequant run` on the testbed (OQ-5), launched detached (#856), its outputs captured and read by the owner, who answers one question.

## Artifact reviewed

The captured terminal summary, `sequant status` and `sequant logs <run>` output, the run log JSON, and the issue's verdict comment, posted on this issue.

## Question the human answers

Do the terminal table, the run log's `acs[]`, and the verdict comment say the same thing for every criterion, and does the cost line match `sequant stats` for that run?

## Reject route

Disagreement on any criterion reopens #RS-02 (the producer), not the renderers; a cost mismatch reopens #RS-04.

## Acceptance Criteria

- [ ] AC-1: The run log carries both new records (`acs[]` per issue, `cost` per run). Evidence: `jq -e '.issues[0].acs | length >= 1' "$RUNLOG" > /dev/null && jq -e '.cost.usd > 0' "$RUNLOG" > /dev/null && echo ok` → `ok` (`$RUNLOG` is the run-log path the runner names on this issue)
- [ ] AC-2: The terminal summary shows the table and the cost line. Evidence: `grep -cE '^\s+AC-[0-9]+ (met|not_met|pending|blocked|unknown)' "$SUMMARY"` → `≥ 1` and `grep -c 'SDK estimate' "$SUMMARY"` → `1` (`$SUMMARY` is the captured output file)
- [ ] AC-3: The verdict comment carries the attribution line (#1521). Evidence: `gh api repos/sequant-io/sequant/issues/$ISSUE/comments --jq '[.[].body | select(test("^## QA Verdict"))] | last' | grep -c '^_Reviewed in a separate session by '` → `1`
- [ ] AC-4: The owner's read is recorded with the route taken. Evidence: `gh issue view $(gh issue list --label graph-2026-10-review-surface --search 'smoke' --state all --json number --jq '.[0].number') --json comments --jq '[.comments[].body | select(test("^Verdict: (agree|reopen-RS-02|reopen-RS-04)"))] | length'` → `1`

## Prior fixes / producers

The 2026-10-09/10 stranger smokes (#1387, #1389) are the precedent for the procedure: fresh clone, `npm pack` of `main`, detached launch. This node reuses it; #1519 automates the knowledge-free version separately.

## May touch

Nothing in the tree except the smoke report comment; a reopen is a new PR on the named node.

## Non-Goals

- Fixing anything found here (the reject route names the node).
- A release.

## Done when

The owner's verdict line is on this issue.
