# Tech-Debt Scoring

How `/improve` ranks candidates. Every finding that survives Phase 2 filtering gets one category and one score; findings are presented in descending score order.

Adapted from Anthropic's `engineering:tech-debt` rubric (#1135). Plain markdown, no plugin dependency.

## Categories

Assign exactly one category per finding.

| Category | Examples | Risk if left |
|----------|----------|--------------|
| **Code debt** | Duplicated logic, poor abstractions, magic numbers, `any` types | Bugs, slow development |
| **Architecture debt** | A module that should be split, logic in the wrong layer, wrong data store | Scaling limits, change amplification |
| **Test debt** | Low coverage, flaky tests, missing integration tests | Regressions ship |
| **Dependency debt** | Outdated or unmaintained dependencies, known advisories | Security vulnerabilities |
| **Documentation debt** | Missing runbooks, outdated READMEs, undocumented exports, tribal knowledge | Onboarding pain, misuse |
| **Infrastructure debt** | Manual release steps, no monitoring, unpinned CI tooling | Incidents, slow recovery |

## Score

Rate each finding 1–5 on three axes:

- **Impact** — how much does it slow the team down today? (1 = barely noticed, 5 = hits most changes)
- **Risk** — what happens if it is never fixed? (1 = cosmetic, 5 = outage, data loss, or security exposure)
- **Effort** — how hard is the fix? (1 = under an hour, 5 = multi-day redesign)

```
Score = (Impact + Risk) × (6 − Effort)
```

The range is 2–50. Effort is inverted, so a cheap fix to a painful problem outranks an expensive fix to the same problem. Ties break on higher Risk.

## Worked example

| Finding | Category | Impact | Risk | Effort | Score |
|---------|----------|--------|------|--------|-------|
| Hardcoded token in a script | Code debt | 2 | 5 | 1 | (2 + 5) × 5 = **35** |
| No tests for `validation.ts` | Test debt | 3 | 4 | 2 | (3 + 4) × 4 = **28** |
| 800-line `legacy.ts` | Architecture debt | 4 | 2 | 4 | (4 + 2) × 2 = **12** |

## Output

Show the category and score for every row (see `/improve` §3.2), sorted by score descending within each effort group. When presenting a phased plan, schedule high-score items alongside feature work rather than as a separate cleanup project.
