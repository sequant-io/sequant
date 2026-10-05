# QA Review: notes export and serve

**Verdict:** AC_MET_BUT_NOT_A_PLUS

### AC Coverage

| AC | Status | Notes |
|----|--------|-------|
| AC-1 | ⚠️ Partial | see issues |
| AC-2 | ⚠️ Partial | see issues |
| AC-3 | ✅ Met | |
| AC-4 | ⚠️ Partial | see issues |
| AC-5 | ✅ Met | |

### Issues

- `formatNotes` is called with `"json"` when `--format md` is passed, because the comparison is against `"markdown"`.
- `parseSinceDate` is defined but never called, so `--since` has no effect.
- The preview server listens on `0.0.0.0`; bind it to `127.0.0.1`.
- The `serve` command has no `--help` example in the README.
- `cli.ts` imports are not sorted alphabetically.

### Recommendation

Fix the three issues above before merge.
