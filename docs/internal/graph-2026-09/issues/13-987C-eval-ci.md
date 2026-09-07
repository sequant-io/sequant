# 13 — #987-C ci(evals): manual-dispatch workflow with a budget cap, and the docs page

**Epic:** M2   **Blocked by:** #987-B (node 10); **not launchable** until OQ-7 (budget number) is posted on #987   **Tier:** mechanical   **Doc:** PLAN §5 I-8, §9 OQ-7/OQ-14

## Why
The suite is only useful if it runs somewhere other than one laptop. Node 07's
P0.5 decided per-PR vs. manual; this graph ships manual-dispatch only.

## Scope
- may touch: `.github/workflows/plugin-eval.yml` (new), `docs/reference/plugin-eval.md` (new), `README.md` (one link line)
- not in scope: per-PR triggers; any case; repo `.claude/settings.json` (the env var must not live there — Lab §1 / memory).

## Preconditions
- `CLAUDE_CODE_WALNUT_SPIRE=1` is set in the workflow's `env`, and the runner's account has the org early access (OQ-14). The API credential comes from a repository secret named in the workflow.

## Acceptance criteria
- [ ] AC-1: workflow exists, manual-dispatch only — Verify: `grep -c 'workflow_dispatch' .github/workflows/plugin-eval.yml` → `1` and `grep -c 'pull_request\|push:' .github/workflows/plugin-eval.yml` → `0`.
- [ ] AC-2: budget and threshold on the command line — Verify: `grep -E 'max-cost-usd [0-9]+' .github/workflows/plugin-eval.yml` prints the OQ-7 number and `grep -c -- '--threshold' .github/workflows/plugin-eval.yml` → `1`.
- [ ] AC-3: report uploaded — Verify: the workflow has an `actions/upload-artifact` step whose path is the eval results dir; one green run URL is in the PR body (`gh run view <id> --json conclusion --jq .conclusion` → `success`).
- [ ] AC-4: env var not in repo settings — Verify: `grep -rn 'WALNUT' .claude/settings.json .claude/settings.local.json 2>/dev/null | wc -l` → `0`.
- [ ] AC-5: docs — Verify: `test -f docs/reference/plugin-eval.md` and `grep -c 'fixture_commit\|ablation\|max-cost-usd' docs/reference/plugin-eval.md` ≥ 3; `grep -c 'plugin-eval' README.md` ≥ 1.

## Done when
A maintainer can dispatch the eval suite from the Actions tab, it stops at the agreed budget, and the report is downloadable from the run.
