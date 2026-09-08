# 01 — #981 fix(hooks): scope commit-message extraction to the `git commit` segment

**Epic:** M0   **Blocked by:** —   **Tier:** mechanical   **Doc:** PLAN §4 (hook seam), §5 I-4, Lab §1

## Why
Both repros exit 2 on main with the wrong `Got:` text (Lab §1). The extractor at
`templates/hooks/pre-tool.sh:919-931` reads the whole `TOOL_INPUT`; `seg_match`
already isolates the `git commit` segment.

## Scope
- may touch: `templates/hooks/pre-tool.sh`, `.claude/hooks/pre-tool.sh`, `hooks/pre-tool.sh`, `__tests__/pre-tool-hook.integration.test.ts`
- not in scope: any other guard in the hook; weakening the conventional-commit pattern.

## Acceptance criteria
- [ ] AC-1: the Finding §1 repro (earlier `echo "…"`, then a valid `git commit -m "fix(#943): …"`) is allowed — Verify: `npx vitest run __tests__/pre-tool-hook.integration.test.ts -t "981"` → the AC-1 case asserts exit 0 with the verbatim command from the issue body.
- [ ] AC-2: the Finding §2 repro (valid commit followed by `&& python3 - <<'PYEOF'`) is allowed — Verify: same test file, AC-2 case asserts exit 0.
- [ ] AC-3: `git add -A && git commit -m "updated stuff"` inside a compound command is still blocked with `Got: updated stuff` — Verify: same file, AC-3 case asserts exit 2 and the `Got:` line names the real message.
- [ ] AC-4: `git commit -m "$(cat <<'EOF' … EOF)"` still validates the heredoc's first line — Verify: same file, AC-4 case asserts exit 0 for a conventional first line and exit 2 for a non-conventional one.
- [ ] AC-5: three copies identical — Verify: `md5 -q templates/hooks/pre-tool.sh .claude/hooks/pre-tool.sh hooks/pre-tool.sh | uniq | wc -l` → `1`.
- [ ] AC-6: the existing commit-format cases stay green — Verify: `npx vitest run __tests__/pre-tool-hook.integration.test.ts` → all pass.

## Done when
A valid conventional commit is never blocked because of text outside its own `git commit` segment, and a non-conventional one still is, in all three hook copies.
