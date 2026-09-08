---
type: regex
target: last_message
pattern: '<!-- SEQUANT_QA_GAPS:'
match: contains
weight: 1
---

The qa skill emits the `SEQUANT_QA_GAPS` structured trailer as the last line
of its own output unprompted (§6j) — never dictated by this case's prompt.
An 8-line stub never produces this marker.
