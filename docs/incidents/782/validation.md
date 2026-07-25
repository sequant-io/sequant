# #761 AC-9 post-hoc validation — do real window-exhaustion rejections carry `rateLimitType`/`resetsAt`?

**Status:** Validated (with one scoped residual — see [AC-2](#ac-2-confirm-the-intended-branch-fired)).
**Captured:** 2026-07-18. **Recorded:** 2026-07-25. **Issue:** #782. **Validates:** #761 AC-9 (PR #781).

## Why this record exists

#761 made the retry ladder branch on rate-limit metadata: a `RateLimitError` whose `resetsAt`
lies more than 5 minutes out skips all retries (`isWindowExhaustedRateLimit`,
`src/lib/workflow/phase-executor.ts`); one without metadata falls back to transient handling.

That branch rests on an assumption: **window exhaustion actually arrives as a structured
`rate_limit_event` with `rateLimitType`/`resetsAt` populated.** #761's AC-9 asked to validate it
against a real captured rejection. It could not be validated statically — the event is emitted
inside the closed CLI binary, and `SDKRateLimitInfo`'s fields are all optional and documented
subscription-only — so AC-9 was downgraded to a post-hoc validation and tracked as #782.

#782 was parked on 2026-07-18 for want of evidence. Thirty minutes later, evidence arrived.

## The captures

Two run logs, copied verbatim into [`captures/2026-07-18/`](captures/2026-07-18/):

| | Run log | Issue | Phase | Duration |
|---|---|---|---|---|
| **A** | `run-2026-07-18T16-05-05-43494f55-….json` | #783 | spec | 17.47s |
| **B** | `run-2026-07-18T16-05-33-e9576956-….json` | #784 | spec | 16.72s |

Both record `"startCommit": "b1bedbc8fac0babfa4c26a6104612c91f17bba00"` — which **is the PR #781
merge commit**. The captures are post-#781 by construction, so the structured `errorContext`
persistence #761 added was live when they were written.

Corroborated independently in `.sequant/metrics.json`: both runs carry
`"failureCategory": "billing"`.

Both `errorContext` payloads are identical in shape:

```json
{
  "stderrTail": [],
  "stdoutTail": ["You've hit your session limit · resets 11:30am (America/Chicago)"],
  "category": "billing",
  "errorType": "BillingError",
  "errorMetadata": {
    "resetsAt": 1784392200,
    "rateLimitType": "five_hour",
    "overageDisabledReason": "out_of_credits"
  },
  "isRetryable": false
}
```

## AC-1: Which channel fired, and was the metadata populated?

**Channel: `rate_limit_event` (structured). Not the bare `assistant.error` fallback.**

The discriminator named in #782 is `errorMetadata.assistantError`, which is **absent** here. That
is structural, not inferred: in `buildStructuredError` (`src/lib/workflow/drivers/claude-code.ts`),
the `rateLimitInfo` branch is the only path that emits `resetsAt`/`rateLimitType`/
`overageDisabledReason`, while the `errorFromAssistantError` fallback stamps `assistantError` and
carries no timing fields at all. A payload with the former and without the latter can only have
come from `rate_limit_event`.

| Field | Populated? | Value |
|---|---|---|
| `rateLimitType` | ✅ | `"five_hour"` |
| `resetsAt` | ✅ | `1784392200` |
| `overageDisabledReason` | ✅ | `"out_of_credits"` |
| `assistantError` | — (absent) | confirms structured channel |

**`resetsAt` decodes correctly.** `1784392200` (seconds) → `2026-07-18T16:30:00Z` → 11:30 CDT,
matching the human-readable `stdoutTail` string verbatim. The unit heuristic in `resetsAtToMs`
(`< 1e12` ⇒ seconds) handles it correctly.

**This settles the #761 AC-9 question.** Real window exhaustion *does* arrive on the structured
channel with `rateLimitType` and `resetsAt` populated. The load-bearing assumption is validated
against production evidence, not assumed.

## AC-2: Confirm the intended branch fired

Partially. What the artifacts actually show, without rounding up:

| | Outcome | Evidence |
|---|---|---|
| MCP fallback skipped | ✅ | `failureIsBilling` gate, `phase-executor.ts`; no "retrying without MCP" line, and an MCP re-spawn would have added a full phase attempt to the duration |
| Non-retryable classification held | ✅ | `"isRetryable": false` persisted |
| "Window exhausted, skipping retries" | ⚠️ did **not** fire | classified `BillingError`, which the predicate excludes by design |
| Cold-start retries skipped | ⚠️ **no** — they ran | see below |

**Why the window branch didn't fire.** The rejection also carried
`overageDisabledReason: "out_of_credits"`, so `isBillingFailure()` → `createRateLimitError()`
returned a **`BillingError`, not a `RateLimitError`**. `isWindowExhaustedRateLimit()` opens with
`if (!(error instanceof RateLimitError)) return false`, so the window path was never reachable.

**The counterfactual is decisive, though.** At capture A's phase start (16:05:11Z) the reset was
**24.8 minutes out — well beyond `RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS` (5 min)**. Had credits not
also been exhausted, this exact payload would have produced a `RateLimitError` and taken the
"window exhausted, skipping retries" branch. The metadata was sufficient to drive the branch; only
the billing classifier took precedence. This counterfactual is pinned by the regression test in
`src/lib/workflow/phase-executor.test.ts`.

**Cold-start retries were not skipped.** Per-attempt duration is compared against
`COLD_START_THRESHOLD_SECONDS = 60`, but the run-log entry's 17.47s is *cumulative* across
`executePhaseWithRetry` (timed in `src/lib/workflow/batch-executor.ts`). Sub-60s billing attempts
therefore fall through to the cold-start branch and re-spawn up to `COLD_START_MAX_RETRIES = 2`.
This is **known, intended behavior, not a defect** — the code comment above the `capped` early
return says so explicitly ("unlike the billing case which still cold-start-retries in the <60s
window"). Recorded for completeness; not filed as a bug.

> **Limitation, stated rather than glossed:** the run log stores no per-attempt records, so the
> exact attempt count is not directly observable. Three attempts of ~5.8s fits 17.47s, but that is
> arithmetic inference, not measurement.

**Residual:** a pure `RateLimitError` window rejection — limit hit while credits remain — is still
unwitnessed. The metadata channel is proven; the specific branch is proven only by counterfactual.

## AC-3: Conditional follow-up — not triggered

AC-3 is explicitly conditional: *"**If** window rejections turn out to routinely arrive **without**
metadata (bare `assistant.error: "rate_limit"`) … file the design follow-up for a metadata-free
heuristic."*

**The condition does not hold.** Both captures carry full metadata on the structured channel. The
5-minute skip's precondition is met, and the metadata-free heuristic AC-3 hedged against is not
needed on this evidence. **No follow-up issue filed** — filing one would contradict the AC's
literal text.

## Consequence for #804 (`--auto-wait`)

#804's 2026-07-25 comment flags this validation as load-bearing: whether real window-exhaustion
rejections carry `resetsAt` decides whether auto-wait fires on the common path or only rarely.

**Answer: `resetsAt` is present on the structured channel**, so auto-wait can compute a real wait
target on the real path. One caveat worth carrying into that design: the observed rejection was
*credits* exhaustion, where waiting does not help — credits need purchasing, not a window wait.
Auto-wait should gate on `RateLimitError` rather than on the presence of `resetsAt` alone, since
`BillingError` carries a `resetsAt` too.

## Regression guard

`src/lib/workflow/phase-executor.test.ts` → `"#761 AC-9 validation against the real 2026-07-18
capture (#782)"` replays the captured payload through `createRateLimitError` and
`isWindowExhaustedRateLimit`, including the counterfactual above.

Existing coverage for these functions is entirely synthetic. This test pins the **real field names
and units** so SDK field drift — a renamed `resetsAt`, a changed unit, a dropped `rateLimitType` —
breaks a test instead of silently disabling the #761 branch.
