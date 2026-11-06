tracker: graph-2026-11-simplify — sequant 3.0 cut to the measured shape: D-1 removals, a halt on a repeated AC_NOT_MET, the ready gate's claim dropped, chain and multi-issue marked experimental, production-reaching Evidence handed to a person, the downstream pin, the release

**Epic:** graph-2026-11-simplify   **Tier:** mechanical   **Execution:** runner

## What this graph is

The owner adopted the evidenced shape on 2026-11-03: across nine experiments and 172 scored runs, sequant matched a native Claude Code recipe on recall and on verified acceptance criteria, at 1.9 to 4.6 times its estimated cost; what it adds is the issue as input, spec's AC extraction and file list, an independent per-AC check, the per-AC table, a verdict that refuses, one fix pass on the gaps the verdict names, and a person at the merge. This graph moves `main` toward that shape within the I-1 scope (src/ and bin/; the plugin freeze that first set it lifted 2026-11-06, D-7 amendment) and ships it as 3.0. Founding doc: `docs/internal/graph-2026-11-simplify/PROJECT-DISCUSSION.md` (§N below). The measured build is tagged `research-baseline-2026-11-03` (`31c6f8bdc`).

## Decisions (owner, 2026-11-03; founding doc §7)

```
D-1: F-10 removes the model ladder and effort escalation (model-ladder.ts, effort-escalation.ts and their flags), --stacked, --reflect and /reflect (the skill text after the freeze lifts), --full-qa, and /test's label auto-add (#1631). The /test skill stays.
D-2: keep maxIterations 3 and halt when AC_NOT_MET repeats (the #1162 rule); the ready gate keeps its loop and drops its second-look claim from the docs.
D-3: --chain and multi-issue runs are marked experimental, with a warning that names the measured success rates; the code stays.
D-4: pre-register #1068 now for qa's sections on fixture #34, with the cost estimated before any run; exec and fullsolve later.
D-5: hand-label 50 of the 538 pre-tool blocks before any hook change.
D-6: a new graph, graph-2026-11-simplify, whose founding doc cites the synthesis and links the nodes that already exist in #1501, #1523 and #1602 rather than moving them.
D-7: not yet; src/ and bin/ work and #1068 go first under the freeze, and the lift stays with the plugin directory review.
D-8: an Evidence line that names an env file, a production CLI or a live URL becomes a pending row with the command shown, run by a person (as #1630 proposes for CI).
```

D-7 amendment (2026-11-06): the plugin freeze is lifted; the directory refused `main` under a Verified-organizations rule, so no review holds the plugin. I-1 stays as this graph's scope boundary; OQ-7 in the founding doc decides which post-freeze items join.

## Nodes

See `docs/internal/graph-2026-11-simplify/issue-graph.md` for the DAG, waves and the placeholder map. Linked, not moved (D-6): #1501's F-10 (#S-02, #S-03 and #S-04 are its D-1 clusters), #1523 (#1526, #1521, #1529, #1622), #1602 (#1605, #1606).

## Acceptance Criteria

- [ ] AC-1: The graph directory is on `main`. Evidence: `git ls-tree -r --name-only origin/main -- docs/internal/graph-2026-11-simplify | grep -c '\.md$'` → `≥ 16`
- [ ] AC-2: The graph label exists. Evidence: `gh label list --search graph-2026-11-simplify --json name --jq 'map(select(.name=="graph-2026-11-simplify"))|length'` → `1`
- [ ] AC-3: Every node carries the label. Evidence: `gh issue list --label graph-2026-11-simplify --state all --limit 50 --json number --jq length` → `13`
- [ ] AC-4: No filed body keeps a placeholder edge. Evidence: `gh issue list --label graph-2026-11-simplify --state all --limit 50 --json body --jq '[.[].body|select(test("#S-[0-9]")|not)]|length'` → `13` (bodies with no placeholder left)

## Non-Goals

- Moving #1501's, #1523's or #1602's nodes (D-6).
- Any decision beyond D-1..D-8; a new one is a D-row in §7 of the founding doc.

## Done when

The directory is on `main`, the thirteen nodes are filed with the label and real edges, and D-1..D-8 stand on this issue.
