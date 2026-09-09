# 05 — #980-P1b ci(trust): OpenSSF Scorecard workflow + README badge; initial score recorded

**Epic:** W2   **Blocked by:** #980-P0 (node 03)   **Tier:** mechanical   **Doc:** W2 PLAN §7 D5/D8, §8 (README serialization)

## Why
#980 AC-5. A recurring, third-party-computed supply-chain signal that a
reviewer can check without trusting our prose. Sequenced after node 03 so the
README edits (03 link line → 05 badge line → 07 section) do not conflict.

## Scope
- may touch: `.github/workflows/scorecard.yml` (new; `ossf/scorecard-action`
  pinned by commit SHA like the other workflows), `README.md` (one badge line),
  `CHANGELOG.md` (one bullet).
- not in scope: remediating findings (recorded, not fixed here); any other
  workflow; `SECURITY.md`/threat model text.

## Acceptance criteria
- [ ] AC-1: the workflow runs on `push` to `main` and weekly schedule with `permissions` limited to what the action documents, action pinned by SHA — Verify: `grep -c "ossf/scorecard-action@[0-9a-f]\{40\}" .github/workflows/scorecard.yml` → `1`; `gh run list --workflow scorecard.yml --limit 1 --json conclusion --jq '.[0].conclusion'` → `success`.
- [ ] AC-2: README badge renders — Verify: `curl -sI "$(grep -o 'https://api.securityscorecards.dev/projects/[^)]*badge' README.md | head -1)" | head -1` → `HTTP/2 200`.
- [ ] AC-3: the initial score and the top-3 remediation items are posted as a comment on this issue — Verify: `gh issue view <this> --json comments --jq '.comments[-1].body' | grep -c "Score:"` → `1`.

## Done when
Scorecard runs on its own schedule, the badge is live, and the first score is
on record with its remediations named.
