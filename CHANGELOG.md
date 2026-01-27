# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Claude Code Plugin support (#185)
  - Sequant can now be installed as a Claude Code plugin: `/plugin install sequant`
  - Plugin marketplace configuration in `.claude-plugin/`
  - `/setup` skill for plugin initialization (creates worktrees directory, copies constitution)
  - Plugin-specific documentation: updates, versioning, feedback mechanisms
- Auto-detect project name in `/setup` skill (#187)
  - Detects from package.json, Cargo.toml, pyproject.toml, go.mod, or git remote
  - Substitutes `{{PROJECT_NAME}}` in constitution template
  - Falls back to directory name if no project file found
- Comprehensive "What We've Built" project overview documentation
  - Covers all 16 skills, 9 CLI commands, hooks system, dashboard, VS Code extension
  - Added to README documentation section

### Fixed

- QA verdict logic now enforces strict `READY_FOR_MERGE` criteria (#171)
  - Added `NEEDS_VERIFICATION` verdict for ACs with `PENDING` status
  - `PARTIALLY_MET` ACs now correctly result in `AC_NOT_MET` verdict
  - Added explicit verdict determination algorithm to prevent false positives
- Sub-agent spawning in `/spec` and `/qa` skills (#170)
  - Replaced invalid subagent types (`quality-checker`, `pattern-scout`, `schema-inspector`) with valid Claude Code types
  - `/qa` now uses `general-purpose` for quality checks
  - `/spec` now uses `Explore` for pattern and schema inspection

## [1.11.0] - 2026-01-23

### Added

- Closed-issue verification in `sequant doctor` (#89)
  - Warns if issues closed in last 7 days have no commit in main
  - Helps detect work lost due to manual issue closure without merging
  - Skips issues with `wontfix`, `duplicate`, `invalid`, `question` labels
  - Use `--skip-issue-check` flag to disable
- PR info recorded in workflow state when `/exec` creates a PR (#145)
  - New CLI command: `npx tsx scripts/state/update.ts pr <issue> <pr-number> <url>`
  - Enables `--cleanup` to detect merged PRs for orphaned entries
  - `/exec` skill updated to record PR info after PR creation
- Comprehensive QA improvements (#147)
  - **Execution Evidence** — QA now executes smoke tests for scripts/CLI changes before READY_FOR_MERGE
  - **Test Quality Review** — Evaluates tests for behavior vs implementation, coverage depth, mock hygiene
  - **Anti-Pattern Detection** — Audits new dependencies and scans for N+1 queries, empty catch blocks, hardcoded secrets
  - Supersedes #91, #92, #143
- Local-first analytics for workflow insights (#132)
  - Metrics collected automatically during `sequant run`
  - Data stored in `.sequant/metrics.json` (privacy-focused, no PII)
  - `sequant stats` displays success rates, averages, and insights
  - `sequant stats --json` for programmatic access
  - No data ever sent remotely — all analytics are local-only
  - See `docs/analytics.md` for details
- Smart cleanup with PR merge detection (#137)
  - `sequant status --cleanup` now checks GitHub for merged PRs
  - Orphaned entries with merged PRs are auto-removed
  - Orphaned entries without merged PRs are marked `abandoned` (kept for review)
  - New `--all` flag removes both merged and abandoned entries in one step
  - Usage: `sequant status --cleanup --all`
- `--qa-gate` flag for chain mode to pause execution when QA fails (#133)
  - Prevents downstream issues from building on potentially broken code
  - Chain pauses with clear messaging and recovery guidance
  - New `waiting_for_qa_gate` status in state tracking
  - Usage: `sequant run 1 2 3 --sequential --chain --qa-gate`
- `sequant init` now creates symlinks for `scripts/dev/` pointing to `templates/scripts/` (#107)
  - Templates automatically update when Sequant is upgraded
  - Existing regular files preserved (use `--force` to replace)
  - Windows falls back to copies if symlinks unavailable
  - Use `--no-symlinks` flag to opt out of symlink behavior
- Dashboard UI enhancements for workflow visibility (#139)
  - Phase indicators with rich tooltips (status, duration, error messages)
  - Active phase highlighting with visual pulse animation
  - Loop iteration counter (e.g., "2/3")
  - Branch name display with copy-to-clipboard button
  - Issue tracking age ("Tracked for 3d")
- Acceptance criteria tracking integration (#158)
  - AC parser (`src/lib/ac-parser.ts`) extracts criteria from issue markdown
    - Supports formats: `**AC-1:**`, `**B2:**`, `AC-1:` (with/without bold)
    - Auto-infers verification method from description keywords
  - StateManager AC methods: `updateAcceptanceCriteria()`, `getAcceptanceCriteria()`, `updateACStatus()`
  - Dashboard displays expandable AC checklist per issue with status icons (✅❌⏳🚫)
- MCP server support for headless `sequant run` (#161)
  - Reads MCP servers from Claude Desktop config and passes to SDK
  - Enables Context7, Sequential Thinking, and Chrome DevTools in headless mode
  - New `--no-mcp` flag to disable MCPs for faster/cheaper runs
  - New `run.mcp` setting in `.sequant/settings.json` (default: `true`)
  - `sequant doctor` now shows "MCP Servers (headless)" availability check
  - See `docs/run-command.md` for configuration details
  - Summary badge shows "X/Y met" progress
  - `/spec` skill wired to extract and store AC from issue body
  - `/qa` skill wired to update AC status after review

### Fixed

- `sequant state` command now registered in CLI (#144)
  - Previously implemented in `src/commands/state.ts` but not accessible
  - Now available: `sequant state init`, `sequant state rebuild`, `sequant state clean`
  - See `docs/state-command.md` for usage
- `/qa` now detects `templates/scripts/` changes for execution verification (#109)
  - Previously only `scripts/` was checked, allowing template scripts to bypass `/verify`
- Dashboard now shows fresh state instead of stale cached data
  - Issue status updates (e.g., `in_progress` → `ready_for_merge`) now reflect immediately
- `--no-mcp` flag now registered in CLI (#161)
  - Flag was implemented in run command logic but not exposed in Commander.js options
  - Now available: `sequant run --no-mcp` to disable MCP server injection

## [1.10.1] - 2026-01-19

### Fixed

- Chain mode (`--chain`) now rebases existing branches onto previous chain link (#126)
  - Previously, existing branches were reused as-is, breaking the chain structure
  - Rebase conflicts are handled gracefully with abort and user warning

## [1.10.0] - 2026-01-19

### Added

- `--base <branch>` flag for `sequant run` to specify custom base branches (#122)
  - Branch from feature integration branches instead of main
  - `run.defaultBase` config option in `.sequant/settings.json`
  - Resolution priority: CLI flag → config → main
  - Full documentation in `docs/feature-branch-workflow.md`
- Persistent workflow state tracking for issue phases (#115)
  - State file at `.sequant/state.json` tracks issue progress across sessions
  - `sequant status --issues` shows all tracked issues and their phase progress
  - `sequant status --rebuild` rebuilds state from run logs
  - `sequant status --cleanup` removes stale/orphaned entries
  - `sequant status --cleanup --dry-run` previews cleanup without changes
  - `sequant status --cleanup --max-age 30` removes old entries
  - State hook utility for skills to update state when running standalone
- `/fullsolve` now invokes child skills (`/spec`, `/exec`, `/test`, `/qa`) via Skill tool instead of inline execution (#111)
- `/solve` recommends `--chain` flag for dependent/sequential issues (#111)
- `/solve` recommends `-q` (quality loop) for enhancement/feature issues
- Local node_modules warning when running stale local installs (#87)

### Changed

- `/fullsolve` auto-progresses between phases without waiting for user confirmation
- `sequant run` now writes state updates on phase transitions

## [1.5.2] - 2026-01-13

### Fixed

- Clean bin script path in package.json (removes npm publish warning)

## [1.5.1] - 2026-01-12

### Changed

- Reduced npm package size by excluding tests and source maps

## [1.5.0] - 2026-01-11

### Added

- Graceful shutdown for `sequant run` with proper signal handling (#74)
- Context7 and Sequential Thinking MCP integration into skill workflows (#75)
- Configurable parallel agent mode for cost-conscious users (#68)
- Integration test for `sequant doctor` command (#60)
- ESLint with rule to catch `require()` in ESM modules (#59)
- Skip `/docs` generation for documentation-only issues (#66)
- Standardized issue labeling with templates and AI suggestions (#51)

### Fixed

- Worktree lookup in pre-merge cleanup hook
- Auto-cleanup worktree before `gh pr merge`

## [1.4.0] - 2026-01-11

### Added

- Setup wizard for missing dependencies during `sequant init` (#9)
  - Interactive dependency checking for gh, claude, and jq
  - Platform-specific install instructions (brew/apt/choco)
  - `--skip-setup` flag for CI/advanced users
  - Auto-skips in CI environments
  - Input validation to prevent shell injection in command checks
- `/release` skill for automated version bumps, GitHub releases, and npm publishing
- CI environment name shown in non-interactive mode messages (#50)
- Platform requirements documentation with GitHub alternatives (#7)

### Fixed

- Merger skill pre-merge worktree cleanup to prevent branch deletion failures

### Removed

- Dead workflow code: `execute-issues.ts`, `cli-args.ts`, `logger.ts` (#12)
- Supabase remnants from reflect skill scripts (#12)

## [1.3.0] - 2026-01-10

### Added

- Orchestration context awareness for skills (#40)
  - Skills detect when running under `sequant run` via `SEQUANT_ORCHESTRATOR` env var
  - Orchestrated skills skip redundant pre-flight checks and reduce GitHub comment spam
  - `SEQUANT_PHASE`, `SEQUANT_ISSUE`, `SEQUANT_WORKTREE` env vars available to skills
- Smoke test step for UI issues in `/exec` skill (#37)
  - Quick runtime verification before implementation for `admin`, `ui`, `frontend` labeled issues
  - Catches module registration errors and framework incompatibilities that pass build
- Security label detection in phase detection (#30)
  - Issues with `security`, `auth`, `authentication`, `permissions`, `admin` labels trigger `security-review` phase
  - `security-review` phase added to workflow type system
- `npm run sync:skills` script to sync templates to `.claude/skills/` (#30)
- `parseRecommendedWorkflow()` unit test coverage (#30)
- `/spec` reference documentation for recommended workflow format (#30)
- Configurable `/test` skill with framework-agnostic defaults (#17)
  - `{{DEV_URL}}` token replaces hardcoded `localhost:3000`
  - `{{PM_RUN}}` token for package manager-aware commands
  - Graceful fallback to manual testing checklist when Chrome DevTools MCP unavailable
  - `docs/customization.md` documents testing configuration

## [1.2.7] - 2026-01-10

### Added

- Log rotation to prevent unbounded log growth (#28)
  - Automatic rotation when logs exceed 10MB or 100 files
  - `sequant logs --rotate` for manual rotation
  - `--dry-run` flag to preview rotation
  - Configurable via `rotation` settings in `.sequant/settings.json`
- `sequant stats` command for aggregate run analysis (#28)
  - Success/failure rates across all runs
  - Average phase durations by phase type
  - Common failure points identification
  - `--csv` and `--json` export options
- Comprehensive logging documentation in `docs/logging.md` (#28)
  - JSON schema reference for external tooling
  - 8 practical jq examples for log parsing
  - GitHub Actions and Slack integration examples
- Optional MCP server documentation and detection (#15)
  - `sequant doctor` now checks for optional MCP servers (Chrome DevTools, Context7, Sequential Thinking)
  - New "Optional MCP Integrations" section in README with install instructions
  - New `docs/mcp-integrations.md` guide with detailed setup and troubleshooting
  - `/test` skill gracefully falls back to manual testing when Chrome DevTools MCP unavailable

### Fixed

- `sequant doctor` MCP check now works correctly (fixed ESM import for fs module)
- `sequant run` correctly determines success after quality loop recovery

## [1.2.5] - 2026-01-10

### Added

- `sequant init` now updates `.gitignore` with `.sequant/` entry
- `/qa` skill includes "Documentation Check" in output verification
- `/exec` skill includes "Documentation Reminder" in output verification

### Fixed

- `sequant update` config setup message is now friendlier ("one-time setup" instead of "legacy install" warning)

## [1.2.4] - 2026-01-10

### Fixed

- Fix CLI crash when running via npx - version reading now works from compiled dist
- `sequant update` now shows correct version instead of hardcoded "0.1.0"
  - Version is read dynamically from package.json at runtime
  - Works from both source and compiled locations

## [1.2.2] - 2026-01-10

### Added

- **Quality loop documentation** - comprehensive docs for the `--quality-loop` feature
  - New "Quality Loop" section in README with usage examples
  - Added to `docs/run-command.md` options table and dedicated section
  - Environment variables: `SEQUANT_QUALITY_LOOP`, `SEQUANT_MAX_ITERATIONS`
  - Settings file documentation with full schema
- **Smart defaults for quality loop** - auto-enables for complex issues
  - Labels `complex`, `refactor`, `breaking`, `major` trigger quality loop
  - `/solve` skill now recommends quality loop for complex issues
  - Output shows when quality loop will auto-enable

## [1.2.1] - 2026-01-10

### Fixed

- CLI `--version` now reads from package.json dynamically instead of hardcoded value

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

[Unreleased]: https://github.com/admarble/sequant/compare/v1.11.0...HEAD
[1.11.0]: https://github.com/admarble/sequant/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/admarble/sequant/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/admarble/sequant/compare/v1.5.2...v1.10.0
[1.5.2]: https://github.com/admarble/sequant/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/admarble/sequant/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/admarble/sequant/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/admarble/sequant/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/admarble/sequant/compare/v1.2.7...v1.3.0
[1.2.7]: https://github.com/admarble/sequant/compare/v1.2.5...v1.2.7
[1.2.5]: https://github.com/admarble/sequant/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/admarble/sequant/compare/v1.2.2...v1.2.4
[1.2.2]: https://github.com/admarble/sequant/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/admarble/sequant/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/admarble/sequant/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/admarble/sequant/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/admarble/sequant/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/admarble/sequant/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/admarble/sequant/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/admarble/sequant/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/admarble/sequant/releases/tag/v0.1.0
