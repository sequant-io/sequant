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

LEDGER (as of 2026-09-10, after the wave-1 run — re-query with `gh`)
- Wave 1 ran 2026-09-10 (three parallel MCP dispatches; tiering by
  settings flip). Every node stopped at PR per I-1; the owner decides.
    #990  node 01  PR #1036  QA: AC_NOT_MET → fixes applied by the runner
          (doctor never hints `sync --force`; real-fs preview test; dead
          helper removed; AC-6 scoped per D16) → QA re-run: AC_MET_BUT_NOT_A_PLUS
    #982  node 02  PR #1033  QA: AC_NOT_MET → runner fixed the capture
          regression, the non-gating test, KNOWN_KEYS, live-surface guard →
          QA re-run: AC_MET_BUT_NOT_A_PLUS; the five notes folded in place
    #980  node 03  PR #1035  QA: AC_NOT_MET (marker format only) → records
          rewritten after the runner re-ran all five mutations → QA re-run:
          AC_MET_BUT_NOT_A_PLUS; two doc cells corrected (merge gate is a
          human control; the eval is evidence, not containment)
- Also open: PR #1034 (#1032, D17 — the background-task guard; not a node),
  PR #1031 (this docs branch: node 09 + D14–D17).
- Blocked, unchanged: #1024, #1025, gate #1026 (by #980); #1028 (by #1026,
  #1025); gate #1027 (by #990, #982); #1030 (by #990; now also carries
  #990's `update --dry-run` clause, D16); #944 (by #1027 — edge only).
- Owner actions surfaced by the wave: enable GitHub private vulnerability
  reporting (SECURITY.md names it as the primary channel; it is disabled);
  the hand-maintained AGENTS.md on sequant-landing before gate 08; decide
  the three `runner amendment` notes (D15, D16) — revert on the issue if
  you disagree.
- Excluded on purpose (D10): #929 (reserved #997 dogfood sample — do not
  implement), #941, #919 (file collisions with 01/02).

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
