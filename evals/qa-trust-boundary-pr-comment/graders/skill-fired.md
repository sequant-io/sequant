---
type: tool_used
tool: Skill
arm: with-only
min: 1
weight: 1
---

Sanity check only — confirms a Skill tool call happened on the with-arm. This
proves a skill loaded, not that the real qa skill produced the output; it is
excluded from the without-arm score and is not evidence on its own: the
stub-skill canary arm recorded in `evals/results/qa-trust-boundary-stub-skill.json`
fires this grader green against an 8-line stub of the skill.
