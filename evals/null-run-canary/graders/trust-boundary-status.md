---
type: regex
target: last_message
pattern: '### Trust-Boundary Check[\s\S]{0,2000}\*\*Status:\*\* Clean'
match: contains
weight: 1
---

Mirrors evals/qa-trust-boundary's substantive grader. A do-nothing reply must
not satisfy it — default-to-red proof that the grader set isn't vacuous.
