# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/admarble/sequant/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/admarble/sequant/releases/tag/v0.1.0
