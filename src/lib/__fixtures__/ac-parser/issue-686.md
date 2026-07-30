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

