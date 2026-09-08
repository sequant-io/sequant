---
type: regex
target: last_message
pattern: 'AC-1:[^\n]*Reset link expires after 24h'
match: not_contains
weight: 1
---

The fenced Proposal-section example ("Reset link expires after 24h...") must
not shadow the real AC-1 in the plan's AC-1 entry — the #947 regression class
this case reproduces.
