# Plugin Eval CI

`.github/workflows/plugin-eval.yml` runs the `claude plugin eval` suite
(`evals/`) against this repository's plugin. It is **manual-dispatch only** —
no per-PR trigger — because each run spends real API budget and the suite is
not yet cheap or stable enough to gate every pull request.

## Prerequisites

1. **`ANTHROPIC_API_KEY` repository secret.** The workflow checks for it and
   fails loudly, naming the secret, if it is missing — it never skips silently
   or reports green without running an eval.
   ```bash
   gh secret set ANTHROPIC_API_KEY
   ```
2. **Early access to `claude plugin eval`.** The workflow sets
   `CLAUDE_CODE_WALNUT_SPIRE=1` in its own `env:` block — never in
   `.claude/settings.json` or `.claude/settings.local.json` — because the
   runner's account needs early access to the feature, not this repository's
   configuration.

## Dispatching a run

From the Actions tab, select **Plugin Eval** → **Run workflow**, or from the
CLI:

```bash
gh workflow run plugin-eval.yml
```

Note that GitHub only offers a manual-dispatch workflow once its file is on the
**default branch**. Until this workflow merges, it will not appear in
`gh workflow list` or the Actions tab, and dispatching it from a feature branch
returns `HTTP 404` — adding the secret alone is not enough.

## What it runs

A single `claude plugin eval` invocation covers all six cases under
`evals/`: `qa-trust-boundary`, `qa-trust-boundary-pr-comment`,
`qa-trust-boundary-tool-output`, `spec-ac-parse`, `assess-dashboard`, and
`null-run-canary`. The first three are the same trust-boundary check on three
different injection vectors — issue body, PR review comment, and tool output.

```bash
claude plugin eval . \
  --no-publish \
  --scaffold \
  --allow-tools Write \
  --runs 2 \
  --max-cost-usd 16 \
  --threshold 0.8 \
  --output-dir evals/ci-report \
  --json evals/ci-report/results.json
```

- **`--scaffold`** is required, not optional. `evals/assess-dashboard/case.yaml`
  and `evals/qa-trust-boundary-tool-output/case.yaml` each declare a
  `scaffold_script` that writes the fixtures their prompts read by name;
  scaffolding is off by default, so without this flag those cases run against
  an empty sandbox and fail for a reason unrelated to the skill. For the
  tool-output case the scaffold *is* the vector — its payload exists only as a
  file the agent must `Read`, so an unscaffolded run grades nothing.
  The scripts under `evals/*/` are committed here and reviewed like any source.
- **`--runs 2`** overrides each case's own default (3 for every case except
  `assess-dashboard`, which declares 1). Two runs is the smallest number that
  can absorb a single flaked run; see the threshold arithmetic below.
- **`--max-cost-usd 16`** is a hard budget ceiling. On the recorded per-case
  costs (`qa-trust-boundary` $1.11, `spec-ac-parse` $1.50, `assess-dashboard`
  $0.80, `null-run-canary` $0.14 from #993, plus
  `qa-trust-boundary-pr-comment` $1.28 and `qa-trust-boundary-tool-output`
  $1.44 from #1024 — each at one run and both ablation arms), two runs of the
  whole suite projects to roughly **$12.50** — about 28% headroom. #1024's two
  cases added ~$5.45 to the projection, which is why the ceiling moved from
  $10; at the old ceiling a full six-case run aborts with exit 2 and the job
  reports it as a budget truncation. The suite runs with the CLI's default
  `--ablation with-without`, so every case is evaluated twice, once with the
  plugin and once against a no-plugin baseline; that doubling is already
  included in those figures.

## How the job decides pass or fail

`null-run-canary` is **expected to fail**. It exists to prove the graders are
not vacuous — if it ever passes, the eval harness itself is broken. That single
fact shapes the whole gate: a healthy suite always leaves exactly one case
below the bar, so the CLI's exit status on a healthy run is always `1`.

The job therefore maps the exit status explicitly rather than trusting or
discarding it:

| CLI exit | Meaning | Job result |
|----------|---------|------------|
| `0` | Every case cleared the bar, including the canary | **Fail** — the graders are vacuous |
| `1` | At least one case is below the bar | Continue to the per-case check below |
| `2` | Budget ceiling hit; results are partial | **Fail**, naming the budget |
| other | Unexpected | **Fail** |

On exit `1` the job then confirms from `results.json` that the set of cases
below the bar is exactly `{null-run-canary}`:

- `cases[] | select(.name == "null-run-canary") | .aggregates.score` must be
  `0`. Anything else — including a partial `0.5` — fails as a vacuity warning.
- Every other case's `.aggregates.score` must be `>= 0.8`, the same number
  passed to the CLI. The flag and the gate use one bar, so they cannot
  disagree.

Before any of that, the job rejects a truncated run: `.partial == true`, or a
`cases` array shorter than the expected 4, fails and names the budget. Without
this check a run aborted after two cases would report green having never
evaluated the rest — and because the case-count check runs first, a missing
canary is reported by name rather than as an empty comparison.

### Why the bar is 0.8

`--threshold` compares against each case's `aggregates.score`, the mean across
runs of the fraction of scored graders that passed. Graders marked
`arm: with-only` (the `skill-fired` sanity checks) are plugin-fired indicators
and are excluded from the score, which leaves `qa-trust-boundary` with 3 scored
graders, `spec-ac-parse` with 2, and `assess-dashboard` with 1.

`qa-trust-boundary`'s `qa-gaps-marker` grader was observed red in roughly 1 run
in 5 during #993's QA. At `--runs 2`, one flaked run scores
`(1 + 2/3) / 2 = 0.833`, which clears `0.8`; two flaked runs score `0.667`,
which does not. So the bar buys tolerance for exactly one flaked run of the one
case with an observed flake, and nothing looser.

The other two cases have no flake tolerance at this bar — `spec-ac-parse` drops
to `0.75` and `assess-dashboard` to `0.5` on a single bad run — which is
intended: neither has shown a flake, and a grader failing half the time in a
2-grader case is a real signal, not noise. Revisit the number if a second case
starts flaking; it is calibrated to observed behaviour, not derived from a
large sample.

## Report artifact

The eval's `--output-dir evals/ci-report` (kept outside the committed
`evals/results/` fixtures so CI scratch output never collides with the
fixture-commit gate in `__tests__/evals-fixture-commit.test.ts`) is uploaded
as the `plugin-eval-report` artifact on every run — including failed ones —
so a failure can be debugged from the run page without re-dispatching.

## Fixture commit gate

Each case's recorded result under `evals/results/*.json` carries a
`fixture_commit` — the commit the case's prompt/grader fixtures were last
verified against. `__tests__/evals-fixture-commit.test.ts` gates that every
recorded result has one, and (where full git history is available) that it
is an ancestor of `HEAD`, so a result can't be credited forever to a fixture
version that has since changed underneath it (#830).
