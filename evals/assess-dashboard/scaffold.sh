#!/usr/bin/env bash
# Scaffolds the assess-dashboard eval case (#993 AC-3).
#
# Per the runner's answer to the spec's Open Question 1: the issues are fed as
# FILES the scaffold lays down, never via a live `gh` call — the eval grant
# stays `--allow-tools Write`, so a `Bash(gh *)` widening (which would put real
# `gh issue comment` in reach of a standalone skill branch) never happens.
#
# Both fixture bodies are verbatim real issue bodies already committed to this
# repo under src/lib/__fixtures__/ac-parser/ — real prose, not synthetic, per
# the repo's motivating-example fixture discipline.
set -euo pipefail

git init -q
git config user.email "eval@example.com"
git config user.name "Eval Scaffold"
echo "# throwaway target repo" > README.md
git add README.md
git commit -q -m "base"

cat > ISSUE-686.md <<'ISSUE_686_EOF'
## Context

Architecture retrospective (June 2026) found `types/database.ts` is hand-maintained, costing ~18 separate `fix: ...type...` commits over the project's life and requiring a dedicated CLAUDE.md ritual (regen destroys custom aliases → manual restore from `git show HEAD:types/database.ts | tail -200`).

This is a **self-inflicted, recurring maintenance tax** that a CI step retires permanently.

## Goal

Auto-generate the Supabase types section in CI/build instead of by hand, while preserving the custom type-alias section (Shop, MatchaMap, ShopHours, etc.).

## Acceptance Criteria

- [ ] An `npm run gen-types` script runs `supabase gen types typescript` (or MCP equivalent) and writes the auto-generated section only
- [ ] Custom aliases below `export const Constants` are preserved (split file, codegen marker comment, or concatenation step)
- [ ] Documented in CLAUDE.md replacing the manual restore ritual
- [ ] (Optional) CI check fails if committed types drift from a fresh generation

## Scope

Small — one script + a marker convention + docs edit. Do NOT redesign the type system.

## Why now

Forward-discipline item from the retrospective: stop spending in self-inflicted maintenance categories.

ISSUE_686_EOF

cat > ISSUE-750.md <<'ISSUE_750_EOF'
Split from #748, which shipped the rating half of #704 §5. The rating row and `AggregateRating` are live in #749; the **theme chips** ("great usucha", "calm vibe", "pricey") were deliberately left out.

## Why they were split

Chips need review *text*. #748 needed only two scalars, which the Places field mask already returned. Chips need a different class of input entirely:

1. **The current field mask doesn't request reviews.** `scripts/pipeline/steps/enrichment.ts` and `scripts/enrichment/auto-enrich-shops.ts` request `websiteUri,regularOpeningHours,photos,rating,userRatingCount`. Adding `reviews` moves the call to a more expensive Places billing SKU.
2. **Google's Places terms restrict caching review content**, more tightly than the aggregate rating already being stored. Persisting review text long enough to run an LLM pass over it needs a deliberate answer, not an assumption.
3. **It's a new AI content subsystem**, with the fabrication risk that implies. `docs/CONTENT_SYSTEM.md` exists precisely to stop content scripts multiplying — this needs to fit that system, not sit beside it.

## What §5 actually asks for

Chips express *recurring* sentiment, not a summary of one review. That means a frequency threshold across reviews, not "ask an LLM what this place is like" — the latter fabricates confidently and reads plausible, which is the worst failure mode for a trust-driven directory.

## Open questions before any implementation

- [ ] Does the Places ToS permit retaining review text long enough to extract themes? If not, is extract-then-discard (store only the derived chips, never the source text) acceptable?
- [ ] Frequency floor — how many reviews must mention a theme before it's a chip?
- [ ] Fixed vocabulary or open-ended? Fixed is auditable and dedupes cleanly; open-ended is richer but unbounded.
- [ ] Manual curation for NYC only, as a cheaper first pass? Aligns with the NYC-first wedge and produces the ground truth an automated pass would need for evaluation anyway.
- [ ] How do chips get re-derived as reviews accumulate? (`rating_updated_at` from #748 is the precedent.)

## Prerequisite — already done

#748 / #749 landed `rating`, `review_count`, `rating_updated_at` on `shops`, plus `buildRatingFields()` as the single ingestion mapper. Chips would extend that path rather than open a new one.

## Placement

`components/ShopRatingRow.tsx` is where they'd go — directly beneath the rating, per #704 §4's ordering. Whatever gates them must satisfy §4's "never render empty sections", the same way `shouldDisplayRating()` does today.

Refs #704, #748, #749
ISSUE_750_EOF
