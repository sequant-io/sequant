docs(ready): the ready gate's docs drop the second-look claim — describe the qa → loop → qa mechanism and its policy, cite #1344 for what was measured

**Epic:** graph-2026-11-simplify   **Tier:** mechanical   **Execution:** sequant_run   **Blocked by:** #S-03 (both edit `docs/reference/run-command.md`)

- **Blocked by**: #S-03

## Problem

D-2: the ready gate keeps its loop and drops its second-look claim from the docs. The docs say the gate automates the maintainer's second look and that its value under the `ac` policy is "the fresh second look". On fixture #34 the gate's final verdict named +0.025 more planted defects than the first verdict, null by #1344's rule; what it did reliably was turn the first verdict's named catch into a fix commit (8 of 8 pairs). The n = 27 study the docs cite found 7 of 10 catches came after the human's "any gaps?", which the gate does not ask. Founding doc §4 lists the seven lines.

## Acceptance Criteria

- [ ] AC-1: None of the seven claim lines remains. Evidence: `grep -cE 'automating the habitual|already automates exactly|value there is the \*\*fresh second look|reproduce the maintainer.s manual fresh-session|which .sequant ready. automates|post-QA second look' docs/features/run-ready-gate.md docs/reference/ready-command.md docs/reference/run-command.md | awk -F: '{s+=$2} END{print s}'` → `0`
- [ ] AC-2: No link points at the old anchor. Evidence: `grep -rn 'ready-gate-post-qa-second-look' README.md docs | grep -v '^docs/internal/' | wc -l | tr -d ' '` → `0`
- [ ] AC-3: The feature page says what the gate does and cites the measurement. Evidence: `grep -c '#1344' docs/features/run-ready-gate.md` → `≥ 1`
- [ ] AC-4: No code or skill edits. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -vcE '^(docs/|CHANGELOG\.md$)'` → `0` (constraint)

`isGateTestEvidence` classifies none of these ACs as a gate (parse-check, 2026-11-04).

## May touch

`docs/features/run-ready-gate.md`, `docs/reference/ready-command.md`, `docs/reference/run-command.md` (the Ready Gate section and its heading only), CHANGELOG.

## Non-Goals

- The gate's behaviour, flags or loop (D-2 keeps them).
- `docs/investigations/` (dated records; left as written).
- Skill text that mentions a second look (frozen).

## Done when

The ready gate's docs describe a qa → loop → qa pass to a policy and claim no catch rate.
