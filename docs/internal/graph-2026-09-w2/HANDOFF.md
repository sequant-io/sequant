# Handoff — wave 2 runner prompt

Paste into a fresh session (or invoke `/graph-run graph-2026-09-w2` and point it
here). Written 2026-09-09 at filing time; the ledger is a snapshot — re-query
with `gh` before trusting it.

```
/graph-run graph-2026-09-w2

Pick up wave 2 of the sequant issue graph (planned and filed 2026-09-09).

GRAPH SOURCE
- Plan tree: docs/internal/graph-2026-09-w2/ (PLAN.md §8 conventions, D1–D13,
  OQ-1–9; issue-graph.md DAG + filing record; lab-notes-phase0.md; issues/01–08).
  If this tree is not on main yet, it is on PR #1029 (branch docs/wave2-plan) —
  read it from there; do not launch without it (the node files carry the
  may-touch scopes and verify commands).
- Fallback source: `Blocked by:` metadata line on every issue labelled
  graph-2026-09-w2 (line-anchored; prose #N mentions are not edges).

LEDGER (as of 2026-09-11 01:15Z — re-query with `gh`)
- Wave 1 MERGED 2026-09-10 22:30Z on the owner's timed consent: #1031, #1034,
  #1035, #1033, #1036 → main 6783356a (squash; main merged into each branch
  first; CI polled by head SHA). #980/#982/#990/#1032 closed.
- Wave 2 RAN 2026-09-10 23:30Z → 09-11 01:07Z, stop-at-PR — the owner decides:
    #1025  node 05  PR #1041  NEEDS_VERIFICATION — post-merge checks only
           (first scorecard.yml run; then the AC-3 `Score:` comment on #1025)
    #1024  node 04  PR #1043  AC_MET_BUT_NOT_A_PLUS — MERGE WITH A MERGE
           COMMIT (D19: fixture_commit anchors a branch commit)
    #1030  node 09  PR #1042  AC_MET_BUT_NOT_A_PLUS after three QA passes
- Gate #1026 presented (OQ-4 trusted publishing, OQ-5 standards phrase,
  landing ride-along) — unanswered. Gate #1027 still needs the owner's
  hand-maintained AGENTS.md on sequant-io/sequant-landing.
- Filed from field findings: #1044 (reconciler false "merged" on `(#N)` in a
  squash title — dangerous next-action), #1045 (duplicated templates→.claude
  mapping). Owner still owes: enable GitHub private vulnerability reporting.
- Remaining nodes: #1028 (node 07) after gate #1026 + #1025 merge; #944 after
  gate #1027. Excluded on purpose (D10): #929, #941, #919.

LAUNCH CONSTRAINTS
- Consent: stop-at-PR (I-1). Never `gh pr merge`; every PR waits for the owner.
- Tiers (D8): #990/#982 on the current .sequant/settings.json run.phases
  (mechanical). #980 is judgment: flip run.phases to all-strong for that
  launch, set run.timeout ≥ 3600, restore the mechanical policy afterwards.
- Foreground `sequant run` only (#856 kills backgrounded runs at ~106s).
  MCP `sequant_run` works but every phase has a hard 30-minute wall
  (`PHASE_TIMEOUT`), reset only at phase boundaries; in wave 1 two exec
  phases died at it and two more ended stranded on a backgrounded test run
  (D17, #1032). Until PR #1034 is on `main` and in the worktree's hooks,
  post the foreground-with-`timeout` rule as a context comment before every
  dispatch. Tiering via MCP = flip `.sequant/settings.json`, spawn, wait for
  the CLI's phase agent, restore (the CLI reads settings once at start).
- Merge-point files with declared rules (PLAN §8): bin/cli.ts (one .option()
  line each for 01 and 02), README.md (01 sync lines / 02 one flags row /
  03 one link line — 03→05→07 serialize later), CHANGELOG.md append-only.
- Gate tests need a `Mutation-verified:` record in the PR body (CLAUDE.md);
  QA runs each AC's verify command verbatim (I-7).
- OQ-2 is resolved in #982's spec: name every batch-executor.ts site that
  can dispatch qa. OQ-8 in #980's spec: pin the OWASP Agentic Top 10 (2026)
  category list from the OWASP source and cite the URL.

AFTER WAVE 1 MERGES
- #980 merged → #1024, #1025 and gate #1026 become frontier (04/05 parallel;
  06 is human — present THREAT-MODEL.md + SECURITY.md to the owner with the
  three questions in issues/06).
- #990 + #982 merged → gate #1027. Prerequisite before presenting it: the
  OWNER commits a hand-maintained pointer-style AGENTS.md to
  sequant-io/sequant-landing (it has none; its tracked scripts/dev/*.sh
  links point into an npx cache path — the live #991 row). The runner then
  produces docs/investigations/wave2-field-verification.md and posts the
  "Post-#982 baseline" comment on #944 per issues/08.

Report the ledger to the owner before launching anything.
```
