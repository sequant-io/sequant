---
type: regex
target: last_message
pattern: '### AC-1:[^\n]*[\s\S]{0,300}parseACLine'
match: contains
weight: 1
---

The plan's `### AC-1` entry must reflect the real AC-1 from the issue's
`## Acceptance Criteria` section (about `parseACLine` extracting a trailing
`Evidence:` clause), not the fenced code-block example shown earlier in the
Proposal section. This is the spec skill's own unprompted plan structure —
the case prompt never names AC-1 or the fence.
