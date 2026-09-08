# 07 — #987-A feat(evals): `claude plugin eval` Phase 0 (P0.2–P0.6; P0.1 already PASS)

**Epic:** M0   **Blocked by:** —   **Tier:** judgment   **Doc:** PLAN §4, §5 I-3, I-8, §7 D11, §9 OQ-6, Lab §1

## Why
P0.1 is answered: with `CLAUDE_CODE_WALNUT_SPIRE=1` in the environment,
`claude plugin eval . --case __nonexistent__` reaches case discovery on this
machine (Lab §1). The remaining five questions decide whether the first cases
(node 10) and CI (node 13) are worth authoring, and what grader vocabulary they
may use.

## Scope
- may touch: `docs/investigations/plugin-eval-phase0.md`; a throwaway `evals-phase0/` directory (via `--eval-dir evals-phase0`) **deleted before the PR**; nothing under `evals/`
- not in scope: any committed case; `plugin.json`; CI.

## Acceptance criteria
- [ ] AC-1: P0.1 recorded as PASS with today's evidence — Verify: `grep -c 'P0.1' docs/investigations/plugin-eval-phase0.md` ≥ 1 and the row cites the exact command and output from Lab §1.
- [ ] AC-2: P0.2 target resolution + ablation — Verify: the doc links one `--json` run of `CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . --eval-dir evals-phase0 --ablation with-without --runs 1 --max-cost-usd 5 --json <path>` whose JSON shows two arms and the `tool_used: Skill` indicator on the with arm; or the row reads KILL with the JSON attached.
- [ ] AC-3: P0.3 grader vocabulary — Verify: the doc lists every grader type the CLI accepts (from `plugin eval init --bare` output and the report schema) and marks which are deterministic; the row's pass condition is met only if a deterministic grader can assert on the `<!-- SEQUANT_QA_VERDICT` marker fields.
- [ ] AC-4: P0.4 scaffold + hooks — Verify: a `/qa` case with `--scaffold` (author-supplied script standing up a git repo, a diff, and an issue fixture) reaches a verdict marker, and the doc states whether `pre-tool.sh` fired inside the sandbox with the evidence (a deliberately blocked command in the scaffold and its observed outcome).
- [ ] AC-5: P0.5 cost/wall — Verify: the doc's table shows `$` and wall for 3 runs × 2 arms of one case, and states the P2 decision (`> $2/case-run or > 10 min → manual-dispatch only`).
- [ ] AC-6: P0.6 null-run canary — Verify: the doc records a run that does nothing scoring 0 and a deliberately broken skill copy failing the case; both red.
- [ ] AC-7: clean tree and verdict — Verify: `test ! -d evals && test ! -d evals-phase0` in the PR's tree, and `gh issue view 987 --comments | grep -c 'Phase 0 verdict: GO\|Phase 0 verdict: NO-GO'` ≥ 1.
- [ ] AC-8: cost recorded — Verify: total `$` in the doc under `$25`; every command shown carries `--max-cost-usd`.

## Done when
`docs/investigations/plugin-eval-phase0.md` answers P0.1–P0.6 with evidence and #987 carries a go/no-go comment, with no eval case committed.
