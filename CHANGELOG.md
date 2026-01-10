# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-01-10

### Added
- **Non-interactive mode & TTY detection** (#8)
  - Graceful fallback to defaults when stdin/stdout is not a TTY
  - Detects 12 CI environments (GitHub Actions, GitLab CI, CircleCI, etc.)
  - `--interactive` flag to force prompts in non-TTY environments
  - Clear messaging about why non-interactive mode was detected
- **Bun package manager support** (#6)
  - Auto-detects `bun.lockb` during `sequant init`
  - Uses `bun test`, `bun run build`, etc. for Bun projects
- **New stack detection** (#11)
  - SvelteKit (detects `svelte.config.js` + `@sveltejs/kit`)
  - Remix (detects `remix.config.js` or `@remix-run/react`)
  - Nuxt (detects `nuxt.config.ts` or `nuxt` dependency)
- **Claude Code CLI check** in `sequant doctor` (#3)
  - Verifies `claude` command is available
  - Shows install instructions if missing
- **PR verification** in `/exec` skill (#26)
  - Checks for existing PRs before creating duplicates
  - Validates branch state before pushing
- **Worktree isolation** for multi-issue workflows (#31)
  - Each issue gets isolated git worktree
  - Prevents cross-contamination between parallel issues
  - `scripts/dev/new-feature.sh` helper for worktree creation
- **`--stash` flag** for `new-feature.sh` (#41)
  - Automatically stashes uncommitted changes before creating worktree
- **Reference documentation**
  - MCP browser testing patterns (#39)
  - Framework gotchas reference (#38)

### Changed
- Workflow skills updated for sequant automation patterns

### Fixed
- SDK session no longer incorrectly resumed when switching worktrees
- Issue info JSON parsing no longer requires jq

## [1.1.3] - 2025-01-09

### Added
- Settings file (`.sequant/settings.json`) for persistent run preferences
  - Created during `sequant init`
  - Preserved across `sequant update`
- Spec-driven phase detection for intelligent workflow selection
  - `/spec` now outputs `## Recommended Workflow` section
  - `sequant run` parses spec output to determine subsequent phases
  - Bug fixes (labels: `bug`, `fix`) skip spec and run `exec → qa` directly
- `--no-log` flag to disable JSON logging for a single run

### Changed
- JSON logging now enabled by default (`logJson: true` in settings)
- Replaced static `phases` setting with `autoDetectPhases: true`
- Updated `/solve` skill to use `npx sequant` as primary CLI command
- Added global install tip for frequent users
- Changed CLI run emoji to 🌐

### Fixed
- CLI now works correctly with local install via `npx sequant`

## [1.1.2] - 2025-01-08

### Added
- Structured JSON logging for `sequant run` with Zod schema validation
  - `--log-json` flag to enable JSON log output
  - `--log-path` option to specify custom log directory
  - Logs include run metadata, phase timing, issue status, and summary stats
- `sequant logs` command to view and analyze run history
  - List recent runs with `sequant logs`
  - View specific run with `sequant logs <run-id>`
  - Filter by issue with `--issue <number>`
- Pre-flight git state checks in `/fullsolve` and `/exec` skills
  - Prevents duplicate work after context restoration
  - Verifies recent commits, existing PRs/branches before starting
- Output verification checklists to all 14 skills
- Unit tests for run-log-schema (58 tests) and LogWriter (41 tests)

### Changed
- `sequant update` now auto-runs `npm install` when package.json changes

### Fixed
- Pre-tool hook now correctly detects git status in worktree directories
  - Fixes false "no changes to commit" errors when committing from worktrees

## [1.1.1] - 2025-01-08

### Changed
- Extracted `commandExists`, `isGhAuthenticated` to shared `src/lib/system.ts`
- Platform-specific install hints (macOS/Linux/Windows) for gh and jq
- Improved test mocking by using system.ts instead of child_process

### Added
- `getInstallHint(pkg)` function for platform-aware install commands
- npm 2FA publishing documentation in CONTRIBUTING.md

## [1.1.0] - 2025-01-08

### Added
- Prerequisite checks in `sequant doctor` for gh CLI, authentication, and jq
- Prerequisite warnings in `sequant init` for missing dependencies
- Optional jq suggestion in init success message
- Unit tests for doctor and init prerequisite checks

### Changed
- `release.sh` now dynamically detects GitHub repo from git remote
- README updated with prerequisite information and jq as optional dependency

### Fixed
- TypeScript errors in doctor.test.ts mock types

## [1.0.0] - 2025-01-07

### Changed
- **BREAKING:** Removed all project-specific content from skill templates
  - Replaced shop/supabase examples with generic item/database terminology
  - Skills now portable for any project type
- Made MCP tools optional across all skills
  - Context7 and Sequential Thinking documented as optional enhancements
  - Skills work without any MCP servers configured
- Rewrote `/solve` skill to be advisory-only (no script generation)
- Replaced hardcoded URLs with `{{DEV_URL}}` token placeholder

### Removed
- Supabase MCP tool requirements from all skills
- Dead code: `workflow-queries.ts` (Supabase-only)
- Project-specific examples (shops, pending_shops, content_ideas)

### Added
- `sequant run` command for batch issue execution (AC-10)
  - Sequential and parallel execution modes
  - Custom phase selection (`--phases`)
  - Dry-run mode (`--dry-run`)
  - Verbose output (`--verbose`)
- Cross-platform support documentation (AC-11)
  - Platform requirements in README
  - Path handling fixes for Windows compatibility
- Stack-specific documentation (AC-12)
  - `docs/stacks/nextjs.md` - Next.js guide
  - `docs/stacks/rust.md` - Rust guide
  - `docs/stacks/python.md` - Python guide
  - `docs/stacks/go.md` - Go guide
  - `docs/customization.md` - Customization guide
  - `docs/troubleshooting.md` - Troubleshooting guide
- Skills validation with `skills-ref` (AC-13)
  - All 14 skills pass validation
  - `npm run validate:skills` script
  - GitHub Actions CI workflow
- Cross-platform testing documentation (AC-14)
  - `docs/testing.md` - Testing matrix and checklist
- CONTRIBUTING.md with contribution guidelines
- This CHANGELOG.md

### Changed
- Updated README with platform support matrix
- Updated README with run command documentation

### Fixed
- Path handling in templates.ts for Windows compatibility

## [0.1.0] - 2025-01-03

### Added
- Initial release
- `sequant init` command with stack detection
- `sequant update` command for template updates
- `sequant doctor` command for health checks
- `sequant status` command for version info
- 14 workflow skills:
  - assess, clean, docs, exec, fullsolve, loop
  - qa, reflect, security-review, solve, spec
  - test, testgen, verify
- Stack support: Next.js, Rust, Python, Go
- Update-safe customization via `.claude/.local/`
- Git worktree helper scripts
- Pre/post tool hooks

[Unreleased]: https://github.com/admarble/sequant/compare/v1.1.3...HEAD
[1.1.3]: https://github.com/admarble/sequant/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/admarble/sequant/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/admarble/sequant/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/admarble/sequant/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/admarble/sequant/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/admarble/sequant/releases/tag/v0.1.0
