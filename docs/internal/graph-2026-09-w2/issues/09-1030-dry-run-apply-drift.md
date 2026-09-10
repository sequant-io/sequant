# 09 — #1030 fix(sync): dry-run lists files apply never writes — the template walk maps `templates/opencode/**` to `.claude/opencode/**`

**Epic:** W2   **Blocked by:** #990   **Tier:** mechanical   **Doc:** W2 PLAN §4 (template sync seam), §5 I-2, §7 D14

## Why
`computeTemplateChanges` (`src/lib/templates.ts:194-225`) walks the **entire** templates tree with no skip list, so `templates/opencode/**` is mapped 1:1 to `.claude/opencode/**`. But the only real producer of the opencode shim is `init` (`src/commands/init.ts:145-175`, `:300-330`), which *renders* `templates/opencode/command.md` (`{{PHASE}}`) into `.opencode/commands/<phase>.md` and writes the plugin to `.opencode/plugin/`. Nothing in `src/`, `templates/` or `bin/` reads `.claude/opencode/`. Meanwhile `sync`'s apply path is `copyTemplates` (`templates.ts:600-665`) with a fixed directory list — skills, agents, hooks, memory, scripts, settings.json — that does not include `opencode` at all.

One root cause, four symptoms:

| Symptom | Effect |
|---|---|
| `sync --dry-run` lists files that `sync` never writes | dry-run ≠ apply — a direct violation of the ownership invariant (I-2: every decision visible in `--dry-run` *before* the write) |
| `serve` / version-preflight warns `N file(s) differ from bundled content` on every project that ran `init` before the shim existed | permanent nag on every downstream project since 2.13 |
| `update` "fixes" the nag by writing unrendered templates (`{{PHASE}}` ×4) to a path nothing reads | junk under `.claude/opencode/` |
| `sync` never refreshes the real `.opencode/` shim for projects that use `--agent opencode` | shim drifts silently across releases |

## Motivating example (verbatim, downstream project on 2.11.0 → 2.14.0, 2026-09-10; prompts stripped)

```
$ sequant sync --dry-run
Summary (dry-run):
  New files: 4
  Modified: 11
  Customizable (preserved): 1
New files:
  .claude/hooks/capture-tokens.sh
  .claude/opencode/command.md
  .claude/opencode/plugins/lib/sequant-hooks-core.ts
  .claude/opencode/plugins/sequant-hooks.ts

$ sequant sync
  preserved: .claude/memory/constitution.md — run `sync --force` to replace
✔ Synced to v2.14.0

$ npx sequant@latest serve
!  Version current, but 3 file(s) differ from bundled content
   Run: npx sequant sync --force (or npx sequant update)

$ npx sequant update
Summary:
  New files: 3
  Modified: 0
  ✓ Unchanged: 56
New files:
  .claude/opencode/command.md
  .claude/opencode/plugins/lib/sequant-hooks-core.ts
  .claude/opencode/plugins/sequant-hooks.ts
✔ Updated 3 files
```

After this, `grep -c '{{' .claude/opencode/command.md` → `4` in the downstream project. The three files were removed by hand.

## Scope
- may touch: `src/lib/templates.ts` (`computeTemplateChanges`, `copyTemplates`), `src/commands/sync.ts`, `src/commands/update.ts`, `src/commands/init.ts` (extract the shim renderer so one producer owns `.opencode/`), `src/commands/version-preflight.ts`; tests: `src/lib/templates.test.ts`, `src/commands/sync.test.ts`, `src/commands/update.test.ts` (new if absent), `src/commands/sync-source-invocation.integration.test.ts`.
- not in scope: opencode driver behavior; the `.opencode/` layout itself; #990's AGENTS.md / symlink work (this issue is blocked by it because both edit `templates.ts` and `sync.ts` — land after, rebase onto its merge).
- design call for the spec: either (a) `sync`/`update` reuse `init`'s renderer for `.opencode/` **when the project already has `.opencode/`**, or (b) `templates/opencode` is excluded from drift with a one-line reason and the shim is `init`-only. Pick one; both satisfy the ACs.

## Acceptance criteria
- [ ] AC-1: what `sync --dry-run` lists is exactly what `sync` then writes (same set of paths, customizable files excluded on both sides) — Verify: `npx vitest run src/commands/sync.test.ts -t "dry-run matches apply"` → on a temp project, the dry-run change set equals the post-sync diff of the tree. Mutation: add a template dir that `copyTemplates` skips → fails; restore.
- [ ] AC-2: no path under `.claude/opencode/` is ever produced by `computeTemplateChanges`, `sync` or `update` — Verify: `npx vitest run src/lib/templates.test.ts -t "opencode"` → change set contains no `.claude/opencode` entry; on a temp project after `update`, `test ! -e .claude/opencode`.
- [ ] AC-3: the shim has one producer — on a project with `.opencode/`, `sync` and `update` refresh `.opencode/commands/<phase>.md` **rendered** (no `{{PHASE}}`) and `.opencode/plugin/**`; on a project without `.opencode/`, they write nothing there — Verify: `npx vitest run src/commands/sync.test.ts -t "opencode shim"` → both cases; `grep -rc '{{' <tmp>/.opencode/commands/` → `0` for every file.
- [ ] AC-4: the version-preflight "differ from bundled content" count only counts files the apply path can write — a fresh `init` project (no opencode) followed by `serve` prints no differ warning — Verify: `npx vitest run src/commands/sync-source-invocation.integration.test.ts -t "no phantom drift"` → stderr has no `differ from bundled content`. Mutation: re-add the unfiltered walk → fails; restore.
- [ ] AC-5: no file written by `init`, `sync` or `update` contains an unrendered `{{…}}` placeholder — Verify: `npx vitest run src/lib/templates.test.ts -t "no unrendered placeholders"` → walks the temp project after each command, zero matches for `\{\{[A-Z_]+\}\}`.
- [ ] AC-6: suite green — Verify: `npm run build && npm test` → pass.

## Done when
`--dry-run` lists exactly what `sync`/`update` write, nothing ever lands under `.claude/opencode/`, and the opencode shim has exactly one producer that renders it.
