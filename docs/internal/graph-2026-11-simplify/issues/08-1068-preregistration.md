investigation(qa): pre-register #1068's section leave-one-out for qa on fixture #34, with the cost estimated before any run — written in the research repo, hash and estimate posted on #1068

**Epic:** graph-2026-11-simplify   **Tier:** judgment   **Execution:** runner   **Blocked by:** #1645

- **Blocked by**: #1645

## Problem

D-4: pre-register #1068 now for qa's sections on fixture #34, with the cost estimated before any run; exec and fullsolve later. Every later cut of qa's 3,845 lines waits on this measurement, so that the cut is chosen by data. Fixture #34 is the one fixture with headroom: `/qa` named 1 of 5 planted defects in 8 of 8 runs. Its ground truth lives only in `admarble/smpl-sequant` (private), and the held-out fixture #1272 names stays unread while sections are chosen. Founding doc P-10, OQ-4.

## Decisions

| ID | Decision | Rejected |
|---|---|---|
| P-1 | The pre-registration is `experiments/E8-qa-leave-one-out.md` in `admarble/smpl-sequant`, under that repo's rules (committed before any scored run; amendments dated) | sequant's `docs/investigations/` (ground truth would sit beside it on a public repo) |
| P-2 | Sequant gets one comment on #1068 with the commit hash, the arms, the run count and the cost estimate, carrying the marker `SEQUANT_PREREG`, and no fixture identifier | no comment (the tracker would not know the measurement exists) |
| P-3 | Firing it is a separate owner decision after the estimate (§10) | firing on approval of this node |

## Acceptance Criteria

- [ ] AC-1: The pre-registration is committed in the research repo. Evidence: `git -C ~/Projects/smpl-sequant log --format=%h -- experiments/E8-qa-leave-one-out.md | wc -l | tr -d ' '` → `≥ 1`
- [ ] AC-2: It has the sections the research repo's method requires. Evidence: `grep -cE '^## (Question|Arms|Fixture|Decision rule|Cost estimate|Stop rules)$' ~/Projects/smpl-sequant/experiments/E8-qa-leave-one-out.md` → `6`
- [ ] AC-3: The owner approved it in the research repo's decision log. Evidence: `grep -c 'E8' ~/Projects/smpl-sequant/decisions/log.md` → `≥ 1`
- [ ] AC-4: #1068 carries the comment. Evidence: `gh api repos/sequant-io/sequant/issues/1068/comments --jq '[.[].body|select(test("SEQUANT_PREREG"))]|length'` → `≥ 1`
- [ ] AC-5: The comment carries no fixture identifier. Evidence: `gh api repos/sequant-io/sequant/issues/1068/comments --jq '[.[].body|select(test("SEQUANT_PREREG"))]|last' | python3 -c 'import json,os,sys;t=json.load(open(os.path.expanduser("~/Projects/smpl-sequant/experiments/E6/fixture/ground-truth.json")));b=sys.stdin.read().lower();print(sum(i.lower() in b for d in t["defects"] for i in d["identifiers"]) if b.strip() not in ("","null") else "no-comment")'` → `0`

`isGateTestEvidence` classifies AC-2 and AC-5 as gates (parse-check, 2026-11-04). This node changes nothing in sequant's tree and runs no `/qa` phase (`Execution: runner`), so §6i never reads them and no `SEQUANT_MUTATION` record applies; the runner runs each command and pastes its output on the issue.

## May touch

`admarble/smpl-sequant`: `experiments/E8-qa-leave-one-out.md` (new), `decisions/log.md`, `journal.md`. `sequant-io/sequant`: one comment on #1068.

## Non-Goals

- Running it (§10), choosing sections to cut, exec and fullsolve (D-4: later).
- Any read of #1272's held-out fixture.

## Done when

A committed, owner-approved pre-registration with a cost estimate exists, and #1068 points to it without naming the fixture's content.
