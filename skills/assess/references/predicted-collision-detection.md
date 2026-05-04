# Predicted file-collision detection

`/assess` Step 5 inspects two sources of overlap between PROCEED issues:

1. **Active-worktree overlap.** For each running worktree, `git diff --name-only main...HEAD` is intersected with the assessed issues' likely-touched files. Catches in-flight work.
2. **Predicted file-collision (this document).** For each pair of unstarted PROCEED issues, the detector reads issue bodies and predicts which pairs will modify the same file once both run in parallel worktrees.

This document is the tunable surface for the predicted-collision heuristic. The skill prose in `SKILL.md` names the detection functions; the patterns and the exclusion list live here so they can change without skill edits.

## Trigger

The detector runs automatically during Step 5 whenever ≥2 PROCEED issues are present in the assessment. Single-issue assessments skip it.

## Path-extraction heuristics

For each issue body, paths are extracted in this order:

### 1. Strip code blocks and HTML comments

Fenced code blocks (```` ``` … ``` ````) and HTML comments (`<!-- … -->`) are removed before any path matching. This is the **AC-5 false-positive guard**: paths quoted as code in prose count, paths inside a code block don't.

### 2. Backtick-quoted source paths (PATH_REGEX)

Backtick-quoted paths starting with one of the tracked roots and ending in a known source extension are extracted verbatim:

```
`(.claude|templates|skills|src|bin|docs)/<path-segment>+\.(md|ts|tsx|json|sh)`
```

Examples that match:

- `` `.claude/skills/assess/SKILL.md` ``
- `` `src/lib/foo.ts` ``
- `` `templates/scripts/dev/foo.sh` ``

Examples that **don't** match:

- `` `phase-mapper.ts` `` — no directory prefix; too generic to disambiguate
- `` `.claude/skills/**/*.md` `` — glob, not a literal path
- `` `references/foo.md` `` — `references` is not a tracked root (it lives under `skills/<name>/`)

### 3. Canonical bare form for skill files

Skill files have three byte-identical mirrors at `.claude/skills/<name>/...`, `templates/skills/<name>/...`, `skills/<name>/...`. Treating the mirrors as separate paths would produce 3× the `Order:` lines and 6× the warnings for one logical conflict.

The detector normalizes all three mirror prefixes to the bare subpath at extraction time:

| Input (in issue body) | Canonical |
|-----------------------|-----------|
| `` `.claude/skills/qa/SKILL.md` `` | `qa/SKILL.md` |
| `` `templates/skills/qa/SKILL.md` `` | `qa/SKILL.md` |
| `` `skills/qa/SKILL.md` `` | `qa/SKILL.md` |
| `` `qa/SKILL.md` `` (under 3-dir sync) | `qa/SKILL.md` |

This is the form that appears in `Order:` lines and `⚠` warnings.

### 4. Bare `<name>/SKILL.md` references (gated on 3-dir sync)

When the body also signals "3-dir sync" (regex below), bare skill-file mentions like `` `qa/SKILL.md` `` and `` `spec/SKILL.md` `` are added to the path set in canonical form. The 3-dir-sync gate prevents over-extraction from incidental skill-file references in prose.

3-dir-sync language is matched by:

```
/3[- ]dir(?:ectory)?\s+sync|across\s+all\s+three\s+skill\s+directories|across\s+(?:the\s+)?three\s+skill\s+directories/i
```

### 5. Slash-command-skill derivation (gated on 3-dir sync)

When the body signals 3-dir sync, every `/<skill>` slash-command mention is also added as `<skill>/SKILL.md` (canonical bare form) — provided `<skill>` matches a known skill name. This catches issues that describe section changes via `/qa Section 6c`-style notation rather than naming the file path.

The known-skill-name list lives in `KNOWN_SKILL_NAMES` in `src/lib/assess-collision-detect.ts`. Keep it in sync with the actual skill set under `skills/`. Adding a new skill? Append its name here.

Slash-command derivation requires the same fenced-code-block / HTML-comment stripping — `/qa` mentioned only inside a code block does **not** trigger derivation.

## False-positive guards

### Globally excluded paths

These paths are stripped from every issue's path set before pairwise intersection. They are paths that virtually every PROCEED issue tends to touch — including them would flag every batch as colliding and train users to ignore the warning.

- `CHANGELOG.md` — every PROCEED issue updates the unreleased section
- `package-lock.json` — alphabetically merged in practice; collisions are rare in practice
- `yarn.lock`
- `pnpm-lock.yaml`

`EXCLUDED_PATHS` in `src/lib/assess-collision-detect.ts` is the canonical list. To add or remove an entry, edit that constant; this document and the skill prose pick up the change automatically.

### Code block / HTML comment stripping

Step 1 of the extraction (above) removes all fenced code blocks and HTML comments before path matching. A path mentioned **only** inside one of those will not contribute to the issue's path set.

### Path-shape constraints

The PATH_REGEX requires a directory prefix (one of the six tracked roots) and a known source extension. Bare filenames in prose (e.g. "phase-mapper.ts behavior") and glob patterns (`**/*.md`) are not extracted.

## Tuning notes

- **Proximity weighting** is not implemented. The original feature design proposed weighting paths inside `- [ ] **AC-N:**` bullets higher than paths in "Motivation" or "Additional context". Adding it is a follow-up if the false-positive rate becomes a problem in practice; leave it out until evidence demands it.
- **Cost.** For 13 issues (the realistic batch ceiling), pairwise comparison is 78 pairs — cheap, no real performance concern. Don't optimize prematurely.

## Output rules

The detector returns `CollisionResult[]` from `detectFileCollisions`. The formatter (`formatCollisionAnnotations`) renders annotations in the dashboard format:

- `Order: A → B (path)` per pair (or `Order: A → B → C (path)` for 3+ on the same file). `path` is the canonical bare form (e.g. `qa/SKILL.md`).
- `⚠ #N  Modifies <path> (overlaps #M); land sequentially` per affected issue.
- `Chain: npx sequant run A B C --chain --qa-gate -q   # alternative — N issues modify <path>` only when ≥3 issues collide on the same file (suggest-only).

The bare-filename `Order:` exception (defined in the skill's "Annotation Rules") applies here — predicted collisions are file-collision reasons by definition, so the filename in parentheses is the reason verbatim.
