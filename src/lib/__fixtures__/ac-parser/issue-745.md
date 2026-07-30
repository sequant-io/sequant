## Problem

The Places photo media URL (`https://places.googleapis.com/v1/{photo.name}/media?maxWidthPx=...`) is hand-built at 6+ call sites with inconsistent resolution caps:

| Site | Cap |
|------|-----|
| `scripts/enrichment/re-enrich-photos.ts` | 3200 (master) / 1200×800 (gallery) — fixed in #716 |
| `scripts/enrichment/backfill-master-dimensions.ts` | 3200 (`buildMasterMediaUrl`, added in #716) |
| `scripts/enrichment/auto-enrich-shops.ts:197` | 1200×630 |
| `scripts/pipeline/steps/enrichment.ts:145` | 1200×630 |
| `scripts/fix/fix-empty-images.ts:78` | 1200×800 |
| `scripts/fix/fix-image-urls.ts:78` | 1200 |
| `scripts/utils/verify-shop-images.ts:301` | 1200 |
| `lib/admin/shop-publisher.ts:232,292` | 2400 |

The 1200px caps are the root cause of the undersized-master problem #716 backfilled. New shops entering via `auto-enrich`/pipeline still get 1200×630 `image_url` on `pending_shops` (the publish path at 2400 partially compensates), and any new call site is likely to copy a stale cap.

## Acceptance Criteria

- [ ] **AC-1:** A single shared helper `buildPhotoMediaUrl(photoName, opts)` exists in one module and is the only place the `places.googleapis.com/v1/{photo.name}/media` URL is constructed.
- [ ] **AC-2:** The helper accepts either a single `maxPx` cap or a `width`/`height` pair, and documents the master-vs-gallery policy in one place: master 3200 per #716, gallery 1200x800.
- [ ] **AC-3:** All eight call sites listed in the table above import the helper and no longer build the media URL by hand.
- [ ] **AC-4:** A repo-wide search for `places.googleapis.com` and `maxWidthPx` returns no hand-built media URL outside the helper and its tests.
- [ ] **AC-5:** Consumers of `pending_shops.image_url` are enumerated in the PR description, so the 1200x630 pipeline cap can be changed deliberately rather than incidentally.
- [ ] **AC-6:** Unit tests cover the master cap, the gallery width/height form, and that an invalid or empty `photoName` is rejected rather than producing a malformed URL.

## Non-Goals

- Changing the 1200x630 cap on the `auto-enrich`/pipeline path — AC-5 only enumerates the consumers; the cap change itself is a separate issue.
- Backfilling or re-enriching existing photo rows; #716 already covered that.
- Any change to Cloudinary transformation URLs, which are a different construction path.

## Context

Surfaced as a cross-file sibling-site finding during #716 spec/QA (kept out of that PR for scope discipline). Same consolidation pattern as #728 (slug) and #730 (retry/throttle).

<sub>Acceptance Criteria restructured into ID-anchored form so the AC parser can read them; see sequant-io/sequant#850 for why the original checkbox form parsed to zero.</sub>

