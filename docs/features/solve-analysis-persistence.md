# Solve Analysis Persistence

**Quick Start:** `/solve` now saves its workflow analysis as structured comments on GitHub issues, so `/spec` can read and reuse the recommendation instead of re-analyzing from scratch.

## Access

- **Command:** `/solve <issue-numbers>`
- **Requires:** `gh` CLI authenticated
- **Added in:** Issue #172

## Usage

### Saving Analysis to Issues

After `/solve` displays its recommendation in the terminal, it prompts:

```
Save this plan to the issues? [Y/n]
```

- **Yes:** Posts a structured comment to each analyzed issue with machine-readable HTML markers
- **No:** Terminal output only (previous behavior)

### Comment Format

The posted comment includes:

```markdown
## Solve Analysis

**Recommended Phases:** exec → qa
**Skip Spec:** Yes (trivial fix)
**Browser Testing:** No
**Quality Loop:** No

### Reasoning
- Title contains "Fix unused variable" → trivial fix pattern

### Flags
| Flag | Value | Reasoning |
|------|-------|-----------|
| -q (quality-loop) | ✗ | Simple fix |

<!-- solve:phases=exec,qa -->
<!-- solve:skip-spec=true -->
<!-- solve:browser-test=false -->
<!-- solve:quality-loop=false -->
```

The HTML comment markers (`<!-- solve:... -->`) are machine-readable and parsed by downstream skills.

### How `/spec` Uses Solve Analysis

When `/spec` runs on an issue, it checks for a solve analysis comment before making its own recommendation:

1. If a solve comment exists, `/spec` uses it as a starting point
2. `/spec` can override the recommendation but must document why
3. If solve recommended `skip-spec=true`, spec acknowledges this but proceeds (since it was explicitly invoked)

## Options & Settings

| Marker | Values | Consumed By |
|--------|--------|-------------|
| `solve:phases` | Comma-separated phase names | `/spec` phase detection |
| `solve:skip-spec` | `true` / `false` | `/spec` skip logic |
| `solve:browser-test` | `true` / `false` | `/spec` test planning |
| `solve:quality-loop` | `true` / `false` | `/spec` quality loop |

## Common Workflows

### Multi-Issue Analysis with Persistence

```bash
# Analyze multiple issues and save recommendations
/solve 113 114 115
# → Terminal shows recommendations for each issue
# → Prompted to save
# → Comments posted to #113, #114, #115

# Run with solve-informed phases
npx sequant run 113 114 115
# → /spec reads solve comments and uses tailored phases per issue
```

### Override Solve Recommendation

If `/spec` disagrees with solve's recommendation (e.g., solve said skip spec but spec detects UI changes), the override is documented:

```markdown
## Recommended Workflow

**Phases:** spec → exec → test → qa
**Reasoning:** Solve recommended `exec → qa`, but codebase analysis reveals
UI components are affected, so browser testing is needed.
```

## Troubleshooting

### Solve comment not detected by `/spec`

**Symptoms:** `/spec` makes its own recommendation, ignoring a saved solve comment

**Solution:** Verify the comment contains the `## Solve Analysis` header or `<!-- solve:phases=... -->` HTML markers. Both formats are recognized.

### Old-format solve comments

**Symptoms:** Comments with `## Solve Workflow for Issues:` header

**Solution:** Both old and new formats are supported. The parser recognizes `## Solve Workflow for Issues:`, `## Solve Analysis`, and HTML markers.

---

*Generated for Issue #172 on 2026-03-11*
