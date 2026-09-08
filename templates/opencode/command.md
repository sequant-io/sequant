---
description: Run the sequant {{PHASE}} phase for a GitHub issue
---

Load the `{{PHASE}}` skill with the skill tool, then execute it against the
arguments below.

**This is not optional and not a summary request.** The skill file is sequant's
methodology for this phase; a response written without it is not a `{{PHASE}}`
result, however plausible it reads.

1. Call the skill tool with `{"name": "{{PHASE}}"}`.
2. If the tool reports `truncated: true`, it delivered only the first portion of
   the skill. Read the remainder before doing any work — page through the file
   at the `dir` it reports (or the `outputPath` it points at) until you have the
   whole thing. Sequant's skills are long by design; stopping at the truncated
   portion means acting on a fraction of the instructions.
3. Follow the skill's instructions exactly, including its output format. Later
   sections carry the parts that matter most — verdict formats, trust-boundary
   rules, and phase markers all live past the first portion.

Arguments:

$ARGUMENTS
