# Plugin Updates & Versioning

This document explains how Sequant plugin updates work, the versioning strategy, and how to handle breaking changes.

## Versioning Strategy

Sequant uses **synchronized versioning** across all distribution files:

| Source | Version Location | Example |
|--------|-----------------|---------|
| npm package | `package.json` | `"version": "1.11.0"` |
| Claude Code plugin | `.claude-plugin/plugin.json` | `"version": "1.11.0"` |
| Marketplace listing | `.claude-plugin/marketplace.json` → `plugins[0].version` | `"version": "1.11.0"` |

**All versions MUST match.** The CI pipeline enforces this check on every PR via `plugin-version-sync.ts`.

We follow [Semantic Versioning](https://semver.org/):

- **Patch** (1.11.0 → 1.11.1): Bug fixes, documentation updates
- **Minor** (1.11.0 → 1.12.0): New features, new skills, backwards-compatible changes
- **Major** (1.11.0 → 2.0.0): Breaking changes (see below)

## How Plugin Updates Work

### For Official Marketplaces (Default)

Plugins from Anthropic's official marketplace auto-update by default. Since Sequant uses a third-party marketplace (`sequant-io/sequant`), updates work differently.

### For Third-Party Marketplaces (Sequant)

Auto-update is **disabled by default** for third-party plugins. Users get updates in two ways:

#### 1. Manual Marketplace Update

```bash
# Update the marketplace catalog
/plugin marketplace update sequant-io/sequant

# Reinstall to get latest version
/plugin install sequant
```

#### 2. Enable Auto-Updates

Users can opt into auto-updates:

```json
// ~/.claude/settings.json
{
  "extraKnownMarketplaces": [
    {
      "source": "sequant-io/sequant",
      "autoUpdate": true
    }
  ]
}
```

With `autoUpdate: true`, the plugin will be updated when Claude Code restarts.

## Update Notifications

When a new version is available, users see a notification on Claude Code restart. This applies whether auto-update is enabled or not.

To disable all update notifications:
```bash
export DISABLE_AUTOUPDATER=true
```

## Pre-flight Skill Drift Check

Before most commands run, a `preAction` hook in `bin/cli.ts` checks whether the
installed skills match the bundled package (via `areSkillsOutdated`). There are
two distinct signals, handled differently:

| Signal | Detection | Action |
|--------|-----------|--------|
| **Version mismatch** | `.claude/skills/.sequant-version` ≠ package version | **Auto-sync (copy)** — `syncCommand({ quiet: true })` overwrites templates and bumps the marker. |
| **Content drift at a matching version** | Version marker matches, but `computeTemplateChanges` reports `new`/`modified` files | **Warn only** — a non-destructive message; no files are touched and `process.exitCode` is left unchanged. |

### Why content drift is warn-only (#713 / AC-3)

`areSkillsOutdated` originally compared only the version marker, so a tree at the
matching version with drifted bundled content (the #708 scenario) reported
`outdated: false` — no warning, no auto-sync. The pre-flight is now content-aware:
on a version match it runs the same `computeTemplateChanges` diff that `sequant
sync` uses (the single source of truth from #708/#710) and counts `new`+`modified`
files, **excluding** `local-override`/`unchanged` so customized files (e.g. an
in-place-customized `constitution.md`, #711) don't warn on every command.

**Auto-sync (copy) stays gated on version bumps only.** Content-only drift is
surfaced as a warning rather than auto-copied, for two reasons:

1. **Don't clobber in-place customizations (#711).** A blind copy on content drift
   would overwrite files a user has intentionally edited in place. The fix is left
   to the user (`sequant sync --force` / `sequant update` — a bare `sync` at a
   matching version is report-only), consistent with #708's report-only `sync`
   decision.
2. **The pre-flight must not fail the command it precedes.** Unlike `sequant sync`
   (which sets `process.exitCode = 1` on drift so CI can detect it), the pre-flight
   warning never changes the exit code — the user's actual command still runs and
   exits normally.

The `preAction` hook is **skipped entirely** for `init`, `sync`, and `update` —
those commands manage skills themselves, so the warn-only "run sync/update"
pre-flight would be a circular nag right before they do exactly that.

### Performance (#713 / AC-5)

The content diff is gated two ways. First by a **version match**: a version
mismatch already means stale (the copy path handles it), so the diff is skipped
entirely. Second, on a match, by a **stat-only fingerprint cache**: the full
read+render+diff scan (~15ms across the bundled templates) runs only when
something that can change drift actually changed.

`areSkillsOutdated({ cache: true })` — used only by the hot `preAction` path —
computes a SHA-1 over the package version plus the mtime (or absence) of every
bundled template, its installed counterpart, any `.claude/.local/` override, and
the config and manifest. If that fingerprint matches the cached one
(`.claude/.sequant/.skills-drift-cache.json`), the cached drift count is returned
without scanning (~4ms instead of ~15ms; measured ~5× faster). A **per-file** hash
(not a max-mtime) is used deliberately: editing an *older* file whose new mtime may
still trail another file's still changes the fingerprint, so a real drift is never
missed. When `sync`/`update` rewrite files, their mtimes bump and the cache
self-invalidates on the next command — no explicit cache-clearing needed.

The cache is **opt-in**. Diagnostic callers (`doctor`) and `sync` itself call
`areSkillsOutdated()` with no options and always run a fresh, uncached scan. The
fingerprint and cache I/O degrade gracefully: any error falls back to a fresh
scan, and a write failure (e.g. a missing `.claude/.sequant/` dir) is swallowed —
the cache never fails the command it precedes.

## Breaking Changes Policy

### What Constitutes a Breaking Change

- Removing a skill command (e.g., removing `/spec`)
- Changing skill input format (e.g., `/spec 123` → `/spec --issue 123`)
- Changing expected output format that other tools depend on
- Removing or renaming hook events
- Changing script interfaces in `scripts/`
- Removing required environment variables

### What Does NOT Constitute a Breaking Change

- Adding new skills
- Adding optional parameters to existing skills
- Adding new hooks
- Improving skill output (additional fields)
- Bug fixes that change incorrect behavior
- Documentation updates

### Breaking Change Process

1. **Major version bump** (1.x → 2.0)
2. **Migration guide** in CHANGELOG.md
3. **Deprecation period** when possible:
   - Old behavior continues working for 1-2 minor versions
   - Console warnings about upcoming removal
   - Clear migration instructions

### Example Migration Guide (CHANGELOG.md)

```markdown
## [2.0.0] - YYYY-MM-DD

### Breaking Changes

#### `/spec` output format changed

**Before (v1.x):**
```
## Implementation Plan
1. Step one
```

**After (v2.0):**
```
## Plan
### Steps
- Step one
```

**Migration:** Update any scripts that parse `/spec` output to use the new format.
```

## Changelog Automation

The changelog is maintained manually following [Keep a Changelog](https://keepachangelog.com/) format. The `/release` skill assists by:

1. Gathering commits since last tag
2. Categorizing by conventional commit prefix
3. Generating draft release notes
4. **User reviews and edits before publishing**

We intentionally avoid fully-automated changelogs because:
- Commit messages often need human editing for clarity
- Breaking changes need migration guides
- Users deserve thoughtful release notes

### Conventional Commits

Use these prefixes for commits to assist changelog generation:

| Prefix | Category | Example |
|--------|----------|---------|
| `feat:` | Added | `feat: add /security-review skill` |
| `fix:` | Fixed | `fix: /qa false positive on test files` |
| `docs:` | Documentation | `docs: update troubleshooting guide` |
| `perf:` | Performance | `perf: reduce /spec planning time` |
| `refactor:` | Changed | `refactor: simplify hook dispatch` |
| `BREAKING CHANGE:` | Breaking | `BREAKING CHANGE: remove /old-skill` |

## Plugin vs npm: When to Update Which

| Scenario | npm Update | Plugin Update |
|----------|------------|---------------|
| New skill added | ✅ | ✅ |
| Bug fix in skill | ✅ | ✅ |
| CLI command change | ✅ | ❌ (CLI is npm-only) |
| `sequant run` improvement | ✅ | ❌ |
| Hook script fix | ✅ | ✅ |
| TypeScript library change | ✅ | ❌ (library is npm-only) |

**Note:** The plugin only includes skills, hooks, and scripts. The CLI (`sequant run`, `sequant doctor`, etc.) is npm-only.

## Checking Your Version

### Plugin Version

In Claude Code:
```
/sequant:setup
# Shows plugin version at startup
```

Or check the marketplace:
```
/plugin list
# Shows installed version
```

### npm Version

```bash
npx sequant --version
# or
npx sequant status
```

## Troubleshooting Updates

### Plugin Not Updating

1. Verify marketplace is registered:
   ```
   /plugin marketplace list
   ```

2. Force marketplace refresh:
   ```
   /plugin marketplace update sequant-io/sequant
   ```

3. Reinstall plugin:
   ```
   /plugin uninstall sequant
   /plugin install sequant
   ```

### Version Mismatch Between npm and Plugin

If you have both installed, they may drift apart. This is fine — they're independent:

- **Plugin** provides skills in Claude Code interactive sessions
- **npm** provides CLI for headless operation (`sequant run`)

Upgrade each independently:
```bash
# npm
npm update -g sequant

# Plugin (in Claude Code)
/plugin marketplace update sequant-io/sequant
/plugin install sequant
```

### Downgrading

#### Plugin

Remove and reinstall a specific version (if available in marketplace):
```
/plugin uninstall sequant
/plugin install sequant@1.10.0
```

#### npm

```bash
npm install -g sequant@1.10.0
```

## Release Schedule

Sequant does not follow a fixed release schedule. Releases happen when:

- Critical bug fixes are ready
- New features are complete and tested
- Breaking changes have accumulated (for major versions)

Subscribe to releases on GitHub for notifications:
1. Go to https://github.com/sequant-io/sequant
2. Click "Watch" → "Custom" → select "Releases"
