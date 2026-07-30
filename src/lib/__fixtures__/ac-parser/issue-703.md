## Context

#699 added per-shop focal points for thumbnails. AC-5 ("changing a shop's primary/curated image resets its focal point to center") is implemented in `updateShopImage` (`app/admin/shops/published/actions.ts`), which writes `image_focal_x/y = 50` alongside `curated_image_url`. It mirrors `updateMapImage`.

## The gap

`updateShopImage` is **never called** — there is no admin UI or live script today that swaps a shop's `curated_image_url` through it. So the reset is correct in code (and now unit-tested in `app/admin/shops/published/__tests__/actions.test.ts`) but has **zero runtime coverage**, and the contract isn't enforced anywhere.

The latent risk: when a future image-swap path lands (an admin "change image" UI, or an enrichment/re-enrichment script that overwrites `curated_image_url` directly), if it does **not** route through `updateShopImage`, a previously-saved focal point will silently carry onto the new, differently-composed photo — producing a badly-cropped thumbnail.

Today's `curated_image_url` writers are an archived one-off migration and an audit script (`lib/image-service.ts` only *reads* it), so nothing is actively broken — this is purely forward-looking.

## What to do (when an image-swap path is built)

- Route all `curated_image_url` writes through `updateShopImage` (or a shared query helper) so the focal reset is unavoidable, **or**
- Reset `image_focal_x/y` to NULL/50 in the same UPDATE wherever `curated_image_url` changes.

## Acceptance criteria

- [ ] Any new shop image-swap UI/script resets the focal point to center (50/50 or NULL) in the same write.
- [ ] A runtime/integration test exercises the reset through the real swap path.

## Out of scope

- Per-image focal points (still out of scope per #699).

