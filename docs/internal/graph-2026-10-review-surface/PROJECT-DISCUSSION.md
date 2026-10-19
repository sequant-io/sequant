# graph-2026-10-review-surface — founding document

**Status:** approved and filed 2026-10-18 as #1523 (tracker) and #1524–#1529; #1520 and #1521 joined with the label and Epic line. Decisions taken at defaults: RD-1 90% on the 49 comments, OQ-2 USD with the estimate wording, OQ-3 `init` writes when absent, OQ-4 launch after #1502, OQ-5 the #1507 golden-run testbed; unfolded. Phase-0 measurements below were taken on `main` 96990daab and this checkout's `.sequant/` files on 2026-10-18.

## §1 Vision

The GTM brief's cold reader named four things a reviewer of an agent PR wants and does not get: the per-criterion verdict as the first thing seen, the cost of a run, a way to know who reviewed, and a copyable shape for issues. The product has the data for three of them and renders none of it. This graph makes the acceptance criterion the unit the product shows everywhere a human looks, from the issue form in, to the terminal, `status`, the run log and the PR comment out, with one producer per fact and no narrative.

## §2 MVP (one sentence)

The smallest set of changes after which a `sequant run` ends with, on the terminal and in the run log, one line per acceptance criterion (met, not met, pending, unknown, with its evidence) and one cost line per run, `sequant status` shows met-over-total per issue, every verdict comment names its reviewer, every PR carries a computed "Read first" comment, and `init` offers the issue form that makes criteria parseable — with human approval at exactly: every merge (stop-at-PR), the parser-or-marker decision (RD-1), and the first real run's read (RS-06).

Includes: RS-01 parse-coverage spike with a committed fixture; RS-02 AC-status producer; RS-03 renderers; RS-04 cost surfacing; RS-05 issue form from `init`; RS-06 first real use; #1521 and #1520 as filed.

## §3 Non-goals

| Not in this graph | Why not now |
|---|---|
| Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` | plugin freeze (I-1); the `SEQUANT_AC` marker in the QA skill is §10's first post-freeze item |
| New commands or flags | 33 commands and 152 flags are already the newcomer's obstacle (#1501 §4); every surface here replaces or extends an existing line |
| A narrative review summary by any agent | the brief's audience distrusts the author's summary; #1520 forbids narrative by design |
| Changing which driver runs QA by default | owner's settings choice; #1521 documents the knob |
| The progress mod's AC view | the mod lives outside the repo and is a personal tool |
| Rendering the AC table in `/qa` chat output | skill prose, frozen |
| Billing-accurate cost | metrics carry the SDK's estimate; every display says so (I-7) |
| Launching before fundamentals W0 lands | WIP limit, #1501 D-1 |

## §4 Architecture as observed (2026-10-18)

| Fact | Observed | Consequence |
|---|---|---|
| Per-AC state record | `state-schema.ts` has `AcceptanceCriterionSchema` (`id, description, verificationMethod, status, verifiedAt, notes, evidence`); in this checkout 2 of 25 tracked issues carry a record, 17 items, all `pending` | written at registration, never updated |
| Its updater | `StateManager.updateACStatus(issueNumber, acId, status, …)` exists; **no caller** outside the class | the producer node calls it (RS-02) |
| QA phase output | `parseQaSummary` (phase-executor.ts:615) yields counts, gaps, findings, suggestions; no per-AC statuses. `buildQaVerdictComment` (batch-executor.ts:886) posts the verdict. The QA skill emits only a `SEQUANT_PHASE` marker; per-AC lines are free-form (tables or lists) | per-AC status must be parsed from prose or emitted by the skill after the freeze |
| Per-AC parse coverage | 4 recent issues with a QA comment, 24 ACs, 23 matched by `AC-N … (MET\|NOT MET\|PENDING\|✅\|❌\|⚠)` (96%); sample too small to decide. 49 QA-marked comments exist since 2026-08-01 | RS-01 measures on all of them (49 at planning) with a committed fixture; RD-1 sets the threshold |
| Evidence attribution | 149 of 258 ACs on the 80 most recently closed issues name a file or command in `Evidence:` (58%) | #1520's "explained" partition; unattributed → residue |
| Cost and tokens | `.sequant/metrics.json`: 420 runs, 154 with `metrics.costUSD` (sum $935.69), 157 with `tokensUsed`; last run $6.45 / 69,641 tokens for 3 issues; `sequant stats` already prints a phase × model cost table labelled "SDK estimate, not a billing statement" | cost is captured **per run** (`issues: number[]`, one `costUSD`, plus `phaseUsage` by phase × model); it is not in the run summary, run log or `sequant logs` (RS-04). Per-issue cost is not attributable today, so `cost` is a run-level field. The #943 demo run has no cost record |
| Run summary input | `IssueSummary {issueNumber, success, durationSeconds, phases[], prNumber, prUrl, qaVerdict, unmetCount, …}` | gains `acs[]` and `cost` (RS-03, RS-04) |
| `sequant status` | a table: Issue, Title, Status, Phase | gains an `ACs` column (RS-03) |
| Run log | `version: 1`; optional fields keep it (schema's own comments) | `acs[]` and `cost` land as optional (I-3) |
| Issue form | `docs/guides/writing-issues.md` already contains the YAML form under "Optional: a GitHub issue form"; `init` writes nothing under `.github/`; this repo's own templates are YAML forms | RS-05 moves the form to one template file the guide and `init` both use |
| Verdict attribution | the phase record has `requestedModel`/`resolvedModel`; per-phase `agent`/`model` overrides exist (#914, #1150); the comment names neither | #1521 as filed |
| File scopes in flight | `phase-executor.ts` is #1471's; `batch-executor.ts` is #1507's split target and holds `toIssueSummary`, which assembles the run summary input (`run-display.ts` passes it to `renderSummary`); `log-writer.ts` and `run-log-schema.ts` are #1504's | RS-02 hooks from a sibling module with one call line and lands after #1504, #1471, #1507; RS-04 and RS-03 add their summary fields in `toIssueSummary`, so both wait for #1507 |
| Platform | PR comments through `PlatformProvider.postPRComment`; no CI changes in this graph; label `graph-2026-10-review-surface` does not exist (tracker creates) | — |

## §5 Invariants

- **I-1** No edit under `plugin/`, `.claude/skills/`, `templates/skills/`.
- **I-2 One producer per fact.** AC status is written once, by RS-02, through `updateACStatus`; renderers read the record and never re-parse prose. Cost is read from the metrics writer's record; nothing recomputes it.
- **I-3 Additive schemas.** `acs[]` and `cost` are optional fields; `run-log-schema.ts` stays `version: 1`; `state-schema.ts` adds no required field.
- **I-4 No new commands or flags.** Each surface replaces or extends a line that already prints.
- **I-5 Measure before parse.** RS-02 does not start until RS-01's coverage number and RD-1 are on the tracker.
- **I-6 Stop-at-PR**; the owner consents per merge.
- **I-7** Every cost display carries "SDK estimate, not a billing statement", the wording `sequant stats` already uses.
- **I-8 Unknown is a status.** An AC the producer cannot classify is rendered `unknown`, never omitted and never defaulted to met.
- **I-9 Silent writes are counted.** RS-02's state write goes through the #1504 helper when it fails, so a lying table is at least a counted one.

## §6 Per-node design

| Node | Inputs | Outputs | Failure modes | Done when |
|---|---|---|---|---|
| T tracker | this directory | docs-only PR, label, RD-1..RD-4 recorded | — | directory on `main`, label exists |
| RS-01 parse-coverage spike | ≥ 60 QA verdict comments from closed issues; 10 hand-labelled fixtures | `scripts/qa/ac-status-parse-coverage.ts`, `__tests__/fixtures/qa-comments/` with `expected.json`, `docs/evidence/review-surface/ac-parse-coverage.md` | the parser over-matches (an AC id mentioned in prose with a stray MET) → the fixture's ground truth catches it | coverage number and RD-1 line on the tracker |
| RS-02 AC-status producer | the QA phase output at the existing hook, the issue's parsed ACs | `src/lib/workflow/ac-status.ts` (pure parse + one `updateACStatus` call per AC), run-log `acs[]` | a status for an AC that is not in the issue (ignored, counted); write failure (I-9) | the state record changes after a QA phase on a real temp state file |
| RS-03 renderers | the AC record, the run log | terminal summary lines per AC; `status` column; `sequant logs` block | renderer re-parses prose (forbidden, I-2) | all three surfaces show the same record |
| RS-04 cost surfacing | `metrics.json` run record | summary line; run-log `cost`; `sequant logs` line | a run without a metrics record → `cost unrecorded`, never `$0.00` | three surfaces, one source |
| RS-05 issue form from `init` | the guide's YAML | `templates/github/ISSUE_TEMPLATE/sequant-task.yml`; `init` writes `.github/ISSUE_TEMPLATE/sequant-task.yml` when the directory is absent; the guide links the template; `doctor` info line | overwriting a user's template (never: skip when the directory exists) | a fresh `init --yes` leaves the form in place |
| #1521 attribution | as filed | as filed | — | as filed |
| #1520 review by exception | as filed; lands after #1507 | as filed | — | as filed |
| RS-06 first real use | a testbed run after RS-02/03/04 merge | captured terminal, `status`, `logs` output and the run log, read by the owner | the table and the verdict comment disagree → reopen RS-02 | the owner's read is on the tracker |

## §7 Decisions

| ID | Decision | Rejected alternatives |
|---|---|---|
| RD-A | AC status comes from the QA phase output at the existing summary hook, parsed by a fixture-tested function with `unknown` as a status | a `SEQUANT_AC` marker now (frozen skill); an LLM extraction (same-model, unfalsifiable); the issue's checkboxes (written by the author) |
| RD-B | RS-01 gates RS-02 with a number: parser ships if ≥ 90% of ACs across all QA-marked comments since 2026-08-01 (49 at planning) are classified against the fixture's truth; below that, RS-02 ships with `unknown` as the common case and the marker becomes the first post-freeze node | ship the parser blind (the 2026-09-30 re-patch pattern) |
| RD-C | Cost is the metrics writer's `costUSD`/`tokensUsed`, surfaced, with the stats wording | recompute from the SDK result (a second producer) |
| RD-D | The issue form lives in one template file; the guide links it; `init` copies it | the guide and `init` each carry a copy (shared-file ownership failure) |
| RD-E | The terminal AC lines replace the phase line in the per-issue summary; phases move to `logs` | add the table behind a flag (I-4) |
| RD-F | Renderers read the state record and the run log only | renderers parsing the verdict comment (two parsers drift) |
| RD-G | #1520 and #1521 join as filed, no AC rewrites | retrofitting them (their ACs already run as written) |

## §8 Conventions

As #1501's §8: metadata line, `- **Blocked by**:` items, Evidence per AC, prior-fixes block, May touch, Non-Goals, Done when; placeholders `#RS-NN`; stop-at-PR; tiers `mechanical` / `judgment` / `split`. Shared merge-point files: `run-log-schema.ts` and `log-writer.ts` (optional fields only, one block per node, after #1504's), `run-renderer-types.ts` (one optional field per node), `src/commands/logs.ts` (one block per node, after #1471 and #1505). Cluster: **log/renderer** RS-04 → RS-03 (same files; RS-04 is smaller and lands first).

## §9 Open questions and owner gates

| OQ | Question | Resolves in | Default |
|---|---|---|---|
| RD-1 (OQ-1) | Parser threshold | RS-01 report on the tracker | 90% on all QA-marked comments since 2026-08-01 (49 at planning) |
| OQ-2 | Show USD by default on the terminal, or tokens only with USD in `logs`? | RS-04 | USD with the estimate wording |
| OQ-3 | `init` writes the form by default when `.github/ISSUE_TEMPLATE/` is absent, or asks? | RS-05 | writes, prints one line; `--yes` writes |
| OQ-4 | Launch gate | T | after #1501 wave 0 (#1502) merges; after #1504 for RS-02 |
| OQ-5 | Testbed for RS-06 and whether the video's measured cost comes from that run | RS-06 | the same testbed issue as #1507's golden run. Gate-1 (2026-10-18) decided the video's comment capture waits for #1521 and re-takes on an issue with at least one manual or browser AC, so #1521 is on the video's path and leads W0; run 943's cost was measured by hand from phase transcripts at about $2.80 list, which RS-04 would have printed |

## §10 After this graph (post-freeze)

The `SEQUANT_AC` marker in the QA skill (one line per AC, machine-anchored like `SEQUANT_MUTATION`), which retires RS-02's prose parse; the "Read first" partition at the top of the PR body (#1520 R-1); the AC table in the progress mod.
