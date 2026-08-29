# QA Verdict → Workflow State Reference

Each QA verdict maps to an `IssueStatus` that controls whether a subsequent
run skips the issue or proceeds.

## Verdict → State Table

| QA Verdict | `IssueStatus` set | Re-run without `--force`? | Notes |
|---|---|---|---|
| `READY_FOR_MERGE` | `ready_for_merge` | No | PR is ready; merge it. |
| `AC_MET_BUT_NOT_A_PLUS` | `ready_for_merge` | No | Meets ACs; polish skipped. |
| `NEEDS_VERIFICATION` | `awaiting_verification` | **Yes** | Human must execute ACs first; qa re-run then proceeds automatically. |
| `AC_NOT_MET` | `in_progress` | Yes | Fix the code and re-run. |

## Status Descriptions

**`ready_for_merge`** — All required ACs passed. The run guard treats this as
complete; a re-run requires `--force`. Create or review the PR and merge.

**`awaiting_verification`** — QA reasoning succeeded but AC execution was not
witnessed (vendor APIs, integration steps, or other runtime checks). A human or
orchestrator must run the ACs against real dependencies. After doing so, invoke
`sequant run <N> --phases qa` — no `--force` needed. The run guard does not
block this status.

**`in_progress`** — One or more ACs failed. Continue the fix loop with
`sequant run <N>`.

## Re-run Behavior

The run guard in `run-orchestrator.ts` blocks issues whose status is in
`COMPLETED_ISSUE_STATUSES` (`completed-status.ts`). `awaiting_verification` is
intentionally absent from that set, so a bare `sequant run <N> --phases qa`
proceeds without `--force`.

## MCP `sequant_run` — `force` Parameter

Pass `force: true` to override the skip-guard for any completed status:

```json
{"issues": [16], "phases": "qa", "force": true}
```

This mirrors the CLI `--force` flag and is the correct way to re-run a
`ready_for_merge` issue via MCP without hand-editing `state.json`.
