# Issue graph: graph-2026-10-review-surface

**Status:** Planned 2026-10-18, **not filed**; awaiting the owner's plan review. Seeds #1520 and #1521 are already filed and join as filed (RD-G). Placeholders `#RS-NN` become GitHub numbers at filing; one `gh issue edit` pass substitutes them and this file gains the map. Launch waits for #1502 (fundamentals wave 0) per #1501 D-1; RS-02 additionally waits for #1504, #1471 and #1507 by file scope.
**Founding doc:** `PROJECT-DISCUSSION.md` (cited as §N). **Tracker:** #RS-00. **Phase-0 record:** `phase0-evidence.md` (36 ACs: 29 fail today, 6 constraint, 1 not-runnable, 0 pass by accident).

## Nodes

| Node | Tier | Execution | Title | Blocked by | May touch | Cluster |
|---|---|---|---|---|---|---|
| #RS-00 | judgment | runner | tracker; docs-only PR; label; RD-1, OQ-2..5 recorded | #1502 | `docs/internal/graph-2026-10-review-surface/` | — |
| #RS-01 | judgment | sequant_run | per-AC parse coverage on ≥ 60 QA comments; 10 hand-labelled fixtures; RD-1 line | #RS-00 | `scripts/qa/ac-status-parse-coverage.ts`, `__tests__/fixtures/qa-comments/`, `docs/evidence/review-surface/` | — |
| #RS-02 | judgment | sequant_run | AC-status producer: parse at the QA summary hook, `updateACStatus`, run-log `acs[]`, `unknown` is a status | #RS-01, #1504, #1471, #1507 | `ac-status.ts` (new), one call line at the hook, `log-writer.ts`, `run-log-schema.ts` | log |
| #RS-03 | mechanical | sequant_run | AC lines in the run summary; `ACs` column in `status`; block in `logs` | #RS-02, #RS-04, #1505 | `run-renderer-types.ts`, renderers, `commands/status.ts`, `commands/logs.ts`, two docs pages | log, renderer |
| #RS-04 | mechanical | sequant_run | cost line in the summary; run-log `cost`; `logs` line; "SDK estimate" wording | #RS-00, #1504 | `log-writer.ts`, `run-log-schema.ts`, `run-renderer-types.ts`, renderers, `commands/logs.ts`, `run-command.md` | log, renderer |
| #RS-05 | mechanical | sequant_run | `init` writes the issue form from one template file; guide links it; `doctor` info line | #RS-00 | `templates/github/ISSUE_TEMPLATE/sequant-task.yml` (new), `commands/init.ts`, `commands/doctor.ts`, `docs/guides/writing-issues.md` | — |
| #1521 | mechanical | split | verdict comment names reviewer driver + model; docs name `phases.qa.agent` | none (coordinate with #1507) | `qa-verdict-attribution.ts` (new), one call in `buildQaVerdictComment`, `run-command.md` | — |
| #1520 | judgment | split | computed "Read first" PR comment: residue / tests by seam / AC-explained | #1507 (file scope) | `review-residue.ts` (new), one post call, `scripts/qa/ac-attribution-rate.ts`, `residue-outcomes.ts`, `docs/reference/review-residue.md` | — |
| #RS-06 | judgment | runner | first real use: one testbed run; owner reads table vs comment vs cost; reject routes | #RS-03, #RS-04, #1521 | smoke report comment only | — |

```mermaid
graph TD
    F0[#1502 fundamentals W0 merged]
    F4[#1504 suppressed-error trace]
    X1[#1471 log helpers]
    X5[#1505 catches + logs line]
    X7[#1507 split batch-executor]
    T[#RS-00 tracker]
    S1[#RS-01 parse coverage + fixture]
    S2[#RS-02 AC-status producer]
    S3[#RS-03 AC table renderers]
    S4[#RS-04 cost surfacing]
    S5[#RS-05 init issue form]
    A[#1521 verdict attribution]
    R[#1520 Read first comment]
    S6[#RS-06 first real use]
    F0 --> T
    T --> S1
    T --> S4
    T --> S5
    S1 --> S2
    F4 --> S2
    X1 --> S2
    X7 --> S2
    F4 --> S4
    S2 --> S3
    S4 --> S3
    X5 --> S3
    X7 --> R
    S3 --> S6
    S4 --> S6
    A --> S6
```

## Waves

| Wave | Nodes | Condition |
|---|---|---|
| W0 | #RS-00; then #RS-01, #RS-05, #1521 in one `sequant run` | #1502 merged (D-1) |
| W1 | #RS-04 | #1504 merged |
| W2 | #RS-02 | #RS-01's RD-1 line on the tracker; #1504, #1471, #1507 merged |
| W3 | #RS-03, #1520 | #RS-02 and #1505 merged; #1507 merged |
| W4 | #RS-06 | #RS-03, #RS-04, #1521 merged; OQ-5 names the testbed |

**Critical path:** #1502 → #RS-00 → #RS-01 → #RS-02 (also behind #1504, #1471, #1507) → #RS-03 (also behind #1505) → #RS-06. Six merges in this graph, four of them also gated on consolidation and fundamentals nodes.

**Clusters (serialize, §8):** log: #RS-04 → #RS-02 → #RS-03 (`log-writer.ts`, `run-log-schema.ts`, `commands/logs.ts`; optional fields only, one block per node, after #1504's and #1505's). renderer: #RS-04 → #RS-03 (`run-renderer-types.ts`, renderer implementations; one optional field per node).

## Counts

- New files here: 7 (#RS-00..#RS-06). Already filed and joining: 2 (#1520, #1521). Nodes: 9. New issues to file: 7.
- Folds available at review: #RS-04 into #RS-03 (one renderer node, loses W1 parallelism and makes the cost line wait for the producer). Folded: 6 new issues.
- Open backlog at planning: 69 (66 this morning plus #1519, #1520, #1521).

## Anti-gap passes (2026-10-18)

1. **Journey walk** (a reviewer's path): write the issue in the form (#RS-05) → `sequant run` → terminal shows AC lines and the cost line (#RS-03, #RS-04) → `sequant status` shows met-over-total (#RS-03) → the issue's verdict comment names its reviewer (#1521) → the PR carries "Read first" (#1520) → `sequant logs` shows the same AC lines and cost (#RS-03, #RS-04) → human merges. Every step has exactly one owner. Gap found: the status source for the terminal was unowned (nothing updates the record); #RS-01 and #RS-02 own it. Second gap: "who decides parser vs marker" was unowned; RD-1 on #RS-01.
2. **Artifact walk:** the AC record (`state.json`): owner #RS-02; failure: silent write → counted via #1504 (I-9). Run-log `acs[]` and `cost`: owners #RS-02 and #RS-04; optional fields; failure: version bump → AC forbids. `metrics.json` cost: owner `metrics-writer.ts` (unchanged); #RS-04 reads. The form template: owner #RS-05; the guide links, never copies (RD-D). Fixtures `qa-comments/`: owner #RS-01; #RS-02 reads. Verdict comment: owner `buildQaVerdictComment` (#1521 appends one line). PR comment: #1520 (one per PR). Each artifact has one owner and a named failure mode.
3. **Producer/consumer:** #RS-03 consumes #RS-02's record and #RS-04's field. #RS-02 consumes #RS-01's fixture and the QA output at the existing hook. #RS-04 consumes the metrics writer. #RS-06 consumes everything plus a testbed (OQ-5, human-named). RD-1 is a human-produced input (flagged). #1520 consumes `Evidence:` clauses, not the AC record, so it does not wait for #RS-02.
4. **Shared-file format ownership:** `run-log-schema.ts` and `log-writer.ts`: one optional block per node, in the order #1504 → #RS-04 → #RS-02; `run-renderer-types.ts`: one optional field per node, #RS-04 → #RS-03; `commands/logs.ts`: one block per node after #1471 and #1505. No committed copy of anything deployed elsewhere is touched; the template file is new and single-sourced.
5. **First-episode dry run:** #RS-00 lands docs, label, decisions. W0 in one `sequant run`: #RS-01 (reads comments, writes fixtures and a script; QA runs AC-2 against live `gh`, which needs auth in the phase — the same condition #1519 and the stranger smokes already assume), #RS-05 (init step + doctor line + guide edit), #1521 (one appended line). **Gap:** #RS-01's AC-5 blind re-read is a human step inside a `sequant_run` node; exec cannot do it. Stamp #RS-01 `split`: phases write the script, fixture and report; the owner adds the re-read line. **Fixed in the node table below the dry run** (Tier stays judgment; Execution → split). W1: #RS-04 after #1504 — its `logs.ts` block waits for #1505 if that lands later; the body already says so. W2: #RS-02 touches the hook; if #1507 has moved the QA summary hook out of batch-executor, the one-line call goes in the new module; the body names both. W3: #RS-03 and #1520 in one run; distinct files. W4: #RS-06 by the runner, detached launch (#856). Nothing in the narrative lacks an owner.

**Correction from the dry run:** #RS-01 Execution is `split`, not `sequant_run` (the blind re-read is the owner's). The issue body is updated to match.

**Reachability:** every node is on the path to the MVP sentence in §2: #RS-01 → #RS-02 → #RS-03 are the AC lines; #RS-04 the cost line; #RS-05 the form; #1521 and #1520 the comment surfaces; #RS-06 the first real use. No deliberate exceptions.

## Phase-0 record

- Measured on this checkout 2026-10-18: AC record 2 of 25 issues, 17 items all `pending`; `updateACStatus` no callers; per-AC parse 23 of 24 on 4 issues (too small; #RS-01 measures); Evidence names a path for 149 of 258 ACs (58%); metrics 154 of 420 runs with cost, $935.69 total, last run $6.45 / 69,641 tokens / 3 issues; `sequant stats` already has the cost table and wording; the #943 demo run has no cost record (the video's cost number must come from a new run, OQ-5).
- Every Evidence command in `issues/` run on `main` 96990daab: 36 ACs, 29 fail today, 6 constraint, 1 not-runnable (the runner's `$RUNLOG`), 0 pass by accident. Six ACs are gate-classified by `isGateTestEvidence`; each body names them with the mutation they carry.
- Platform: no CI change, no PR from Actions; the label `graph-2026-10-review-surface` does not exist (tracker creates). PR comments go through `PlatformProvider.postPRComment` (merge-check precedent; #1506 consolidates).
- File-scope collisions checked against #1471 (`phase-executor.ts`, `commands/logs.ts`), #1504 (`log-writer.ts`, `run-log-schema.ts`), #1505 (`commands/logs.ts`), #1507 (`batch-executor.ts`): every touching node waits for the owner of that file.
