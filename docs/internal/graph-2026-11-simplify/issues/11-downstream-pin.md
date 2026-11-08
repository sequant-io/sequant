gate(owner): pin the harness and matcha-maps to sequant 2.20.0 before 3.0 is published

**Epic:** graph-2026-11-simplify   **Tier:** mechanical   **Execution:** owner   **Blocked by:** #1645

- **Blocked by**: #1645

## Problem

Owner precondition of 2026-11-03: pin downstream before publishing 3.0. `~/Projects/harness/scripts/launch.sh:24` runs `nohup npx sequant run …` unpinned inside the matcha-maps checkout, which has no `sequant` dependency, so the first launch after 3.0 is published would run 3.0 against a production repo. `sequant-landing`, `workout` and `workout-admin` declare `"sequant": "^2.17.0"`, which 3.0 does not satisfy. Founding doc §4, OQ-5.

## The gate

- **Artifact reviewed:** the diff in `admarble/harness` (and, on route B, in `admarble/matcha-maps`).
- **Question the owner answers:** which route, A or B, and is its diff right?
  - **A:** the harness launches `npx sequant@2.20.0 run …`, and its CLAUDE.md names the pin. matcha-maps is unchanged.
  - **B:** matcha-maps gets `"sequant": "2.20.0"` as an exact devDependency. Tried on 2026-11-03 in a scratch worktree: the lockfile change bumped es-toolkit 1.47.0 → 1.53.1, qs 6.16.0 → 6.17.1 and string-width 8.2.2 → 8.3.0, which ship to production, so the diff is reviewed then.
- **Reject route:** a wrong diff is reverted in its own repo; 3.0 waits (#1657).

## Acceptance Criteria

- [ ] AC-1: The harness launches the pinned version (route A), or matcha-maps declares it exactly (route B). Evidence: `{ grep -c 'npx sequant@2.20.0 run' ~/Projects/harness/scripts/launch.sh; grep -c '"sequant": "2.20.0"' ~/Projects/matcha-maps/package.json; } | awk '{s+=$1} END{print (s>=1)}'` → `1`
- [ ] AC-2: No unpinned launch remains in the harness scripts. Evidence: `grep -rnE 'npx sequant( |$)' ~/Projects/harness/scripts | wc -l | tr -d ' '` → `0`
- [ ] AC-3: The pin is pushed. Evidence: `git -C ~/Projects/harness show origin/main:scripts/launch.sh | grep -c 'sequant@2.20.0'` → `≥ 1`
- [ ] AC-4: The owner named the other repos that need a pin, or none (OQ-5). Evidence: `gh issue view $(gh issue list --label graph-2026-11-simplify --search 'tracker' --state all --json number --jq '.[0].number') --json comments --jq '[.comments[].body|select(test("^PIN: "))]|length'` → `≥ 1`

## May touch

`admarble/harness`: `scripts/launch.sh`, `CLAUDE.md`. Route B: `admarble/matcha-maps` `package.json` and `package-lock.json`.

## Non-Goals

- Any change in sequant's tree.
- Repos with `^2.x` dependencies.

## Done when

The production executor cannot pick up 3.0 by accident.
