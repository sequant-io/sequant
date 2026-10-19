# Held-out fixture for the second-look measurement (#1344)

> **Held out.** `ground-truth.json` is the scoring key for #1344 and #1272. Work that chooses or tunes `/qa` sections (#1068) must never read it.

This is the same throwaway `notes` project as [`../qa-seeded-fixture/`](../qa-seeded-fixture/), with a different change and **different defect classes**. The diff claims to implement `fixture-issue.md` (`notes import`) and carries 5 planted defects, from classes the #1067 dataset never shows caught in a first verdict: `missing-implementation`, `vacuous-test`, `primary-path-broken` behind a passing helper test, `regression-deletion` and `docs-contract-drift`.

| File                         | Role                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `../qa-seeded-fixture/base/` | The project before the change (shared with the seeded fixture).              |
| `defects.patch`              | The change under review. `git apply` it on a feature branch and open a PR.   |
| `fixture-issue.md`           | The issue body (title is the `#` heading). The PR claims to close it.        |
| `ground-truth.json`          | Planted defects in the #1067 schema. **Never put this in the fixture repo.** |

Each defect has at least one alias that occurs on exactly one line of `defects.patch`. `scripts/analytics/qa-seeded-grade.test.ts` enforces that.

## Provisioning

Same as the seeded fixture (see its README), using this directory's `fixture-issue.md` and `defects.patch` on a branch of the private calibration repo, whose `main` is `../qa-seeded-fixture/base/`.

## Grading

```bash
npx tsx scripts/analytics/qa-seeded-grade.ts \
  --verdict <review.md> --truth docs/investigations/qa-heldout-fixture/ground-truth.json
```

The grader is a cross-check here. The primary metric is human-read recall (see `../qa-second-look-measured.md`).
