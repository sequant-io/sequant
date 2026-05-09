# Behavior-Rule Detection (Shared Heuristic for /spec + /qa)

> **Source of truth:** `src/lib/heuristics/behavior-rule-detector.ts`. The
> keyword set, threshold, and pattern list live in TypeScript so they can be
> unit-tested (per AC-5 of #552); this doc cites them.

## Why this exists

Behavior-rule ACs ("default becomes X", "always include Y", "never skip Z") are
routinely implemented at **multiple touchpoints** — typically a skill prompt
(LLM-interpreted) **and** runtime TypeScript that duplicates the same rule.
Without a shared check, edits land at one site and the other goes stale.

**Motivating miss — issue #533** ("default /assess spec phase ON, remove
bug/docs auto-skip"):

- The AC explicitly named `.claude/skills/assess/SKILL.md`.
- `/spec` scoped the work to that file + CHANGELOG. `/exec` implemented it.
  `/qa` returned `READY_FOR_MERGE`.
- Meanwhile the runtime CLI (`phase-mapper.ts` `detectPhasesFromLabels` +
  `batch-executor.ts` auto-detect branch) still short-circuited bug/docs
  issues to `exec → qa`, contradicting the new "spec by default" rule.
- Caught only by manual user follow-up; required two extra commits and four
  doc updates on top of the original PR.

A pre-flight grep for `BUG_LABELS` / `DOCS_LABELS` / `"skip spec"` at /spec
time would have surfaced 90% of these in one pass. That's exactly what this
heuristic does.

## Trigger keywords

A `BEHAVIOR_KEYWORDS` constant in `behavior-rule-detector.ts`. Each keyword
also matches common inflections via the `KEYWORD_REGEXES` map (mirrors the
stem-aware pattern landed by #597 in `ac-linter.ts`); word boundaries are
preserved so `defaultValue` (camelCase identifier) does NOT trigger.

| Keyword | Inflections matched | Why it's in the set |
|---------|---------------------|---------------------|
| `default` | `defaults`, `defaulted`, `defaulting` | "default becomes X", "defaults to Y" |
| `always` | (adverb, no inflections) | "always include", "always run" |
| `never` | (adverb, no inflections) | "never skip", "never run when X" |
| `rule` | `rules`, `ruled`, `ruling` | "the rule is", "this rule applies" |
| `behavior` | `behaviors`, `behavioral`, `behaviorally` | "the behavior is", "behaviors change" |
| `skip` | `skips`, `skipped`, `skipping` | "skip spec", "skipping when X" |

## Trigger threshold (false-positive guard)

To avoid flagging localized fixes that happen to mention "default" once
("set default value to 5"), the detector requires **either**:

1. **>= 2 distinct keywords** from `BEHAVIOR_KEYWORDS` in the AC description
   (case-insensitive, word-boundary), **OR**
2. An **explicit pattern** match (single keyword is enough):
   - Mid-sentence rule constructs:
     - `always X unless Y`
     - `never X unless Y`
     - `default X when Y`
   - Capitalized imperative AC openers (case-sensitive — matches the
     imperative-rule register, not "the system always defaults to..." prose):
     - `Always <verb> ...` — covers AC-5 literal "Always include Y"
     - `Never <verb> ...` — covers AC-5 literal "Never skip Z"
     - `Default <verb> ...` — covers AC-5 literal "Default rule becomes X"

Tunable in `EXPLICIT_PATTERNS` in `behavior-rule-detector.ts`.

## Symbol categories surfaced by `findTouchpoints`

When the trigger fires, `findTouchpoints` extracts identifier-like substrings
from the AC and greps the codebase for them, plus any line that contains >= 2
distinct behavior keywords (catches comment-only sites). Symbol categories:

| Category | Example | Why include |
|----------|---------|-------------|
| Backticked symbols | `` `BUG_LABELS` ``, `` `phase-mapper.ts` `` | Verbatim from issue body — most specific |
| `SCREAMING_SNAKE_CASE` constants | `BUG_LABELS`, `DOCS_LABELS`, `SKIP_PHASES` | Dominant runtime-rule pattern |
| `camelCase` function names | `detectPhasesFromLabels`, `shouldSkipSpec` | Rule-implementing functions |
| File paths with extensions | `.claude/skills/assess/SKILL.md`, `phase-mapper.ts` | Direct touchpoint citations |
| Bold spans | `**always X unless Y**` | Author-emphasized rule statements |

## Inverse search (`findSurvivingInverseSymbols`, used by `/qa`)

`/qa` runs the detector against the diff blast radius (changed files +
optional 1-hop importers) using **inverse** keywords derived from each
asserted keyword. Asymmetric on purpose — an AC asserting the NEW rule
"always include spec" should look for "skip" / "exclude" / "bypass"
survivors, not "always" itself.

| Asserted keyword | Inverse search terms |
|------------------|----------------------|
| `default` | `skip`, `exclude`, `bypass`, `override` |
| `always` | `skip`, `never`, `exclude`, `conditional`, `shortcut` |
| `never` | `always`, `default`, `exclude` |
| `rule` | `exception`, `override`, `shortcut`, `bypass` |
| `behavior` | `legacy`, `deprecated` |
| `skip` | `always`, `default`, `exclude` |

High-noise common English words (`include`, `run`, `auto`, `old`,
`previous`) were pruned from this map after QA's self-dogfood pass on #552
returned 50 survivors entirely from definitional prose. As defense in
depth, `deriveInverseTerms` also drops any term in the `COMMON_WORDS`
filter at runtime, so future tunings that re-add a common word are still
filtered out.

A survival inside the diff blast radius -> AC `NOT_MET` with `path:line`
listed in the QA output (per AC-2 of #552).

## False-positive guards

- Test files (`*.test.ts`, `*.spec.ts`) are excluded from `findTouchpoints` —
  they implement *checks* of behavior rules, not the rules themselves.
- Walk-skip dirs: `node_modules`, `.git`, `dist`, `build`, `.next`,
  `coverage`, `__tests__`, `__snapshots__`.
- Common English words (`the`, `from`, `should`, `becomes`, ...) are filtered
  from the symbol-extraction pass to avoid grepping for "the".
- Per-file cap (3) + total cap (200) on `findTouchpoints` results — keeps
  `/spec` output readable when an AC's keywords are ambient in the repo.
- Total cap (50, `SURVIVOR_TOTAL_CAP`) on `findSurvivingInverseSymbols`
  results — tighter than `findTouchpoints` because survivors are surfaced
  inside the QA verdict and a long list drowns out the rule-relevant hits.

## Performance budget

- `detectBehaviorRule(ac)` is a cheap regex pass — runs per AC.
- `findTouchpoints` and `findSurvivingInverseSymbols` short-circuit to `[]`
  when `detectBehaviorRule` returns `triggered: false`.
- For `/qa`, the per-AC grep cost is bounded by the diff blast radius (not
  the whole repo). For `/spec`, scope is `src/lib`, `src/commands`, `bin`,
  and `.claude/skills` — `bin/` and `src/commands/` are included because CLI
  option registration (Commander.js `.option()` chains, `RunOptions` interface)
  is a recurring rule-drift site. `templates/skills/` and `skills/` are
  intentionally excluded since they 1:1 mirror `.claude/skills/`.

When zero behavior-rule ACs are detected across the issue, both detectors
should be skipped entirely (no per-file grep pass).

## Where to call from

- **`/spec`** — `### Rule Touchpoints (Conditional)` subsection under
  `## Context Gathering`. Calls `findTouchpoints` per AC; emits a
  `## Rule Touchpoints` section in the plan output when any hits found.
- **`/qa`** — `### 6e. Behavior-Rule Survival Check` between
  `### 6d. Adversarial Re-Read` and `### 7. A+ Status Verdict`. Calls
  `findSurvivingInverseSymbols` per behavior-rule AC; survivals -> AC
  `NOT_MET`, gated through `behavior_rule_survival_status` in section 7.

## API

```typescript
import {
  detectBehaviorRule,
  findTouchpoints,
  findSurvivingInverseSymbols,
} from "./src/lib/heuristics/behavior-rule-detector.ts";

// Cheap gate
const detection = detectBehaviorRule(ac);
// detection.triggered: boolean
// detection.keywords: BehaviorKeyword[]
// detection.matchedPattern?: string

// /spec: enumerate likely implementation sites
const hits = findTouchpoints(ac, repoRoot);
// hits: { path, line, snippet }[]

// /qa: search diff blast radius for OLD-rule survivors
const survivors = findSurvivingInverseSymbols(ac, repoRoot, diffPaths);
// survivors: { path, line, snippet }[]
```

## Known limitations

**Meta-recursion** — when an AC describes the detector itself (e.g. lists
all six trigger keywords as part of explaining the trigger condition),
`findSurvivingInverseSymbols` will self-fire on the new feature's own
definitional documentation. The pruned `INVERSE_KEYWORDS` map and
`SURVIVOR_TOTAL_CAP = 50` mitigate noise, but the heuristic cannot
distinguish "code that implements the OLD rule" from "documentation that
defines the rule". Treat survivors inside this reference doc and
`spec/SKILL.md` / `qa/SKILL.md` as definitional, not stale. See QA's
self-dogfood result on PR #607 for the original observation.

## Tuning

Edit `src/lib/heuristics/behavior-rule-detector.ts`:

- `BEHAVIOR_KEYWORDS` — keyword stem set (the source of truth)
- `KEYWORD_REGEXES` — per-stem inflection regex map; word-boundary
  guarded so identifier-shaped tokens (`defaultValue`, `skipperFn`) do
  not trigger
- `EXPLICIT_PATTERNS` — single-keyword override patterns (mid-sentence
  rule constructs + capitalized imperative AC openers)
- `INVERSE_KEYWORDS` — asserted -> inverse mapping for `/qa` (common
  English words filtered at runtime in `deriveInverseTerms`)
- `TOUCHPOINT_ROOTS` — directories scanned by `findTouchpoints`
- `SURVIVOR_TOTAL_CAP` — total survivor cap on `findSurvivingInverseSymbols`

Re-run `npx vitest run src/lib/heuristics` after tuning.
