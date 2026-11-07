feat(qa): Evidence that names an env file, a production CLI or a live URL is handed to a person — classified in code, listed in the qa prompt as "do not run", recorded per AC in the run log, printed with its command in the run summary

**Epic:** graph-2026-11-simplify   **Tier:** judgment   **Execution:** split   **Blocked by:** #1648 (the qa dispatch site in `batch-executor.ts` and `types.ts` are edited by #1646 to #1648)

- **Blocked by**: #1648

## Problem

D-8: an Evidence line that names an env file, a production CLI or a live URL becomes a pending row with the command shown, run by a person (as #1630 proposes for CI). In E2c (15 sequant runs on a private mirror of a repo that reaches production, 2026-11-02 to 11-03), the phase agents tried to use production credentials in 6 of 15 runs because the issues' Evidence lines named `--env-file=.env.local` and live checks: `npx tsx --env-file=.env.local scripts/dev/query.ts …`, `vercel env ls production`, a read of the main checkout's `.env.local`. A sandbox and absent files stopped every attempt; nothing in sequant did (#1641). The qa skill's §6h runs each Evidence command as written, and the skill is frozen. Founding doc §4, P-8, P-9, OQ-3.

## Decisions

| ID | Decision | Rejected |
|---|---|---|
| E-1 | `classifyEvidenceReach(evidence: string)` in a new `src/lib/evidence-reach.ts` returns `{ reach: "worktree" \| "needs-human", reasons: ("env-file" \| "production-cli" \| "live-url")[] }` by P-9's rules, applied to the backticked command(s) in the clause | a configurable list |
| E-2 | The qa dispatch builds a `promptContext` block listing each needs-human AC with its command and the instruction: do not run it; report the AC as `PENDING` with the command shown, for a person to run. It joins any existing context in the one sentinel block `getPhasePrompt` appends | a second sentinel; a hook (D-5) |
| E-3 | The run log's `acs[]` entry gains optional `reach` and `reachReasons` (I-2: additive, `version: 1`) | a new top-level field |
| E-4 | The run summary prints `AC-N needs a person: <command>` for each needs-human AC, whatever the QA output said | trusting the QA output alone (OQ-3: whether the agent obeys is unverified) |

## Prior fixes / producers

- Consumers of an AC's Evidence: `src/lib/ac-parser.ts` (`splitEvidenceClause`, `resolveVerificationMethod`, `isGateTestEvidence`), `src/lib/ac-linter.ts`, the qa skill's §6h (frozen), `scripts/qa/graph-plan/run-evidence.ts` (plan-time; out of scope). Producers of per-AC status: `src/lib/workflow/ac-status.ts` (#1525). Sibling class: #1630 (CI pending as a pending row). Class: the ACs state the outcome for every AC on every qa dispatch.

## Acceptance Criteria

- [ ] AC-1: The classifier marks `--env-file`, a `.env` path, each listed production CLI and a non-local URL as needs-human, and leaves `npx vitest run …`, a `localhost` URL and a `grep` whose pattern contains `https://` as worktree. Evidence: `npx vitest run src/lib/evidence-reach.test.ts` → `≥ 8 passed, 0 failed`
- [ ] AC-2: The qa prompt for an issue with one needs-human AC carries exactly one sentinel block naming that AC and its command verbatim, and an issue with none gets no reach block. Evidence: `npx vitest run src/lib/workflow/phase-executor.evidence-reach.test.ts` → `≥ 2 passed, 0 failed`
- [ ] AC-3: The run log records `reach` per AC and an old log without it validates. Evidence: `npx vitest run src/lib/workflow/run-log-schema.test.ts -t "reach"` → `≥ 2 passed, 0 failed`
- [ ] AC-4: The run summary prints one `needs a person` line per needs-human AC with its command. Evidence: `npx vitest run src/commands/run-display.test.ts -t "needs a person"` → `≥ 1 passed, 0 failed`
- [ ] AC-5: No skill-directory edits. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

The real-run half (does the agent obey; what verdict results) is #1655 (`Execution: split`, OQ-3, OQ-6).

## May touch

`src/lib/evidence-reach.ts` and test (new), `src/lib/workflow/batch-executor.ts` (the qa dispatch's `promptContext` only), `src/lib/workflow/phase-executor.ts` (`getPhasePrompt` context join only) and `phase-executor.evidence-reach.test.ts` (new), `src/lib/workflow/run-log-schema.ts`, `log-writer.ts`, `ac-status.ts` (the `acs[]` entry only), `src/commands/run-display.ts` and test, `docs/reference/run-command.md` (one paragraph), CHANGELOG.

## Non-Goals

- The qa skill's §6h text (frozen; §10), the verdict rules, `buildQaVerdictComment` (#1605).
- `run.denyPaths` and the README security section (#1641, #1028).
- Blocking the commands in a hook (D-5).

## Done when

Every qa dispatch tells the agent which Evidence lines are a person's to run, and the run log and summary name them, for every issue.
