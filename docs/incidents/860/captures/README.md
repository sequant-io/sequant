# Issue #860 — captured five-hour-window payloads

Evidence for #860: every real rate-limit failure recorded across two consumer
projects was a **subscription five-hour window exhaustion** that the pre-#860
`isBillingFailure` misclassified as terminal billing (`BillingError`,
`error: "Out of credits"`), which kept `--auto-wait` (#804) from ever firing.

## The payload set

All 26 occurrences are committed, with provenance, in the test fixture that
gates the classification:

- [`__tests__/fixtures/rate-limit-payloads-860.json`](../../../../__tests__/fixtures/rate-limit-payloads-860.json)

| Source project | Occurrences | Dates (2026) | Distinct `resetsAt` |
|---|---|---|---|
| ad-motion | 22 | 07-19, 07-24, 07-26 | 5 |
| matcha-maps | 4 | 07-18 | 1 |

Every payload is structurally identical:

```json
"errorMetadata": {
  "resetsAt": <epoch seconds>,
  "rateLimitType": "five_hour",
  "overageDisabledReason": "out_of_credits"
}
```

Notably **absent** from all 26: `errorCode`, `canUserPurchaseCredits`,
`hasChargeableSavedPaymentMethod` — the fields that would discriminate
"subscription window" from "needs purchase" directly. This is why the #860
classification uses the window shape (`rateLimitType` + future `resetsAt`) as
the proxy, and fails closed on anything else. Also absent from all 26: a
`status` field — which is why event *retention* stayed on the raw billing
markers, and why only an affirmatively informational status
(`allowed`/`allowed_warning`) is excluded from the waitable classification.

**Allowlist judgment:** `seven_day*` is admitted alongside `five_hour` per
AC-1's "(or another window type)", but **no capture shows a
`seven_day` + `out_of_credits` combination** — its semantics are pinned by
tests (`rate-limit-errors.test.ts`, "#860 hardening: seven_day"), not by
evidence. In practice a multi-day reset exceeds any sane `--auto-wait` budget,
so the observable effect is limited to the halt message naming the reset time.
Any *other* window type fails closed to terminal, and the halt message names
the rejected type (`unrecognizedWindowHint`) so vocabulary drift is
diagnosable from a run log.

## Provenance and redaction

The payloads were extracted from `.sequant/logs/run-*.json` in the ad-motion
and matcha-maps working copies on 2026-08-03, before log rotation (100-file
cap) aged them out. Each fixture entry carries `project`, `sourceFile`,
`runId`, run/phase timestamps, `issueNumber`, `phase`, and the verbatim
`error`/`category`/`errorType`/`isRetryable`/`errorMetadata` fields.

The full run logs are **deliberately not committed**: their `stdoutTail`
buffers contain multi-page agent transcripts of unrelated work in those
projects. Everything the classification depends on — and everything the #860
issue cites — is preserved verbatim in the fixture entries.

The earlier committed sample from the same failure class (2026-07-18, sequant
itself) lives in [`../../782/captures/2026-07-18/`](../../782/captures/2026-07-18/).
