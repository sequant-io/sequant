# 07 — #980-P2 release+docs(trust): provenance decision applied; "Security model" section in README and marketplace copy, banned-phrase gated

**Epic:** W2   **Blocked by:** GATE (node 06), #980-P1b (node 05)   **Tier:** mechanical   **Doc:** W2 PLAN §5 I-5/I-6, §7 D5, §9 OQ-4/OQ-5/OQ-9, §8 (README serialization)

## Why
#980 AC-6 and AC-7, executed exactly as gate 06 decided. Sequenced after node
05 so the README edits do not conflict (03 → 05 → 07).

## Scope
- may touch: `README.md` (new "Security model" section), the marketplace README
  source (located in this node's spec — OQ-9 — via `scripts/prepare-marketplace.ts`),
  `docs/THREAT-MODEL.md` (the provenance decision paragraph, if 06 chose
  "keep"), the `/release` skill in all three copies **only if** 06 chose
  "migrate" (I-4: three identical copies, `npm run lint:skill-sync` green),
  `CHANGELOG.md` (one bullet); tests: `src/lib/__tests__/security-docs.test.ts`
  (added cases).
- not in scope: landing-page changes (tracked on the landing repo per 06's
  answer); any hook; any other skill.

## Acceptance criteria
- [ ] AC-1 (AC-6 of #980): either provenance is visible on the next npm release (`npm view sequant --json | jq '.dist.attestations'` non-null after release) **or** `docs/THREAT-MODEL.md` contains a `## Release provenance` paragraph recording the keep-local decision and rationale — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "provenance"` → the paragraph is present when the gate chose "keep"; when "migrate", the `/release` skill diff is present in all three copies and `npm run lint:skill-sync` → pass.
- [ ] AC-2 (AC-7 of #980): README and the marketplace copy each gain a `## Security model` section linking `docs/THREAT-MODEL.md` and `SECURITY.md`, using the exact standards phrase from gate 06 — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "security-model-section"` → both locations contain the section and both links; the phrase matches the gate comment verbatim.
- [ ] AC-3: banned-phrase gate over README, marketplace copy, `SECURITY.md`, `docs/THREAT-MODEL.md` — none of `injection-proof`, `prevents prompt injection`, `immune`, `cannot be jailbroken`, `guaranteed`, `certified`, `compliant with` (case-insensitive) — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "banned-phrase"` → zero matches. Mutation: add `injection-proof` to README → fails; restore.
- [ ] AC-4: suite green — Verify: `npm run build && npm test` → pass.

## Done when
Every public trust surface carries the same architecture-only wording the
owner signed off, the provenance decision is either shipped or written down,
and a banned-phrase test keeps it that way.
