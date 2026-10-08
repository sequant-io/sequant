kind: Added

**`/exec` and `/qa` run the tests a branch affects instead of the full suite (#1349).** `npx vitest run --changed origin/main` (jest: `--changedSince`), plus AC `Evidence:` test files, changed test files and tests that mention a changed file. Stacks with no affected mode keep the full command (`resolveAffectedTestCommand`). CI still runs everything.
