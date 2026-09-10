# 03 — #980-P0 docs(trust): `SECURITY.md` + public threat model with OWASP Agentic mapping, citation-gated

**Epic:** W2   **Blocked by:** —   **Tier:** judgment   **Doc:** W2 PLAN §4 (trust seam), §5 I-5/I-6, §7 D5/D8, §9 OQ-8, Lab §1

## Why
The posture is real — 16 distinct deterministic `HOOK_BLOCKED` guards in
`templates/hooks/pre-tool.sh`, a required Trust-Boundary Check
(`templates/skills/qa/SKILL.md` §6f, `:2378`), an eval case with deterministic
graders (`evals/qa-trust-boundary/`), MCP secrets isolation (#936), worktree
isolation, a human merge gate — and none of it is readable: no `SECURITY.md`,
no threat model, no standards mapping (Lab §1). This is the #943 "contract
nobody can read" failure applied to security. The load-bearing move is the
classification of every defense as **deterministic** (holds if the model is
fully compromised) or **model-dependent**, with residual risks stated instead
of implied away.

This node is #980's P0 slice (AC-1..3 of the parent). AC-4 → node 04, AC-5 →
node 05, AC-6/7 → gate 06 then node 07 (PLAN D5).

## Scope
- may touch: `SECURITY.md` (new), `docs/THREAT-MODEL.md` (new), `README.md`
  (one link line only — the "Security model" section is node 07's),
  `CHANGELOG.md` (one bullet); tests: new
  `src/lib/__tests__/security-docs.test.ts`.
- not in scope: any hook, skill, workflow, eval or release file; the OpenSSF
  badge (05); provenance (07); marketplace/landing copy (07).
- source of truth is the tree, not the issue: every count and citation is
  taken from files on disk at the PR's HEAD.

## Acceptance criteria
- [ ] AC-1: `SECURITY.md` exists at the repo root with delimited sections `## Reporting a vulnerability` (contact + what to include), `## Response expectations` (acknowledgement and triage windows), `## Supported versions` (table), and README links it — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "AC-1"` → each section present between its heading and the next, contact line non-empty, `README.md` contains `SECURITY.md`. Mutation: delete the contact line → fails; restore.
- [ ] AC-2: `docs/THREAT-MODEL.md` lists the untrusted-input surfaces phase agents read (issue bodies, issue/PR comments, repo file contents, tool output, dependencies) and, between `<!-- defenses:begin -->` / `<!-- defenses:end -->`, a table with columns `Defense | Enforcer | Class | Residual risk` where every `Enforcer` cell cites a path (and, for skills, a `§` anchor; for settings, a key) that resolves on disk and `Class` is exactly `deterministic` or `model-dependent`; a `## Residual risks` section follows — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "AC-2"` → every cited path exists, every cited skill anchor's heading exists in that file, every settings key exists in `src/lib/settings.ts`, every `Class` cell is one of the two values. Mutation: point one row at a nonexistent path → fails; restore.
- [ ] AC-3: the threat model contains, between `<!-- owasp:begin -->` / `<!-- owasp:end -->`, a table mapping every category of the OWASP Top 10 for Agentic Applications (2026) to either a control citation or an explicit `out of scope — <whose layer>` disposition, with the OWASP source URL cited above the table — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "AC-3"` → exactly 10 data rows, no empty disposition cell, URL present. Mutation: blank one disposition → fails; restore. (OQ-8: the category list is pinned from the OWASP source in this node's spec.)
- [ ] AC-4: counts in the doc are computed, not typed — the deterministic-guard count stated in the threat model equals the number of distinct `HOOK_BLOCKED:` messages in `templates/hooks/pre-tool.sh` — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "AC-4"` → the test recomputes `grep -o 'HOOK_BLOCKED: [A-Za-z][^"]*' templates/hooks/pre-tool.sh | sort -u | wc -l` (16 today) and compares to the number in the doc's `<!-- guards:count -->` slot. Mutation: change the doc's number → fails; restore.
- [ ] AC-5: no immunity claims — `SECURITY.md` and `docs/THREAT-MODEL.md` contain none of `injection-proof`, `prevents prompt injection`, `immune`, `cannot be jailbroken`, `guaranteed` (case-insensitive) — Verify: `npx vitest run src/lib/__tests__/security-docs.test.ts -t "AC-5"` → zero matches. Mutation: add `injection-proof` to the doc → fails; restore.
- [ ] AC-6: README gains exactly one line linking both documents — Verify: `grep -c "SECURITY.md" README.md` → `1`; `grep -c "THREAT-MODEL.md" README.md` → `1`.
- [ ] AC-7: suite green — Verify: `npm run build && npm test` → pass.

## Done when
A security reviewer can read, from two files, which controls hold when the
model is compromised and which do not, and every claim in them resolves to a
file, anchor or key that CI checks.
