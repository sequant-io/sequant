# Handoff — guard-2026-09: closed

The graph is complete (2026-09-20/21): 14 exec nodes merged in three waves, gate #1109 applied, gate #1110 completed, 2.17.0 released (`ad499b52`, npm `latest`). Records: `issue-graph.md` (three execution records + gates), `PLAN.md` §7 D-13..D-23 and §9.

Follow-ups outside the graph, in priority order: #1119 (verdict parser first-match — dispatched), #1122/#1123/#1124 (writer defects the state matrix exposed), #1129 (corpus replay coverage), #1115 (opencode/aider typed errors), PR #1133 (post-release action items).

Rules that now bind every session in this repo: `main` rejects direct pushes — everything lands through a PR with `test` + `canary` green; releases go to `next` first and are promoted after the soak; a red `main` is reverted before it is debugged.
