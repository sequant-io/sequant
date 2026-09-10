# 08 — GATE: wave-2 field verification and the #944 cost baseline (human)

**Epic:** W2   **Blocked by:** #990 (node 01), #982 (node 02)   **Tier:** human   **Doc:** W2 PLAN §2, §5 I-2, §7 D9, §9 OQ-1/OQ-3/OQ-7, §8 (human gate form)

## Artifact reviewed
`docs/investigations/wave2-field-verification.md`, produced by the runner after
nodes 01 and 02 are released (or npm-linked from a build of `main`), with:

1. **Ownership in the field (I-2).** On `sequant-io/sequant-landing` (D13):
   its tracked `scripts/dev/*.sh` links currently target
   `../../../../.npm/_npx/38ae72183b73fa32/node_modules/sequant/templates/scripts/…`
   (the npx-cache row; dead on any other machine). **Prerequisite, owner
   action:** commit a hand-maintained pointer-style `AGENTS.md` to landing
   first (it has none) so both file classes are on one real tree. Then
   transcripts of `sequant sync --dry-run`, `sequant sync`, `sequant doctor`,
   and `git status --porcelain` before and after. Expected: `AGENTS.md`
   byte-identical and reported `preserved`; the three links replaced by copies
   with the one-line reason (landing has no local `node_modules/sequant`) —
   or, if the owner adds `sequant` as a devDependency first, re-pointed into
   `node_modules/sequant`; `doctor` never suggests `sync --force` for the
   preserved file. The resulting landing commit is the field fix for its
   currently-dead links.
2. **Fresh QA in the field.** One real issue run `sequant run <n> --full-qa`
   on this repo. Recorded: the qa phase's starting context size (from the
   session transcript's first qa turn), `metrics.tokensUsed` and
   `metrics.costUSD` for the run, and whether the qa transcript begins fresh
   (no exec turns precede the `/qa` prompt).
3. **Cost baseline for #944.** The per-phase cost of that run and of the two
   most recent mechanical-tier runs, as a table, posted as a comment on #944
   with the heading `Post-#982 baseline`.

## Questions the human answers
1. Did I-2 hold on a real downstream tree — nothing the user owned was
   rewritten, and every decision was visible before the write?
2. Is the fresh-QA transcript actually fresh, and is the cost baseline on #944
   good enough to start #944's measurement?
3. OQ-1: keep `scripts/dev` tracked, or gitignore it in a follow-up?
4. OQ-3: keep `run.fullQa` opt-in for now?

## Accept route
- #944's `Blocked by:` line is cleared; OQ-1/OQ-3 answers recorded in W2 PLAN
  §9 (strikethrough + evidence); a follow-up is filed for OQ-1 only if the
  answer is "gitignore", with a §7 row.

## Reject route
- An `AGENTS.md` or link rewritten → node 01 reopens with the transcript as the
  motivating example. A resumed qa transcript → node 02 reopens. No new issue
  without a W2 PLAN §7 decision row.

## Verify (for the runner, not the human)
- `test -f docs/investigations/wave2-field-verification.md && grep -c "preserved" docs/investigations/wave2-field-verification.md` ≥ 1 and
  `gh issue view 944 --json comments --jq '.comments[].body' | grep -c "Post-#982 baseline"` → `1` before the gate is presented.
