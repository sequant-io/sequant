# 16 — #862-P2 GATE: opencode dogfood promotion (human)

**Epic:** M3   **Blocked by:** #862-P1 (node 15)   **Tier:** human   **Doc:** PLAN §2 D-opencode, §7 D2, §8 (human gate form)

## Artifact reviewed
`docs/investigations/multi-backend-2026-07.md`, new section "Dogfood 2026-09":
a table of ≥3 real issues from this repo (or the testbed) run spec→exec→qa with
`--agent opencode` and the same issues on claude-code — columns: issue, driver,
verdict, skill-marker present, fan-out observed, `$`, wall, defects found by the
owner's read of the PR.

The table is produced by the runner as the last step of node 15's wave
(launch the three issues with `--agent opencode`, then with the default driver;
record; do not merge any of those PRs — they are samples).

## Question the human answers
"Promote opencode from experimental to a documented backend in this release?"

## Accept route
- README multi-agent section gains `--agent opencode`; `docs/reference/opencode-driver.md` written (the P2 docs AC) — filed as a mechanical docs node only on accept.

## Reject route
- Findings become ACs on a reopened node 12 or node 15 (whichever surface failed), with the failing dogfood row as the motivating example. No new issue is filed without a PLAN §7 decision row (I-7).

## Verify (for the runner, not the human)
- `grep -c 'Dogfood 2026-09' docs/investigations/multi-backend-2026-07.md` ≥ 1 and the table has ≥ 6 rows (3 issues × 2 drivers) before the gate is presented.
