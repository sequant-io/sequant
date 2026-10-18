# Phase-0 evidence run — `main` 96990daab, 2026-10-18

Classes: **fails-today** (command runs, result differs from the expected value), **constraint** (holds on `main` by construction, binding on the PR), **not-runnable** (needs a PR, runner input, owner answer or a file another node creates — the command itself errors today), **timeout** (>90 s at plan time).

| Issue | AC | Class | Observed (first line) | Expected |
|---|---|---|---|---|
| 00 | AC-1 | fails-today | `(no output, exit 1)` | `≥ 13` |
| 00 | AC-2 | fails-today | `0` | `1` |
| 00 | AC-3 | fails-today | `0` | `≥ 6` |
| 01 | AC-1 | fails-today | `node:internal/modules/esm/resolve:275` | `ok` |
| 01 | AC-2 | fails-today | `(no output, exit 1)` | `same` |
| 01 | AC-3 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 4 passed, 0 failed` |
| 01 | AC-4 | fails-today | `0` | `1` |
| 01 | AC-5 | fails-today | `0` | `≥ 1` |
| 01 | AC-6 | fails-today | `(no output, exit 1)` | `fast` |
| 02 | AC-1 | fails-today | `3` | `0` |
| 02 | AC-2 | constraint | `green` | `green` |
| 02 | AC-3 | fails-today | `(no output, exit 1)` | `ok` |
| 02 | AC-4 | fails-today | `0` | `1` |
| 02 | AC-5 | fails-today | `node:internal/modules/esm/resolve:275` | `ok` |
| 03 | AC-1 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 3 passed, 0 failed` |
| 03 | AC-2 | fails-today | `0` | `≥ 1` |
| 03 | AC-3 | constraint | `1` | `1` |
| 03 | AC-4 | fails-today | `node:internal/modules/esm/resolve:275` | `0` |
| 03 | AC-5 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 03 | AC-6 | fails-today | `(no output, exit 1)` | `≤ 94` |
| 04 | AC-1 | fails-today | `node:internal/modules/esm/resolve:275` | `0` |
| 04 | AC-2 | fails-today | `0` | `≥ 1` |
| 04 | AC-3 | constraint | `green` | `green` |
| 04 | AC-4 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 1 passed, 0 failed` |
| 04 | AC-5 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `0` |
| 05 | AC-1 | fails-today | `3` | `0` |
| 05 | AC-2 | fails-today | `fixtures=0` | `fixtures=≥ 4` |
| 05 | AC-3 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 4 passed, 0 failed` |
| 05 | AC-4 | fails-today | `6` | `0` |
| 05 | AC-5 | fails-today | `(no output, exit 1)` | `≥ 1` |
| 05 | AC-6 | fails-today | `   Duration  18.61s (tests 94%, import 4%, transform 2%)` | `0 failed` |
| 05 | AC-7 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `0` |
| 06 | AC-1 | fails-today | `1` | `0` |
| 06 | AC-2 | constraint | `0` | `0` |
| 06 | AC-3 | fails-today | `   Duration  27.49s (tests 99%, import 1%)` | `0 failed` |
| 06 | AC-4 | constraint | `1 1` | `1 1 ` |
| 06 | AC-5 | not-runnable | needs PR/runner/owner input | `identical` |
| 06 | AC-6 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `true` |
| 07 | AC-1 | fails-today | `7` | `0` |
| 07 | AC-2 | fails-today | `0` | `≥ 1` |
| 07 | AC-3 | constraint | `green` | `green` |
| 07 | AC-4 | constraint | `0` | `0` |
| 07 | AC-5 | constraint | `       × commit: git add and git commit succeed inside the driver's default sandbox 592ms` | `0 failed` |
| 07 | AC-6 | not-runnable | needs PR/runner/owner input | `identical` |
| 07 | AC-7 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `≤ 5` |
| 08 | AC-1 | fails-today | `5` | `0` |
| 08 | AC-2 | fails-today | `0` | `≥ 1` |
| 08 | AC-3 | constraint | `green` | `green` |
| 08 | AC-4 | constraint | `0` | `0` |
| 08 | AC-5 | fails-today | `   Duration  35.00s (tests 89%, import 9%, transform 2%)` | `0 failed` |
| 08 | AC-6 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `≤ 7` |
| 09 | AC-1 | fails-today | `(no output, exit 1)` | `ok` |
| 09 | AC-2 | fails-today | `18` | `0` |
| 09 | AC-3 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 09 | AC-4 | fails-today | `0` | `≥ 1` |
| 09 | AC-5 | fails-today | `0` | `≥ 1` |
| 09 | AC-6 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `0` |
| 10 | AC-1 | not-runnable | (no backticked command → expected pair) | |
| 10 | AC-2 | not-runnable | needs PR/runner/owner input | `0 ` |
| 10 | AC-3 | not-runnable | needs PR/runner/owner input | `0 ` |
| 10 | AC-4 | not-runnable | needs PR/runner/owner input | `0` |
| 10 | AC-5 | fails-today | `5` | `≥ 1` |
| 10 | AC-6 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `< <value at launch>` |
| 11 | AC-1 | fails-today | `(no output, exit 1)` | `rows=N files=N` |
| 11 | AC-2 | fails-today | `0` | `0` |
| 11 | AC-3 | fails-today | `bash: -c: line 0: unexpected EOF while looking for matching `''` | `0` |
| 11 | AC-4 | fails-today | `grep: docs/internal/graph-2026-10-fundamentals/prose-gates.md: No such file or directory` | `1` |
| 11 | AC-5 | fails-today | `grep: docs/internal/graph-2026-10-fundamentals/prose-gates.md: No such file or directory` | `1` |
| 12 | AC-1 | fails-today | `grep: docs/internal/graph-2026-10-fundamentals/prose-gates.md: No such file or directory` | `ok N<=K` |
| 12 | AC-2 | fails-today | `0` | `0` |
| 12 | AC-3 | constraint | `0` | `0` |
| 12 | AC-4 | not-runnable | needs PR/runner/owner input | `≥ <execute total>` |
| 12 | AC-5 | not-runnable | needs PR/runner/owner input | `["SUCCESS"]` |
| 12 | AC-6 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `true` |
| 13 | AC-1 | fails-today | `(no output, exit 1)` | `5` |
| 13 | AC-2 | not-runnable | (no backticked command → expected pair) | |
| 13 | AC-3 | fails-today | `0` | `≥ 1` |
| 13 | AC-4 | fails-today | `RUN  v5.0.4 /Users/tony/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 13 | AC-5 | fails-today | `(no output, exit 1)` | `ok` |
| 13 | AC-6 | fails-today | `0` | `≥ 1` |
| 13 | AC-7 | fails-today | `jq: error: Could not open file scripts/qa/health-baseline.json: No such file or directory` | `0` |

Total ACs: 81.
