# Upstream Skill - Claude Code Release Tracking

**Quick Start:** Monitor Claude Code releases for breaking changes, new features, and opportunities that affect sequant. Run weekly via GitHub Actions or manually with `/upstream`.

## Access

- **Command:** `/upstream` or `npx tsx scripts/upstream/assess.ts`
- **Automation:** GitHub Actions workflow (weekly Monday 9am UTC)
- **Permissions:** Requires `gh` CLI authenticated with repo access

## Usage

### Assess Latest Release

```bash
/upstream
```

Fetches the latest Claude Code release and analyzes it against sequant's capabilities baseline.

### Assess Specific Version

```bash
/upstream v2.1.29
```

Analyzes a specific release version.

### Catch-Up Assessment

```bash
/upstream --since v2.1.25
```

Assesses all releases since the specified version. Useful when catching up after multiple releases.

### Preview Mode (Dry Run)

```bash
/upstream --dry-run
```

Generates assessment report without creating GitHub issues. Use this to preview what would be created.

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--dry-run` | Generate report without creating issues | Off |
| `--force` | Re-assess even if already assessed | Off |
| `--since <version>` | Assess all versions since specified | None |
| `--help` | Show usage information | - |

## Output

### Assessment Report

Each assessment creates:

1. **GitHub Issue** - Summary with all findings categorized
2. **Local Report** - Saved to `.sequant/upstream/<version>.md`
3. **Individual Issues** - One per actionable finding (labeled `upstream`, `needs-triage`)

### Finding Categories

| Category | Description | Action |
|----------|-------------|--------|
| **Breaking Changes** | Changes that may break sequant | Immediate review |
| **Deprecations** | Features being removed we depend on | Migration planning |
| **New Tools** | New Claude Code tools we could use | Opportunity evaluation |
| **Hook Changes** | Updates to hook system | Impact assessment |
| **Opportunities** | Features sequant could leverage | Backlog addition |
| **No Action** | Changes not affecting sequant | None |

## Common Workflows

### Weekly Automated Check

The GitHub Action runs every Monday at 9am UTC:

1. Fetches latest Claude Code release
2. Compares against last assessed version
3. Runs `--since` to catch any missed releases
4. Creates issues for actionable findings
5. Commits updated baseline and reports

### Manual Assessment After Major Release

1. Run `/upstream v2.x.x --dry-run` to preview
2. Review findings in console output
3. Run `/upstream v2.x.x` to create issues
4. Triage created issues (remove `needs-triage` label)

### Updating the Baseline

The baseline at `.sequant/upstream/baseline.json` defines what sequant uses:

```json
{
  "lastAssessedVersion": "v2.1.29",
  "tools": { "core": ["Task", "Bash", ...], "optional": [...] },
  "hooks": { "used": ["PreToolUse"], "files": [...] },
  "keywords": ["Task", "hook", "permission", ...],
  "dependencyMap": { "permission": ["src/hooks/..."], ... }
}
```

Update this when sequant adds new dependencies on Claude Code features.

## Troubleshooting

### "GitHub CLI is not installed"

**Symptoms:** Error message about missing `gh` CLI

**Solution:** Install GitHub CLI from https://cli.github.com/

### "GitHub CLI is not authenticated"

**Symptoms:** Error about authentication

**Solution:** Run `gh auth login` and follow prompts

### Assessment finds no changes

**Symptoms:** All findings are "no-action"

**Solution:** This is normal for minor releases. The baseline keywords may need updating if important changes are missed.

### Duplicate issues being created

**Symptoms:** Similar issues already exist

**Solution:** The skill checks for duplicates using title similarity. If duplicates appear, the similarity threshold (60%) may need adjustment.

---

*Generated for Issue #222 on 2026-02-01*
