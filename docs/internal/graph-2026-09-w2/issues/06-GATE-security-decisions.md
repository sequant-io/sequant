# 06 — GATE: security-contract decisions (human)

**Epic:** W2   **Blocked by:** #980-P0 (node 03)   **Tier:** human   **Doc:** W2 PLAN §2, §7 D5, §9 OQ-4/OQ-5, §8 (human gate form)

## Artifact reviewed
`docs/THREAT-MODEL.md` and `SECURITY.md` as merged by node 03, plus the README
diff from that PR.

## Questions the human answers
1. **Trusted publishing (OQ-4):** migrate releases to npm trusted publishing
   with provenance (repo→npm OIDC replaces the interactive 2FA publish; the
   `/release` skill changes), or keep local publishing and record the decision
   in the threat model?
2. **Standards wording (OQ-5):** sign off the exact public phrase for standards
   alignment. Candidate: "mapped to the OWASP Top 10 for Agentic Applications
   (2026)". Anything reading as endorsement, compliance or certification is
   rejected.
3. **Landing ride-along:** does the landing-page half of the trust copy ride
   the open landing follow-up, or wait for it?

## Accept route
- Decisions recorded as a comment on this gate; node 07 executes them (AC-6
  branch chosen, AC-7 phrase fixed, landing in/out).

## Reject route
- Wording or classification problems in the threat model reopen node 03 with
  the failing row as the motivating example. No new issue is filed without a
  W2 PLAN §7 decision row.

## Verify (for the runner, not the human)
- `test -f SECURITY.md && test -f docs/THREAT-MODEL.md && echo ok` → `ok`, and
  `npx vitest run src/lib/__tests__/security-docs.test.ts` green on `main`
  before the gate is presented.
