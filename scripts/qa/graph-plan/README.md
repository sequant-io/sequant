# Graph-plan checkers

Two plan-time scripts used before filing a validated issue graph (`/graph-plan`). Both read the graph's `issues/*.md` files, which hold one issue body each, title on line 1. Neither runs in CI: `run-evidence.ts` executes arbitrary commands from issue bodies.

## parse-check

```
npx tsx scripts/qa/graph-plan/parse-check.ts docs/internal/graph-2026-10-review-surface/issues
```

Prints, per file, the AC count, how many carry an `Evidence:` clause (the only clause `/qa` reads, #938), how many `isGateTestEvidence` classifies as gate tests (each needs a `SEQUANT_MUTATION` record, see CLAUDE.md), whether `## Non-Goals` is present, and how many `- **Blocked by**: #N` list items exist (the only edge form `parseBodyDependencyMarkers` sees). Exits 1 if any AC lacks Evidence.

## run-evidence

```
npx tsx scripts/qa/graph-plan/run-evidence.ts \
  --issues docs/internal/<graph>/issues --out docs/internal/<graph>/phase0-evidence.md \
  --constraint 02:AC-4,03:AC-5 [--dry-run] [--timeout 90000]
```

Runs each AC's backticked Evidence command and classifies the result: `fails-today` (what a planned AC should do), `constraint` (named with `--constraint <file-stem>:AC-N`; holds on `main` by construction), `not-runnable` (placeholders, `$BEFORE`, `gh pr view`), `timeout`, or `PASSES-TODAY`, which exits 1: that AC is not a change and needs rewording or a constraint mark. Home directories in observed output are replaced with `~` so the record can be committed past the gitleaks home-path rule.

Both graphs filed on 2026-10-18 (#1501, #1523) were checked with these; their records are in each graph's `phase0-evidence.md`.
