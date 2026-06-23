# Code Review Checklist

## Duplicate Utility Check

Before approving any new helper functions, components, or types, check:
1. `docs/patterns/HELPERS.md` - Does a similar helper already exist?
2. `docs/patterns/COMPONENTS.md` - Does a similar component already exist?
3. `docs/patterns/TYPES.md` - Does a similar type already exist?

If duplicates are found, flag as `AC_MET_BUT_NOT_A_PLUS` with recommendation to use existing utilities.

## Integration Verification

Before approving, verify the implementation integrates properly:

### 1. File Locations
Are new files in correct directories per `scripts/README.md` structure?
```bash
git diff main...HEAD --name-only | grep "^scripts/"
```

### 2. Pattern Compliance
Do new scripts follow existing patterns?
- Scripts: Database client setup, env validation, CLI flags (`--dry-run`, `--limit`)
- Components: Follow established admin patterns (List + Card + Modal)
- Compare with similar files: `ls scripts/fix/` or `ls components/admin/`

### 3. Documentation References
Check for dangling refs in CLAUDE.md:
```bash
grep -oE 'docs/[A-Z_]+\.md' CLAUDE.md | sort -u | while read f; do
  [ ! -f "$f" ] && echo "Missing: $f"
done
```

### 4. CLAUDE.md Updates Needed?
If adding new scripts/commands, should they be documented?
- New scripts in `scripts/` → Add to Common Commands section
- New patterns → Add to Key Patterns or patterns catalog

## Do NOT Nitpick

Skip trivial formatting if the repo already has automated formatting tools.

## Database Access Check

If project uses a database with access controls:
- Verify admin pages use admin/service client (not anonymous client)
- Check that sensitive tables are accessed with proper permissions
- Review any new database queries for proper authorization

## Integration Check

Verify new exports are imported somewhere using the Grep tool:
```
# 1. Get new files from git
new_files=$(git diff main...HEAD --name-only --diff-filter=A | grep -E "\.(ts|tsx)$" || true)

# 2. For each new file, use Grep to find exports:
#    Grep(pattern="export (const|function|class|type|interface)", path="<file>", output_mode="content")

# 3. For each export, use Grep to check if it's imported anywhere:
#    Grep(pattern="import.*<export_name>", glob="*.{ts,tsx}")
#    If no matches (excluding the source file), flag as unused export
```
