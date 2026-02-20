# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `ScopeAssessmentSettings` missing fields from `ScopeAssessmentConfig` (#249)
  - Added `trivialThresholds.maxACItems`, `trivialThresholds.maxDirectories`, `thresholds.directorySpread`
  - `convertSettingsToConfig()` merges user settings with defaults for partial overrides
  - `/spec` SKILL.md reads `.sequant/settings.json` before calling `performScopeAssessment`
  - 18 tests (9 unit + 9 integration covering settings → config pipeline)
  - Documentation: `docs/features/scope-assessment-settings.md`
- Phase marker regex matches inside markdown code blocks (#269)
  - Pre-strips fenced code blocks and inline code before regex matching
  - Handles 3+ backtick/tilde fences per CommonMark spec
- `sequant run` fails on first execution, succeeds on retry (#267)
  - Two-phase retry strategy: cold-start retries (up to 2x within 60s threshold) then MCP fallback
  - MCP fallback disables MCP servers on retry, addressing npx-based cold-cache failures
  - Original error preserved on double-failure for better diagnostics
  - `--no-retry` flag and `run.retry` setting to disable retry behavior
  - Non-fatal `logWriter.initialize()` — run continues without logging on failure
- Worktree branches carry stale lockfiles after merge (#295)
  - Pre-PR rebase onto `origin/main` ensures branches are up-to-date before merge
  - Lockfile change detection (`ORIG_HEAD..HEAD`) triggers automatic dependency reinstall
  - Chain mode: only the final branch rebases (intermediate branches stay based on predecessor)
  - Rebase conflicts handled gracefully (abort, warn, continue with original state)
  - `--no-rebase` flag to skip pre-PR rebase for manual workflows

### Added

- Unit tests for gh CLI wrapper error paths in phase-detection (#270)
  - Covers `getIssuePhase`, `getCompletedPhases`, `getResumablePhasesForIssue`
  - Tests both error (execSync throws) and success paths

### Changed

- Restrict sub-agent types per skill via `Task(agent_type)` frontmatter (#262)
  - `/spec` → `Task(Explore)` (read-only research)
  - `/qa`, `/exec`, `/testgen` → `Task(general-purpose)` (quality checks)
  - `/fullsolve` → `Skill` only (orchestrator, no direct sub-agents)
  - Skills without sub-agents (security-review, merger) have `Task` removed
  - Enforces principle of least privilege per workflow phase

## [1.14.0] - 2026-02-05

### Added

- Pre-PR lint validation in `/exec` skill (#250)
  - Adds `npm run lint` to pre-PR quality gates (build → lint → test order)
  - Catches ESLint errors locally before they fail CI
  - Graceful skip for projects without lint script
  - Prevents wasted quality loop iterations from lint failures
- AC status management commands for state CLI
  - `npx tsx scripts/state/update.ts init-ac <issue> <count>` - Initialize AC items
  - `npx tsx scripts/state/update.ts ac <issue> <ac-id> <status> <notes>` - Update AC status
  - Enables `/qa` to persist AC verification status to workflow state
- Scope assessment for `/spec` to catch overscoped issues early (#239)
  - Non-Goals section parsing with warnings if missing
  - Feature count detection via AC clustering, title verbs, directory spread
  - Scope metrics table (feature count, AC items, directory spread)
  - Three verdicts: `SCOPE_OK`, `SCOPE_WARNING`, `SCOPE_SPLIT_RECOMMENDED`
  - Quality loop auto-enabled for yellow/red verdicts
  - Configurable thresholds in `.sequant/settings.json`
  - `--skip-scope-check` flag to bypass assessment
  - State persistence via `StateManager.updateScopeAssessment()`
- Animated spinners with elapsed time for `sequant run` phase execution (#244)
- Integration tests for testgen auto-detection workflow (#252)

### Fixed

- `/loop` skill failing in `sequant run` due to missing log file (#240)
  - Added orchestrated mode support: reads QA findings from GitHub issue comments when `SEQUANT_ORCHESTRATOR` is set
  - Preserved standalone mode: continues reading from `/tmp/claude-issue-<N>.log` when run interactively
  - Improved jq query to use `startswith()` instead of `contains()` to avoid false positives
- Pre-PR lint validation catches CI failures early (#253)

### Improved

- Better error diagnostics when Claude Code CLI exits unexpectedly
  - Captures stderr output from SDK for debugging
  - Includes stderr in error messages (up to 500 chars)
  - Streams stderr in real-time with `--verbose` flag
  - Animated `ora` spinner cycles while phases run (⠋ ⠙ ⠹ ⠸)
  - Elapsed time updates every 5 seconds during execution
  - Phase progress indicators (e.g., "spec (1/3)")
  - Completion states show checkmark with total duration
  - Graceful fallback to static text in CI/non-TTY/verbose modes
  - New `PhaseSpinner` class in `src/lib/phase-spinner.ts`
  - 35 unit tests covering spinner lifecycle and edge cases

### Refactored

- Decoupled derived AC extraction from hardcoded dimensions (#251)

## [1.13.0] - 2026-02-01

### Added

- QA caching to skip unchanged checks on re-run (#228)
  - New `src/lib/workflow/qa-cache.ts` module with hash-based cache invalidation
  - Cache keyed by git diff hash + config hash + TTL (1 hour default)
  - `--no-cache` flag to force fresh run
  - Cache hit/miss reported in QA output via `quality-checks.sh`
  - Graceful degradation on corrupted cache (falls back to fresh run)
  - CLI helper `scripts/qa/qa-cache-cli.ts` for shell script integration
  - 36 unit tests covering cache operations, invalidation, TTL expiry
- Testgen auto-detection in `/spec` and `/solve` (#217)
  - Automatically recommends `--testgen` phase when issue has testable ACs
  - Pattern detection for UI components, API endpoints, validation logic
  - Reduces manual workflow configuration for common feature types
- Enhanced CLI UI with modern terminal patterns (#215)
  - New `src/lib/cli-ui.ts` module (736 lines) with centralized UI utilities
  - Animated spinners with `ora` (graceful fallback to text in CI/non-TTY/verbose modes)
  - Decorative boxes with `boxen` for success/error/warning/header messages
  - ASCII tables with `cli-table3` for `sequant status` issue list
  - Gradient ASCII branding (static logo, no figlet dependency)
  - Progress bars for `sequant stats` success rate visualization
  - Standardized color palette across all CLI commands
  - Graceful degradation: `--no-color`, `--json`, `--verbose`, non-TTY, CI auto-detection
  - Windows legacy terminal ASCII fallback
  - `SEQUANT_MINIMAL=1` environment variable support
  - 73 unit tests covering all UI functions and fallback scenarios
- `/upstream` skill for Claude Code release tracking (#222)
  - Monitors anthropics/claude-code releases via GitHub API
  - Detects breaking changes, deprecations, new tools, opportunities
  - Auto-creates GitHub issues for actionable findings (with deduplication)
  - Keyword matching + regex patterns against sequant capabilities baseline
  - `--since <version>` for batch assessment of multiple releases
  - `--dry-run` mode to preview without creating issues
  - GitHub Action for weekly automated assessment
  - Security: All shell commands use `spawn()` with argument arrays (no injection risk)
  - 90 unit tests covering relevance detection, report generation, issue management
- Feature Quality Planning in workflow skills (#219)
  - `/spec`: New "Feature Quality Planning" section with 6 quality dimensions
    - Completeness, Error Handling, Code Quality, Test Coverage, Best Practices, Polish
    - Generates Derived ACs from quality checklist items
    - Complexity scaling (simple/standard/complex issues)
    - Section Applicability table for issue types
  - `/exec`: Quality Plan Reference section to implement quality items during execution
  - `/qa`: Quality Plan Verification with threshold-based status (Complete ≥80%, Partial ≥50%, Not Addressed <50%)
  - Addresses gap where `/spec` planned "minimum to satisfy AC" instead of "complete professional implementation"
- Derived AC tracking through workflow phases (#223)
  - `/exec`: Extracts derived ACs from spec comments, includes in Pre-PR AC Verification table with "Source" column
  - `/qa`: Parses derived ACs, includes in AC Coverage table with source attribution (e.g., "Derived (Error Handling)")
  - Derived ACs treated identically to original ACs for verdict determination
  - Edge case handling: malformed rows skipped, 0/1/5+ derived ACs supported
- Skill command verification in `/qa` skill (#209)
  - Detects when `.claude/skills/**/*.md` files are modified
  - Extracts CLI commands from bash code blocks, subshells, inline backticks
  - Validates JSON field names against `--help` output (e.g., `gh pr checks --json name,state,bucket`)
  - Pre-requisite check for `gh` CLI availability
  - Verdict gating: `READY_FOR_MERGE` blocked if command verification fails
  - New "Skill Command Verification" and "Skill Change Review" sections in QA output
- Mandatory prompt template enforcement in `/exec` parallel execution (#212)
  - REQUIRED: Sub-agents MUST use templates from Section 4c for typed tasks
  - Warning: Skipping templates for typed tasks results in QA rejection
  - Synced Section 4c (Prompt Templates for Sub-Agents) to active skill file
  - Added `prompt-templates.md` reference to `.claude/skills/_shared/references/`
- Build verification against main branch in `/qa` skill (#177)
  - Distinguishes regressions from pre-existing build failures
  - New "Build Verification" table in QA output when build fails
  - Regressions block merge (`AC_NOT_MET`); pre-existing failures documented only
  - Script: `scripts/quality-checks.sh` includes `run_build_with_verification()`
- CI status awareness in `/qa` skill (#178)
  - Checks GitHub CI status via `gh pr checks` before finalizing verdict
  - CI pending → `NEEDS_VERIFICATION` verdict (prevents premature READY_FOR_MERGE)
  - CI failure → `NOT_MET` for CI-related acceptance criteria
  - No CI configured → AC marked N/A (no impact on verdict)
  - New "CI Status" table in QA output
- Shift-left gap detection across workflow phases (#196)
  - `/spec`: Verification method decision framework - every AC must have explicit test type
  - `/exec`: Pre-PR AC verification - checks each AC is addressed before creating PR
  - `/test`: Coverage analysis - warns when new/modified files lack test coverage
  - Principle: "QA should validate, not discover" - catch gaps at source
- Shell script quality checks in `/exec` skill (#210)
  - Syntax validation, shellcheck integration, unused function detection
  - Smoke test execution for scripts with --help support
- Interactive stack selection and multi-stack support in `/setup` (#197)
  - `--interactive` / `-i` flag for guided stack configuration
- Testgen phase auto-detection and haiku optimization (#217)
  - `/spec`: Auto-recommends `testgen` phase when ACs have Unit/Integration Test verification methods
  - `/solve`: Includes `--testgen` flag and testgen in workflow recommendations
  - `/testgen`: Uses haiku sub-agents for cost-efficient stub generation (~90% token savings)
  - Detection rules skip testgen for bug fixes and docs-only issues
  - Updated `docs/concepts/workflow-phases.md` with testgen auto-detection documentation
  - Multi-stack detection: identifies stacks in root and subdirectories
  - Checkbox UI for selecting multiple stacks in monorepos
  - Primary stack selection determines dev URL and commands
  - Combined constitution notes from all selected stacks
  - Stack config persistence in `.sequant/stack.json`
- Content analysis for phase detection in `/spec` skill (#175)
  - Analyzes issue title for phase-relevant keywords (UI, security, complexity patterns)
  - Analyzes issue body for file references and patterns (.tsx, scripts/, auth/)
  - Signal priority merging: Labels > Solve comment > Title > Body
  - Solve comment detection: uses existing `/solve` recommendations when available
  - New "Content Analysis" section in spec output with signal sources table
  - Library exports: `analyzeContentForPhases()`, `mergePhaseSignals()`, `findSolveComment()`
  - 92 unit tests covering all detection patterns and edge cases

### Fixed

- Quality loop never triggering despite `--quality-loop` flag (#218)
  - Root cause: QA phase success was determined by SDK query completion, not actual QA verdict
  - Added `parseQaVerdict()` to parse verdict from QA output (READY_FOR_MERGE, AC_NOT_MET, etc.)
  - Non-passing verdicts now correctly mark QA phase as failure, triggering `/loop`
  - Verdict logged to `.sequant/logs/*.json` for debugging
  - 15 unit tests for verdict parsing covering all markdown formats

## [1.12.0] - 2026-01-29

### Added

- AC linting in `/spec` skill (#201)
  - Flags vague patterns: "should work", "properly", "correctly", "as expected"
  - Flags unmeasurable terms: "fast", "performant", "responsive", "scalable"
  - Flags incomplete specs: "handle errors", "edge cases", "all scenarios"
  - Flags open-ended scope: "etc.", "and more", "such as", "including but not limited to"
  - 28 configurable patterns with suggestions for improvement
  - Warning-only (doesn't block planning)
  - Skip with `--skip-ac-lint` flag
  - New module: `src/lib/ac-linter.ts`
- Semgrep static analysis integration in `/qa` skill (#200)
  - Stack-aware rulesets: Next.js, Astro, SvelteKit, Remix, Nuxt, Python, Go, Rust
  - Graceful degradation when Semgrep not installed
  - Custom rules support via `.sequant/semgrep-rules.yaml`
  - Critical findings block merge verdict (`AC_NOT_MET`)
  - CLI runner: `npx tsx scripts/semgrep-scan.ts`
  - Documentation: `references/semgrep-rules.md`
- Stack-aware constitution templates in `/setup` skill (#188, #193)
  - Auto-detects project stack (Next.js, Astro, SvelteKit, Remix, Nuxt, Rust, Python, Go)
  - Injects stack-specific testing, linting, and build notes into constitution
  - Falls back to generic notes for unknown stacks
- Claude Code Plugin support (#185)
  - Sequant can now be installed as a Claude Code plugin: `/plugin install sequant`
  - Plugin marketplace configuration in `.claude-plugin/`
  - `/setup` skill for plugin initialization (creates worktrees directory, copies constitution)
  - Plugin-specific documentation: updates, versioning, feedback mechanisms
  - CI validation for plugin.json (#191): structure check, required fields, version sync with package.json
  - `/release` skill now auto-syncs plugin.json version during releases
  - Comprehensive upgrade documentation in `docs/plugin-updates.md`
- Auto-detect project name in `/setup` skill (#187)
  - Detects from package.json, Cargo.toml, pyproject.toml, go.mod, or git remote
  - Substitutes `{{PROJECT_NAME}}` in constitution template
  - Falls back to directory name if no project file found
- Comprehensive "What We've Built" project overview documentation
  - Covers all 16 skills, 9 CLI commands, hooks system, dashboard, VS Code extension
  - Added to README documentation section
- Sub-agent prompt templates for `/exec` skill (#181)
  - Task-specific templates: component, type, CLI, test, refactor
  - Automatic template selection via keyword detection
  - Manual override with `[template: X]` annotation
  - Error recovery template with diagnosis checklist
  - See `templates/skills/_shared/references/prompt-templates.md`

### Improved

- Hook error message for merge commits now suggests `chore: merge...` format (#198)

### Fixed

- CI workflow failures on main branch
  - ESLint error in `project-name.ts` (unnecessary regex escape)
  - `validate-skills` job now skips `_shared` directory (shared resources, not a skill)
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

[Unreleased]: https://github.com/sequant-io/sequant/compare/v1.14.0...HEAD
[1.14.0]: https://github.com/sequant-io/sequant/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/sequant-io/sequant/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/sequant-io/sequant/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/sequant-io/sequant/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/sequant-io/sequant/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/sequant-io/sequant/compare/v1.5.2...v1.10.0
[1.5.2]: https://github.com/sequant-io/sequant/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/sequant-io/sequant/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/sequant-io/sequant/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/sequant-io/sequant/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/sequant-io/sequant/compare/v1.2.7...v1.3.0
[1.2.7]: https://github.com/sequant-io/sequant/compare/v1.2.5...v1.2.7
[1.2.5]: https://github.com/sequant-io/sequant/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/sequant-io/sequant/compare/v1.2.2...v1.2.4
[1.2.2]: https://github.com/sequant-io/sequant/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/sequant-io/sequant/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/sequant-io/sequant/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/sequant-io/sequant/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/sequant-io/sequant/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/sequant-io/sequant/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/sequant-io/sequant/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sequant-io/sequant/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/sequant-io/sequant/releases/tag/v0.1.0
