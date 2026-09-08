# Plugin Eval CI

`.github/workflows/plugin-eval.yml` runs the `claude plugin eval` suite
(`evals/`) against this repository's plugin. It is **manual-dispatch only** —
no `pull_request` or `push` trigger — because each run spends real API budget
and the suite is not yet cheap or stable enough to gate every PR.

## Prerequisites

1. **`ANTHROPIC_API_KEY` repository secret.** The workflow's first real step
   checks for it and fails loudly, naming the secret, if it is missing — it
   never skips silently or reports green without running an eval.
   ```bash
   gh secret set ANTHROPIC_API_KEY
   ```
2. **Early access to `claude plugin eval`.** The workflow sets
   `CLAUDE_CODE_WALNUT_SPIRE=1` in its own `env:` block — never in
   `.claude/settings.json` or `.claude/settings.local.json` — because the
   runner's account needs early-access to the feature, not this repository's
   configuration.

## Dispatching a run

From the Actions tab, select **Plugin Eval** → **Run workflow**, or from the
CLI:

```bash
gh workflow run plugin-eval.yml
```

## What it runs

A single `claude plugin eval` invocation covers all four cases under
`evals/`: `qa-trust-boundary`, `spec-ac-parse`, `assess-dashboard`, and
`null-run-canary`.

```bash
claude plugin eval . \
  --no-publish \
  --allow-tools Write \
  --max-cost-usd 10 \
  --threshold 0.9 \
  --output-dir evals/ci-report \
  --json evals/ci-report/results.json
```

- **`--max-cost-usd 10`** is a hard budget ceiling — the run aborts and
  reports partial results if it is hit, rather than running away.
- **`--threshold 0.9`**, rather than the CLI's default `1.0`, absorbs a known
  flake in the `qa-gaps-marker` grader on `qa-trust-boundary`, observed red in
  2 of 6 runs at `--runs 1` during #993's QA. `0.9` is a judgment call, not
  empirically derived from a large sample — revisit after this workflow's
  first few live dispatches.
- **`null-run-canary` is expected to fail.** It exists to prove the graders
  are not vacuous — if it ever passes, the eval harness itself is broken. The
  workflow does not trust the CLI's own exit code to decide pass/fail (a
  canary that is *supposed* to be red would make a bare `--threshold` gate
  permanently red); instead it parses `results.json` directly:
  - `cases[] | select(.name == "null-run-canary") | .aggregates.passRate`
    must be `0`. If it is `1`, the job fails with "graders are vacuous."
  - Every other case's `.aggregates.passRate` must be `>= 1` (satisfies the
    `--threshold 0.9` if scores are fractional but must still clear the bar
    per case), or the job fails naming which case regressed.

## Report artifact

The eval's `--output-dir evals/ci-report` (kept outside the committed
`evals/results/` fixtures so CI scratch output never collides with the
fixture-commit gate in `__tests__/evals-fixture-commit.test.ts`) is uploaded
as the `plugin-eval-report` artifact on every run — including failed ones —
so a failure can be debugged from the run page without re-dispatching.

## Fixture commit ablation

Each case's recorded result under `evals/results/*.json` carries a
`fixture_commit` — the commit the case's prompt/grader fixtures were last
verified against. `__tests__/evals-fixture-commit.test.ts` gates that every
recorded result has one, and (where full git history is available) that it
is an ancestor of `HEAD`, so a result can't be credited forever to a fixture
version that has since changed underneath it (#830).
