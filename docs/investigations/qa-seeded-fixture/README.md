# Seeded-defect fixture for `/qa` (#1067)

This is a throwaway project plus one diff. The diff claims to implement
`fixture-issue.md` and carries **5 planted defects of distinct classes**. Each
defect has one grep-able identifier, an ordinary code symbol and not a
`// SEED` tag, so the defect doesn't point at itself. The classes come from the
`caught` rows of [`../qa-second-look-dataset.md`](../qa-second-look-dataset.md).

| File | Role |
|------|------|
| `base/` | The project before the change. Copy it into a new repo as the first commit on `main`. |
| `defects.patch` | The change under review. `git apply` it on a feature branch and open a PR. |
| `fixture-issue.md` | The issue body (title is the `#` heading). The PR claims to close it. |
| `ground-truth.json` | Planted defects: `id`, `class`, `file`, `rationale`. **Never put this in the fixture repo.** |

Each identifier occurs exactly once in `defects.patch`. That's enforced by
`scripts/analytics/qa-seeded-grade.test.ts`.

## Provisioning (runner, not exec)

```bash
mkdir notes-fixture && cd notes-fixture && git init -b main
cp -R <this dir>/base/. . && git add -A && git commit -m "base"
gh repo create <owner>/notes-fixture --private --source . --push
gh issue create --title "Add \`notes export\` and \`notes serve\`" --body-file <this dir>/fixture-issue.md
git switch -c feature/1-add-notes-export
git apply <this dir>/defects.patch && git add -A && git commit -m "feat(#1): notes export and serve"
git push -u origin HEAD && gh pr create --fill --body "Closes #1"
```

Then run `/qa` against the issue (`sequant run 1 --phases qa`, ≥5 times). Grade
each posted verdict:

```bash
npx tsx scripts/analytics/qa-seeded-grade.ts \
  --verdict <verdict.md> --truth docs/investigations/qa-seeded-fixture/ground-truth.json
```

## Known grader bias

Matching is literal: an identifier is found only if the verdict writes it.
Suppose a reviewer describes the `0.0.0.0` bind as "listens on all interfaces"
and never writes the address. The grader counts that as a miss, and a human
counts it as a catch. That gap is the grader-vs-human disagreement
the investigation measures (AC-7). It is not fuzzy-matched away.
