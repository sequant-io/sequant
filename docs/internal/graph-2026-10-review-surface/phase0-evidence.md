# Phase-0 evidence run — `main` 96990daab, 2026-10-18

Classes: **fails-today** (command runs, result differs from the expected value), **constraint** (holds on `main` by construction, binding on the PR), **not-runnable** (needs a PR, runner input, owner answer or a file another node creates — the command itself errors today), **timeout** (>90 s at plan time).

| Issue | AC | Class | Observed (first line) | Expected |
|---|---|---|---|---|
| 00 | AC-1 | fails-today | `(no output, exit 1)` | `≥ 7` |
| 00 | AC-2 | fails-today | `0` | `1` |
| 00 | AC-3 | fails-today | `0` | `≥ 5` |
| 01 | AC-1 | fails-today | `0` | `≥ 10` |
| 01 | AC-2 | fails-today | `node:internal/modules/esm/resolve:275` | `ok` |
| 01 | AC-3 | fails-today | `node:internal/modules/esm/resolve:275` | `ok` |
| 01 | AC-4 | fails-today | `grep: docs/evidence/review-surface/ac-parse-coverage.md: No such file or directory` | `1` |
| 01 | AC-5 | fails-today | `grep: docs/evidence/review-surface/ac-parse-coverage.md: No such file or directory` | `1` |
| 02 | AC-1 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 10 passed, 0 failed` |
| 02 | AC-2 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 3 passed, 0 failed` |
| 02 | AC-3 | fails-today | `0` | `≥ 1` |
| 02 | AC-4 | constraint | `0` | `≥ 1` |
| 02 | AC-5 | constraint | `0` | `0` |
| 02 | AC-6 | constraint | `0` | `0` |
| 03 | AC-1 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 4 passed, 0 failed` |
| 03 | AC-2 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 03 | AC-3 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 03 | AC-4 | fails-today | `0` | `≥ 1` |
| 03 | AC-5 | constraint | `0` | `0` |
| 03 | AC-6 | constraint | `0` | `0` |
| 04 | AC-1 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 3 passed, 0 failed` |
| 04 | AC-2 | fails-today | `0` | `≥ 1` |
| 04 | AC-3 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 04 | AC-4 | fails-today | `0` | `0` |
| 04 | AC-5 | fails-today | `0` | `≥ 1` |
| 04 | AC-6 | fails-today | `0` | `≥ 1` |
| 05 | AC-1 | not-runnable | (no backticked command → expected pair) | |
| 05 | AC-2 | fails-today | `0` | `≥ 1` |
| 05 | AC-3 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 3 passed, 0 failed` |
| 05 | AC-4 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 05 | AC-5 | fails-today | `node:fs:440` | `form-ok` |
| 05 | AC-6 | constraint | `0` | `0` |
| 06 | AC-1 | fails-today | `jq: error: Could not open file : No such file or directory` | `ok` |
| 06 | AC-2 | fails-today | `grep: : No such file or directory` | `≥ 1` |
| 06 | AC-3 | fails-today | `0` | `1` |
| 06 | AC-4 | fails-today | `accepts 1 arg(s), received 0` | `1` |

Total ACs: 36.
