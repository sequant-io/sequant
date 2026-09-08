# Model Escalation Ladder

**Default: off** (#971/#995). No ladder is configured unless you configure one, and a run without one behaves exactly as it did before this feature existed — no extra `git` calls, no extra state, no changed output.

When a workflow keeps failing, the tempting fix is "throw a stronger model at it." That is right about half the time and expensive the other half. The model ladder exists to tell those halves apart *from evidence the run already produced*, spend the cheap rung first, and — the part this page is really about — **stop and ask a human** when a stronger model provably cannot help.

## Capability-bound vs. spec-bound

This distinction is the whole design. Two failing loops can look identical from the outside and need opposite remedies.

| | **Capability-bound** | **Spec-bound** |
|---|---|---|
| What you see | The agent produces **nothing** — no commits, no working-tree change — iteration after iteration | The agent produces a **new diff every iteration**, and QA keeps rejecting it |
| What it means | The model cannot construct a working change for this task | The criteria contradict themselves, or contradict the repository |
| Right remedy | A stronger model | A human, re-specifying |
| What `modelLadder` does | Escalates one rung | **Never escalates.** Halts with an evidence bundle |

The second row is why the ladder is not simply "retry harder." A stronger model handed a self-contradictory acceptance criterion does not resolve it — it rediscovers the contradiction, more slowly and at a higher price per token, and then fails in the same place. Escalating there converts a cheap failure into an expensive one and buys nothing.

The two classes leave different fingerprints in data the run already collects, so routing between them needs no new heuristics and no LLM judgment: sequant snapshots `git rev-parse HEAD` plus the (state-file-excluded) dirty set around each iteration and compares them. Nothing changed is capability-bound. Something changed and QA still failed is spec-bound — internally, *divergence-suspect*.

## Configuring the ladder

Rungs are ordered cheapest-first. Escalation moves exactly **one** rung at a time and never skips: trying the cheap rung first is the entire cost argument.

**Settings** (`.sequant/settings.json`):

```json
{
  "run": {
    "modelLadder": ["sonnet", "opus"]
  }
}
```

**CLI flag** (`sequant run` and `sequant ready`), highest precedence:

```bash
npx sequant run 42 --quality-loop --model-ladder sonnet,opus
npx sequant ready 42 --model-ladder sonnet,opus
```

Entries may be raw model names or `role:` aliases (`role:fast`, `role:strong`), resolved through the same role resolver the rest of the CLI uses.

## When a rung is spent

Three conditions must all hold:

1. **A retry was observed.** The ladder never acts speculatively — a first attempt is never escalated.
2. **The retry is at least the second one.** Retry 1 belongs to [effort escalation](run-command.md#effort-escalation-on-retries): one tier of reasoning effort is the cheaper rung, and it is spent first. Model escalation waits for a *subsequent* capability-bound retry. Effort and model never escalate on the same iteration.
3. **The signal is capability-bound.** A no-progress iteration (`LOOP_NO_DIFF`, `SAME_SHA_NO_PROGRESS`). Divergence-suspect iterations are excluded by construction.

A rung is **sticky**: once a phase reaches it, later iterations stay there rather than dropping back to a model that already failed. Rungs are tracked per phase, so `exec`, `qa`, and `loop` climb independently.

An explicit `--models` pin that is *not* a ladder entry disables the ladder for that phase entirely, rather than treating rung 0 as "next" — that could silently downgrade your pin.

## The three halts

The ladder's counterpart to climbing is knowing when to stop. All three halts print an evidence bundle, suppress the `/loop` spawn, and end the run's outer iteration — the same "surface and halt, preserve partial work" shape used by the turn-cap (#739) and billing-window (#799) halts. None of them merges, and none of them discards work already committed in the worktree.

### `SPEC_DIVERGENCE` — the escape hatch

An agent that finds an acceptance criterion impossible as written declares it and stops, rather than guessing at what was meant or implementing the half it can. The declaration channel is the ordinary `SEQUANT_PHASE` marker:

```markdown
<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2026-09-08T12:00:00.000Z","outcome":"SPEC_DIVERGENCE","divergenceAcs":"AC-2","error":"AC-2 requires the file to both exist and not exist"} -->
```

`SPEC_DIVERGENCE` is terminal for **both** the ladder and the retry path: no rung is spent, and no cold-start retry or MCP fallback re-dispatches the phase. A retry cannot un-contradict a spec.

The `/exec` and `/loop` skills tell agents when to emit it — and, just as importantly, when not to. It means *no implementation can satisfy this as written*. Work that is merely hard, underspecified, or blocked on a dependency is not divergence.

This halt is the one that does **not** require a configured ladder. A contradictory spec is not a model-capability question at all, so the escape hatch works on every run.

### `DIVERGENCE_SUSPECT` — repeated progress, repeated rejection

Two **consecutive** iterations that each produced a diff at a still-failing verdict. Two, not one: a single such iteration is the ordinary `AC_NOT_MET → /loop → re-QA` cycle working exactly as designed, and halting on it would turn every normal second pass into a dead run. Two in a row is the pattern that says the loop is building plausible work the criteria keep refusing.

Requires a configured ladder.

### `TOP_OF_LADDER` — nowhere left to climb

A further capability-bound trigger arrived while the phase already sat on the ladder's last rung. Reported distinctly rather than as `MAX_ITERATIONS`, because the remedies differ: `MAX_ITERATIONS` invites you to raise the iteration cap, which is the wrong move when the real news is that your strongest configured model already failed.

Requires a configured ladder.

## The evidence bundle

Every halt prints a bundle so the handoff is adjudicable without replaying the run:

```
Ladder halt: SPEC_DIVERGENCE — issue #995, phase 'exec'
  Why: the agent declared the spec impossible as written — no model rung was spent
  Declared impossible: AC-2
  Agent message: AC-2 requires the file to both exist and not exist
  SHAs tried: 4f2a1c9
  Iterations:
    1: verdict=AC_NOT_MET sha=4f2a1c9
  Escalation history:
    (empty — no model rung was spent)
  Next step: Reconcile the acceptance criteria with the repository as it exists, then re-run. A stronger model cannot resolve a contradiction in the spec.
```

The load-bearing line is **Escalation history**. Empty is the proof that a `SPEC_DIVERGENCE` or `DIVERGENCE_SUSPECT` halt spent no rung; non-empty and ending at the last rung is what `TOP_OF_LADDER` means. It is always printed, so "no escalation happened" is a fact in the record rather than something you infer from an absent section.

Under `sequant ready`, the same bundle is embedded in the gap report under **Ladder halt evidence**, and the gate terminates with the matching stop reason (`SPEC_DIVERGENCE`, `DIVERGENCE_SUSPECT`, or `TOP_OF_LADDER`) and issue status `blocked`.

## Cost

The ladder is a cost-control mechanism first. Every design choice above trades in the same currency:

- **Cheapest rung first, one at a time.** Skipping a rung spends the expensive model on work the next one up might have handled.
- **Effort before model.** A reasoning-effort tier is cheaper than a model tier, so it is always spent first, and never on the same iteration as a rung.
- **No speculative escalation, ever.** Rungs are bought with observed evidence, never with a prediction that a task looks hard.
- **Divergence never escalates.** This is where the savings actually are: the spec-bound case is precisely the one where escalation costs the most and returns the least, so it halts at the cheapest rung instead.
- **No downgrades.** Speculatively lowering a model is out of scope — that is the direction where a wrong guess costs quality rather than money.

## Observability

An escalated dispatch prints under `--verbose`:

```
model: sonnet → opus (no-progress retry)
```

Run metrics (`.sequant/metrics.json`) record `requestedModel`, `escalatedModel`, and the trigger reason on the `phaseUsage` row for every escalated execution, and the escalation facts are flattened into the phase marker (`ladderRung`, `baseModel`, `escalatedModel`, `escalationTrigger`, `topOfLadder`). A run that halted without escalating has **no** `phaseUsage` row carrying `escalatedModel` — which is the check to run when you want to confirm a halt was free:

```bash
jq '[.. | objects | select(has("phaseUsage")) | .phaseUsage[]?
     | select(.escalatedModel != null)] | length' .sequant/metrics.json
```

## Related

- [Effort Escalation on Retries](run-command.md#effort-escalation-on-retries) — the cheaper rung, spent first
- [Per-Phase Model & Effort](run-command.md#per-phase-model--effort) — the `--models`/`--efforts` pins the ladder starts from
- [`sequant ready`](ready-command.md) — the gate path, where the same halts terminate the report
