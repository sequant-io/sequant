smoke(simplify): first real use — one detached run of a `main` build on two notes-fixture smoke issues, after #1646 to #1652 merge; the owner reads the report

**Epic:** graph-2026-11-simplify   **Tier:** judgment   **Execution:** runner   **Blocked by:** #1646, #1647, #1648, #1649, #1650, #1651, #1652

- **Blocked by**: #1646
- **Blocked by**: #1647
- **Blocked by**: #1648
- **Blocked by**: #1649
- **Blocked by**: #1650
- **Blocked by**: #1651
- **Blocked by**: #1652

## Problem

The phases that build each node run the published 2.20.0, not the branch, so no node's runtime behaviour has been seen by the time it merges. Unit tests show the halt, the warning and the reach block in isolation; they do not show a live qa agent leaving a needs-human Evidence line unrun while the frozen skill's §6h tells it to run every line (OQ-3), or which verdict follows (OQ-6). This node runs the merged `main` once. Founding doc P-12.

## Procedure

1. Build `main` at the commit after the last of #1646 to #1652 merges; record the SHA.
2. On `admarble/notes-fixture`, file two smoke issues from `main`'s smoke templates, written at launch: **A** with three ACs (one ordinary `npx vitest` AC; one whose Evidence is `npx tsx --env-file=.env.local scripts/smoke-check.ts` → `ok`; one whose Evidence cannot pass, so that QA refuses), **B** with one ordinary AC. Neither touches fixture #34's branch.
3. Launch `node ~/Projects/sequant/dist/bin/cli.js run <B> <A> --chain -Q --max-iterations 3` with `launchctl submit`, under `smpl-sequant/experiments/E2c/deny.sb` as it stands (#856; sandbox per P-12). B goes first because `--chain` halts on any failed issue (`bin/cli.ts:374`) and A is built to fail.
4. Collect the stdout, the run log and the phase transcripts; write the report as a comment on the tracker.

## Acceptance Criteria

- [ ] AC-1: The run printed both experimental warnings. Evidence: `grep -cE '^⚠ (--chain is|Multi-issue runs are) experimental' ~/Projects/notes-fixture-runs/simplify-smoke/stdout.log` → `≥ 2`
- [ ] AC-2: The run summary named A's env-file AC as needing a person. Evidence: `grep -c 'needs a person: .npx tsx --env-file' ~/Projects/notes-fixture-runs/simplify-smoke/stdout.log` → `1`
- [ ] AC-3: No phase executed the env-file command (the prompt block quoting it is a user turn, not a tool call). Evidence: `ls ~/Projects/notes-fixture-runs/simplify-smoke/transcripts/*.jsonl > /dev/null && cat ~/Projects/notes-fixture-runs/simplify-smoke/transcripts/*.jsonl | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command' | grep -c -- '--env-file'` → `0`
- [ ] AC-4: The run log shows A's quality loop stopping at `ac_not_met_repeated`, or the report says the second refusal was not reached and why. Evidence: `jq -r --argjson a "$A" '.issues[] | select(.issueNumber==$a) | .abortReason // "not-reached"' ~/Projects/notes-fixture-runs/simplify-smoke/run-log.json | cut -d: -f1` → `ac_not_met_repeated`, or `not-reached` with a reason in the report
- [ ] AC-5: The removed flags are rejected by the build. Evidence: `for f in --model-ladder=sonnet --escalate-effort --stacked --reflect --full-qa; do node ~/Projects/sequant/dist/bin/cli.js run 1 $f --dry-run 2>&1 | grep -c "unknown option"; done | sort -u | tr '\n' ' '` → `1 `
- [ ] AC-6: The owner answered the smoke question on the tracker. Evidence: `gh issue view $(gh issue list --label graph-2026-11-simplify --search 'tracker' --state all --json number --jq '.[0].number') --json comments --jq '[.comments[].body|select(test("^SMOKE: (ship|reopen)"))]|length'` → `≥ 1`

**The question (owner):** given the report, is `main` fit to release as 3.0, or which node reopens? Answer `SMOKE: ship` or `SMOKE: reopen #N <reason>`.

`isGateTestEvidence` classifies AC-1 to AC-4 as gates (parse-check, 2026-11-04). This node changes nothing in sequant's tree and runs no `/qa` phase (`Execution: runner`), so §6i never reads them and no `SEQUANT_MUTATION` record applies; the report pastes each command's output.

OQ-6 (the verdict A gets with one AC pending) is recorded in the report; a verdict the frozen skill gets wrong is a post-lift fix, not a reopen.

## May touch

Nothing in sequant's tree. `admarble/notes-fixture`: two issues, their branches and PRs, closed after the report. `~/Projects/notes-fixture-runs/simplify-smoke/` (local).

## Non-Goals

- Any scored measurement; this is a smoke.
- Fixture #34 or any fixture with ground truth.

## Done when

The owner has read one real run of the simplified `main` and answered ship or reopen.
