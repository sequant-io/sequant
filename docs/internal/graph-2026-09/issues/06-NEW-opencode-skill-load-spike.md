# 06 — NEW spike: does `opencode run --command <phase>` load the sequant skill? (resolves OQ-8, OQ-9)

**Epic:** M0   **Blocked by:** —   **Tier:** judgment   **Doc:** PLAN §4 (opencode seam), §5 I-3, I-8, §7 D7, §9 OQ-8/OQ-9, Lab §1

## Why
#862's stated load-bearing unknown (Risk 1) is whether the model actually
loads `.claude/skills/<phase>/SKILL.md` when a `.opencode/commands/<phase>.md`
wrapper asks it to. The 09-03→06 field run proved transport, not skills. The
driver (node 12) must be built against an observed contract and a recorded
fixture, not an imagined one.

## Scope
- may touch: `docs/investigations/opencode-driver-spike.md`, `src/lib/workflow/drivers/__fixtures__/opencode-run-*.ndjson` (recorded real output, secrets scrubbed), a throwaway scratch worktree of this repo (deleted before the PR)
- not in scope: any `src/` change; any driver code; the hook shim.

## Preconditions
- AC-0: an opencode provider key is present in the environment — Verify: `opencode --version` → `1.18.27` or newer, and the spike doc records the model id used and its `$` (I-8). Without a key, the node stops and reports; it does not guess.

## Acceptance criteria
- [ ] AC-1: skill-load observed or refuted — Verify: `grep -cE 'SEQUANT_QA_VERDICT|### Verdict' src/lib/workflow/drivers/__fixtures__/opencode-run-qa.ndjson` ≥ 1 for a run of `opencode run --command qa <issue> --format json --auto --dir <scratch worktree>` with a wrapper `.opencode/commands/qa.md` that instructs loading the `qa` skill; if the count is 0 after two wrapper phrasings, the doc's verdict line reads `KILL` and names what the model did instead.
- [ ] AC-2: NDJSON event inventory — Verify: `jq -r '.type' src/lib/workflow/drivers/__fixtures__/opencode-run-qa.ndjson | sort -u` is pasted into the doc and includes at least `text` and `step_finish`; every event type seen has a one-line description of its payload.
- [ ] AC-3: the three field-run traps have a recorded mitigation — Verify: the doc has a table with rows `32K step clamp`, `/tmp permission kill`, `process-group kill`, each with the exact config or spawn option that mitigated it (`OPENCODE_CONFIG_CONTENT` payload; allow rule or scratch relocation; `detached` + group kill) and the command that reproduced it.
- [ ] AC-4: go/no-go posted — Verify: `gh issue view 862 --comments | grep -c 'Spike verdict: GO\|Spike verdict: KILL'` ≥ 1, and the comment lists which #862 P0 ACs change as a result (e.g. reasoning-budget field in `run.opencode`).
- [ ] AC-5: cost recorded — Verify: the doc's cost table has `$` and wall time per run; total under `$5`.

## Done when
#862 has a spike verdict with a committed real NDJSON fixture and a mitigation table, so node 12 can be specified against observed behavior.
