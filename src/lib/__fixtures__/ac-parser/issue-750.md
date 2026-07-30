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
