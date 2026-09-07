# 02 — #932 fix(run): drop the `?? "npm"` manifest fallback so lockfile detection runs

**Epic:** M0   **Blocked by:** —   **Tier:** mechanical   **Doc:** PLAN §5 I-4, I-5, §8 (orchestrator region :219), Lab §1

## Why
`src/commands/run.ts:102` substitutes `"npm"`, a valid `PM_CONFIG` key, so
`resolvePackageManager` never consults `pnpm-lock.yaml`. The shell path
(`new-feature.sh:206`) detects pnpm; the two provisioning paths disagree.

## Scope
- may touch: `src/commands/run.ts`, `src/lib/workflow/run-orchestrator.ts` (**only** the `manifest` type at :219 → `packageManager?: string`), `src/lib/stacks.resolve-package-manager.test.ts`, one new gate test file, `templates/skills/setup/SKILL.md`, `.claude/skills/setup/SKILL.md`, `skills/setup/SKILL.md`
- not in scope: `resolvePackageManager` itself; any other orchestrator line.

## Acceptance criteria
- [ ] AC-1: manifest without `packageManager` + `pnpm-lock.yaml` resolves to `pnpm install --frozen-lockfile` through the `run` path — Verify: `npx vitest run src/lib/stacks.resolve-package-manager.test.ts -t "932"` → passes; the test builds the orchestrator init the way `run.ts` does (no literal fallback) and asserts the resolved install command.
- [ ] AC-2: same for `yarn.lock` and `bun.lockb` per `LOCKFILE_PRIORITY` — Verify: same test, two more cases.
- [ ] AC-3: gate — no producer reintroduces the literal — Verify: `grep -rn 'packageManager ?? "npm"' src bin | wc -l` → `0`, asserted by a scoped gate test; PR body carries `Mutation-verified: AC-3 — re-added ?? "npm" at run.ts:102; <test> failed; restored.`
- [ ] AC-4: the setup skill writes `packageManager` next to `pmRun` in the manifest template — Verify: `grep -c 'packageManager' templates/skills/setup/SKILL.md` ≥ 1 inside the manifest template block, and `md5 -q templates/skills/setup/SKILL.md .claude/skills/setup/SKILL.md skills/setup/SKILL.md | uniq | wc -l` → `1`.

## Done when
A pnpm/yarn/bun worktree provisioned by `sequant run` installs with its own package manager, and a grep gate keeps the literal fallback out.
