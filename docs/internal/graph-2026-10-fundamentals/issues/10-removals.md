chore(cli): remove the dormant surface named in D-2 — one PR per cluster (commands / flags+settings / drivers); skills cluster after the plugin freeze lifts

**Epic:** graph-2026-10-fundamentals   **Tier:** mechanical   **Execution:** sequant_run   **Blocked by:** #1510, D-2 on #1501

- **Blocked by**: #1510

**Not filed at launch.** This file is the template; it is filed (once per cluster) when D-2 is answered on the tracker with the named list. Until then it is a placeholder in the graph.

## Problem

The usage audit (usage-audit.md Tables A–G, 97 runs) found 6 commands, 64 of 89 flags, 26 of 65 settings, 5 skills and 3 drivers with zero use. Removal is a product decision (D-2). Once named, each cluster is mechanical: delete, drop the docs page or line, add a CHANGELOG `### Removed` entry, keep the suite green.

## Acceptance Criteria (per cluster; filled from D-2)

- [ ] AC-1: Each named command is gone. Evidence: `for c in <D-2 commands>; do node dist/bin/cli.js $c --help > /dev/null 2>&1; echo "$c=$?"; done` → every line ends `=1`
- [ ] AC-2: Each named flag is gone from the CLI definition. Evidence: `for f in <D-2 flags>; do grep -c -- "\"$f" bin/cli.ts; done | sort -u | tr '\n' ' '` → `0 `
- AC-2 is classified as a gate test by `isGateTestEvidence`; the PR body carries its `SEQUANT_MUTATION` record (re-add one removed `.option(` line → the flag test fails; restore).
- [ ] AC-3: Each named setting is gone from the schema. Evidence: `for s in <D-2 settings>; do grep -c "$s" src/lib/settings.ts; done | sort -u | tr '\n' ' '` → `0 `
- [ ] AC-4: Docs no longer mention them. Evidence: `grep -rlE '<D-2 names joined by |>' docs/ README.md | wc -l | tr -d ' '` → `0`
- [ ] AC-5: The changelog records the removal. Evidence: `grep -c '### Removed' CHANGELOG.md` → `≥ 1`
- [ ] AC-6: knip's count falls. Evidence: `jq '.unusedExports' scripts/qa/health-baseline.json` → `< <value at launch>`

## Prior fixes / producers

- Prior removals: #503–#508 descoping (2026-04). Class: the ACs state the outcome per named surface.
- Producers: `bin/cli.ts` (flags), `src/lib/settings.ts` (settings), `src/commands/` (commands), `docs/reference/*.md` (docs), CHANGELOG.

## May touch

Per cluster only: the named command/flag/setting files, their tests, their docs pages, CHANGELOG. Skills cluster: nothing until the freeze lifts (I-1).

## Non-Goals

- Anything not on D-2's list.
- Skills or drivers while the freeze or a driver probe (#497, #1137) is open.

## Done when

Every surface D-2 named is gone from code, docs and help, and the suite is green.
