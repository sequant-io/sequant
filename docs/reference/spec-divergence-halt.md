# Spec-Divergence and Repeat Halts

Two halts stop a run and hand the issue to a human instead of spending more retries on it:

- **`SPEC_DIVERGENCE`** — an agent declares an acceptance criterion impossible as written. The run halts at once.
- **`AC_NOT_MET_REPEATED`** — QA rejects the work twice in a row in the quality loop. The loop halts before it spends another fix pass.

Both halts print an evidence bundle, record it in the run log, and end the run without merging. Neither discards work already committed in the worktree. They follow the same "surface and halt, preserve partial work" shape as the turn-cap (#739) and billing-window (#799) halts. Neither needs any configuration.

> **Removed in 3.0 (#1647):** the model ladder and effort escalation, with their settings keys and CLI flags, are gone (see the [CHANGELOG](../../CHANGELOG.md)). The ladder-only `DIVERGENCE_SUSPECT` and `TOP_OF_LADDER` halts went with them. Run logs written before 3.0 may still carry those halt reasons and escalation fields; they still load. A settings file that still sets either key loads with one warning per key, and the key is ignored.

## `SPEC_DIVERGENCE` — the escape hatch

An agent that finds an acceptance criterion impossible as written declares it and stops, rather than guessing at what was meant or implementing the half it can. The declaration channel is the ordinary `SEQUANT_PHASE` marker:

```markdown
<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2026-09-08T12:00:00.000Z","outcome":"SPEC_DIVERGENCE","divergenceAcs":"AC-2","error":"AC-2 requires the file to both exist and not exist"} -->
```

`SPEC_DIVERGENCE` is terminal: no cold-start retry or MCP fallback re-dispatches the phase, and the quality loop does not spawn `/loop`. A retry cannot un-contradict a spec, and neither can a stronger model — it rediscovers the contradiction more slowly and at a higher price.

The `/exec` and `/loop` skills tell agents when to emit it — and, just as importantly, when not to. It means *no implementation can satisfy this as written*. Work that is merely hard, underspecified, or blocked on a dependency is not divergence.

A run that halts on `SPEC_DIVERGENCE` opens no PR (see [Run PR creation](../features/run-pr-creation.md)).

## `AC_NOT_MET_REPEATED` — repeated refusal

Two consecutive `AC_NOT_MET` QA verdicts stop the quality loop before the next `/loop` fix pass, even when iterations remain (#1646). One fix pass after a refusal is allowed; a second pass after a second refusal is not spent. Any other verdict, or a QA pass with no parsed verdict, resets the count. `--max-iterations` still defaults to 3.

The issue fails with category `ac_not_met_repeated`. Its `abortReason` starts with `ac_not_met_repeated` and names both SHAs and the failed AC ids. The halt applies to `sequant run` and MCP `sequant_run`; the `--ready-gate` loop is unchanged. See [Run Command → Quality loop](run-command.md).

## The evidence bundle

Every halt prints a bundle so the handoff is adjudicable without replaying the run:

```
Ladder halt: SPEC_DIVERGENCE — issue #995, phase 'exec'
  Why: the agent declared the spec impossible as written — no model rung was spent
  Declared impossible: AC-2
  Agent message: AC-2 requires the file to both exist and not exist
  SHAs tried: (none recorded)
  Iterations:
    (none recorded)
  Escalation history:
    (empty — no model rung was spent)
  Next step: Reconcile the acceptance criteria with the repository as it exists, then re-run. A stronger model cannot resolve a contradiction in the spec.
```

An `AC_NOT_MET_REPEATED` bundle opens with `Quality loop halt:` and lists one iteration per verdict, each with its `failed=` AC ids.

The halt is also recorded, not only printed (#1254):

- **Issue result and run log:** an `evidenceBundle` with the halt reason, an `abortReason`, and a failure category. A `SPEC_DIVERGENCE` halt keeps the category `ladder_halt` and an `abortReason` such as `ladder halt: SPEC_DIVERGENCE in exec (AC-2)`; the names stay for run-log compatibility.
- **State:** a phase that declared `SPEC_DIVERGENCE` reads `failed`, with `outcome` and `divergenceAcs`, even when the agent exited cleanly.
- **MCP:** the `sequant_run` result names `haltReason`, `declaredAcs` and `abortReason` for the issue (see [MCP Server → `sequant_run`](../features/mcp-server.md#sequant_run)).

Under `sequant ready`, a `SPEC_DIVERGENCE` bundle is embedded in the gap report, and the gate terminates with stop reason `SPEC_DIVERGENCE` and issue status `blocked`.

## Related

- [Run Command](run-command.md) — the quality loop and `--max-iterations`
- [Per-Phase Model & Effort](run-command.md#per-phase-model--effort) — choose a model or effort per phase up front
- [`sequant ready`](ready-command.md) — the gate path, where `SPEC_DIVERGENCE` terminates the report
