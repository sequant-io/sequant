# Issue graph: graph-2026-10-fundamentals

**Status:** Planned 2026-10-18; owner approved the plan the same day; **filed 2026-10-18** as #1501 (tracker) and #1502–#1513 in numeric order (`F-10` removals stays unfiled until D-2). The issue bodies on GitHub are canonical; `issues/<N>.md` is the as-filed snapshot. Launch waits for #1470 to close (D-1 default, OQ-1).
**Founding doc:** `PROJECT-DISCUSSION.md` (cited as §N). **Tracker:** #1501. **Measurement script:** `fnlen.mjs` (this directory; `node docs/internal/graph-2026-10-fundamentals/fnlen.mjs` from the repo root). **Source reports:** five session assessments (orgs research, AI-quality evidence, surface-usage audit, testing research, fix-seam audit) kept in the planning session's scratchpad, not in the repo; the plan cites their numbers and re-measures every one it gates on.

## Nodes

| Node | Tier | Execution | Title | Blocked by | May touch | Cluster |
|---|---|---|---|---|---|---|
| #1501 | judgment | runner | tracker; docs-only PR landing this directory; label; D-1..D-6 recorded | #1470 | `docs/internal/graph-2026-10-fundamentals/` | — |
| #1502 | mechanical | sequant_run | `scripts/qa/health-report.ts` + baseline + advisory job + release-checklist line | #1501 | `scripts/qa/`, `ci.yml`, `package.json`, `release-checklist.md` | ci |
| #1503 | mechanical | sequant_run | end the 2026-01 lint relaxation; knip advisory with numeric baseline | #1502 | `eslint.config.js` (relaxed block), `knip.json`, `package.json`, `ci.yml`, `health-report.ts` | ci, eslint |
| #1504 | judgment | sequant_run | `noteSuppressed()` + run-log `suppressed` field; batch-executor's 25 catches converted; fault injection | #1502 | `suppressed.ts` (new), `log-writer.ts`, `run-log-schema.ts`, `batch-executor.ts` (catch bodies only) | batch-executor |
| #1505 | mechanical | sequant_run | remaining ~94 catches; empty-catch selector at `error`; `sequant logs` line | #1504, #1471 | ~40 files, `eslint.config.js` (append), `commands/logs.ts` | eslint |
| #1506 | judgment | sequant_run | all `gh` through `PlatformProvider`; `FakeGitHubProvider` + captured fixtures; capture script | #1504 | `platforms/*`, `batch-executor.ts` (:328/:388 helpers), `chain-preflight.ts`, `merge-check/report.ts`, 6 tests | batch-executor |
| #1507 | judgment | split | split `runIssueWithLogging` (1,049 counted) to ≤ 200; golden run | #1506 | `batch-executor.ts` (+ new siblings) | batch-executor |
| #1508 | judgment | split | split six workflow functions to ≤ 200; `max-lines-per-function` for `src/lib/workflow`; golden run | #1471, #1475, #1507 | `run-orchestrator.ts`, `worktree-manager.ts`, `phase-executor.ts`, `ready-gate.ts`, `drivers/claude-code.ts`, `eslint.config.js` (append) | eslint |
| #1509 | mechanical | sequant_run | split five command functions to ≤ 200; rule for `src/commands` | #1502 | `commands/{init,doctor,sync,update,ready}.ts`, `eslint.config.js` (append) | eslint |
| #1510 | mechanical | sequant_run | `@deprecated` names `remove in vX.Y`; `lint:deprecations`; CONTRIBUTING | #1503 | `scripts/lint-deprecations.ts`, 18 tag lines, `package.json`, `ci.yml`, `CONTRIBUTING.md` | ci |
| F-10 (unfiled) | mechanical | sequant_run | remove what D-2 names, one PR per cluster (**not filed until D-2**) | #1510, D-2 | per cluster | — |
| #1511 | judgment | sequant_run | classify the 76 prose-gate files (execute / checksum / keep) with commands | #1502 | `prose-gates.md` (new) | — |
| #1512 | judgment | sequant_run | convert execute-class gates, delete checksum-class per D-3 | #1511, D-3 | the listed test files, fixtures | — |
| #1513 | judgment | split | postmortem template; D-5 incidents; ADR authority + `lint:adr-status` (owner reclassifies) | #1501 (D-4, D-5) | `docs/incidents/`, `docs/adr/README.md`, 11 ADR status lines, `scripts/lint-adr-status.ts`, `ci.yml` | ci |

```mermaid
graph TD
    C[#1470 consolidation closes]
    T[#1501 tracker + docs PR]
    N1[#1502 health report + baseline]
    N2[#1503 lint relaxation ends + knip]
    N3[#1504 suppressed-error trace]
    N4[#1505 remaining catches + lint + logs line]
    N5[#1506 gh seam + fake provider]
    N6[#1507 split runIssueWithLogging]
    N7[#1508 split workflow functions + ratchet]
    N8[#1509 split command functions]
    N9[#1510 deprecation lifecycle]
    N10[F-10 (unfiled) removals, D-2]
    N11[#1511 prose-gate audit]
    N12[#1512 prose-gate conversion, D-3]
    N13[#1513 incidents + ADR authority, D-4/D-5]
    X1[#1471 log helpers]
    X5[#1475 worktree status]
    C --> T
    T --> N1
    T --> N13
    N1 --> N2
    N1 --> N3
    N1 --> N8
    N1 --> N11
    N2 --> N9
    N3 --> N4
    X1 --> N4
    N3 --> N5
    N5 --> N6
    N6 --> N7
    X1 --> N7
    X5 --> N7
    N9 --> N10
    N11 --> N12
```

## Waves

| Wave | Nodes | Condition |
|---|---|---|
| W0 | #1501, then #1502 + #1513 (parallel; #1513 waits on D-4/D-5) | #1470 closed |
| W1 | #1503, #1504, #1509, #1511 (parallel; distinct file scopes) | #1502 merged |
| W2 | #1505 (after #1471), #1506, #1510, #1512 (after D-3) | #1504, #1503, #1511 merged respectively |
| W3 | #1507, then #1508 (after #1471 and #1475) | #1506 merged |
| W4 | F-10 (unfiled) per cluster | D-2 answered; skills cluster after the freeze lifts |

One `sequant run` per wave for the parallel nodes (D-8 of the consolidation graph: avoid the worktree-add race until #1469's fix is in the running release).

**Critical path:** #1470 → #1501 → #1502 → #1504 → #1506 → #1507 → #1508 (seven merges, the last also behind #1471 and #1475).

**Clusters (serialize, §8):** batch-executor: #1504 → #1506 → #1507. eslint.config.js: #1503 → #1505 / #1508 / #1509 (each appends one block; parallel only if the runner rebases before opening the PR). ci.yml / package.json: #1502 → #1503 → #1510 → #1513 (append-only, one line or job each).

## Counts

- Files here: 14 (#1501..#1513). Filed at launch: 13; F-10 (unfiled) files when D-2 answers, once per cluster.
- Folds available at review (OQ-7): #1505 into #1504 (one bigger judgment node, loses the #1471 decoupling), #1509 into #1508 (loses W1 parallelism). Folded: 12 at launch.
- Open backlog at planning: 66.

## Anti-gap passes (2026-10-18)

1. **Journey walk** (owner's journey after the graph): open a PR → `health-advisory` reports any raised metric (#1502) → lint rejects an empty catch (#1505), a function over 200 lines in workflow/commands (#1508/#1509), an unversioned deprecation (#1510), a bare ADR status (#1513) → `sequant logs` shows dropped-error counts (#1505) → a `gh` failure in a test is a fixture (#1506) → release checklist reads the report (#1502). Every step has exactly one owner. Gap found and closed: "who shows the count" was unowned because `commands/logs.ts` is #1471's; assigned to #1505 after #1471.
2. **Artifact walk:** `health-baseline.json` (owner #1502; regenerated only via `--write-baseline`, I-4; failure mode: a PR raises a metric → advisory fails, blocking after W2). `suppressed` field (owner #1504; failure: schema version bump → AC-3 forbids). `__fixtures__/gh/*.json` (owner #1506; failure: drift → re-run the capture script, D-G). `prose-gates.md` (owner #1511; consumed by #1512). `docs/incidents/TEMPLATE.md` (owner #1513). Each has one owner and a named failure mode.
3. **Producer/consumer:** every number an AC reads is produced by #1502 (consumers: #1504, #1505, #1506, #1507, #1508, #1509, #1510, #1512, #1513). D-2, D-3, D-5 are human-produced inputs (flagged: F-10 (unfiled), #1512, #1513 cannot launch without them). The golden-run files `$BEFORE`/`$AFTER` are runner-produced (#1507, #1508; OQ-8 names the testbed).
4. **Shared-file format ownership:** `eslint.config.js` — one appended block per node, never edit another node's block (#1503 edits only the pre-existing relaxed block). `ci.yml` — one job per node, appended after `tautology-advisory`. `package.json` scripts — one line per node. `health-baseline.json` — #1502's format; others regenerate, never hand-edit. No committed copy of anything deployed elsewhere is touched (no routine prompts, no hosted config).
5. **First-episode dry run:** #1501 docs PR lands; owner answers D-1..D-6 on the tracker. #1502 runs under `sequant run`: exec writes the script, test, baseline, job, checklist line; QA runs AC-1..AC-6 verbatim (AC-2's `diff` needs the baseline generated on the PR's own tree, so exec regenerates it after the last source change — noted in the body's I-4 line). #1513 is split: exec writes the template, README rule and lint; the owner edits the 11 statuses and names incidents; QA runs AC-5 after. W1 in one `sequant run`: #1503 (touches `health-report.ts` for the knip key — same file as #1502's, already merged), #1504, #1509, #1511. #1504's QA needs the integration project for the chmod test (30 s timeout) — the new file is named `*.suppressed.test.ts`, not `*.integration.test.ts`; **gap**: vitest project membership is by `.integration.` in the filename (memory `reference_vitest_project_membership_timeout`), so #1504's AC-5 file must be `batch-executor.suppressed.integration.test.ts` — **fixed in the body** (and in #1507 AC-3, which runs it). W2: #1505 waits for #1471 (consolidation), which is itself gated on #1370 and 2.20.0 — so W2 may stall; #1506, #1510, #1512 do not wait and proceed. W3: #1507 golden run needs two `sequant run` invocations on the testbed (credits, OQ-8). Nothing in the narrative lacks an owning node.

**Reachability:** every node is on a path to the MVP (§2): #1502/#1503 are the baseline and ratchet infrastructure; #1504..#1510 set each ratchet at zero; #1511/#1512 the prose-gate number; #1513 the knowledge-location and ADR numbers; F-10 (unfiled) is the one deliberate exception (owner-gated, value only if D-2 names something).

## Phase-0 record

- Every Evidence command was run on `main` 96990daab on 2026-10-18; `phase0-evidence.md` lists each with its classification (fails-today / constraint / not-runnable-at-plan-time) and the observed output. Spot values: #1503 AC-1 → 3; #1506 AC-1 → 3, AC-4 → 6; #1507 AC-1 → 1; #1508 AC-1 → 7; #1509 AC-1 → 5; #1510 AC-2 → 18.
- `parseAcceptanceCriteria` parses every AC with an `Evidence:` clause (81 ACs across 14 files); `## Non-Goals` present in all; `- **Blocked by**:` list items present in all. `isGateTestEvidence` flags six ACs; each body names them and the mutation record they carry.
- Platform contract: `main` ruleset requires `test` + `canary` only; advisory jobs cannot block. Actions token is read-only (`default_workflow_permissions: read`, cannot approve PRs); no node opens PRs from Actions. Label missing (tracker creates).
- ESLint selector `CatchClause > BlockStatement[body.length=0]` probed: flags comment-only catches; `no-empty` does not.
- Scratchpad loss: the five source reports were cleaned overnight; four were recovered in full from the subagent transcripts and one (fix-seam-audit) from a line-numbered read in the main transcript. They stay outside the repo (agent transcripts are treated as secret-bearing). The fnlen script was re-created. All numbers in this plan were re-measured today, not copied.

## Placeholder map (as filed 2026-10-18)

| Placeholder | Issue |
|---|---|
| #1501 | #1501 |
| #1502 | #1502 |
| #1503 | #1503 |
| #1504 | #1504 |
| #1505 | #1505 |
| #1506 | #1506 |
| #1507 | #1507 |
| #1508 | #1508 |
| #1509 | #1509 |
| #1510 | #1510 |
| #1511 | #1511 |
| #1512 | #1512 |
| #1513 | #1513 |
| F-10 (unfiled) | unfiled until D-2 (template: `issues/10-removals.md`) |
