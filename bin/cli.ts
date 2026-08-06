#!/usr/bin/env node
/**
 * Sequant CLI - Quantize your development workflow
 *
 * Sequential AI phases with quality gates for any codebase.
 */

// MUST stay first (#734): the Node-version preflight guard. ESM evaluates a
// module's imports depth-first in source order before the importer's body, so
// this side-effecting import runs the guard before commander / chalk / the
// agent SDK / command modules are evaluated — closing the import-time crash
// window on an old Node below the engines floor. See bin/preflight.ts.
import "./preflight.js";
import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { initCommand } from "../src/commands/init.js";
import {
  buildHomeStrayWarning,
  getInstallRoot,
  isHomeStrayInstall,
  isLocalNodeModulesInstall,
} from "../src/lib/version-check.js";
import { configureUI, banner } from "../src/lib/cli-ui.js";
import {
  parseWholeNumber,
  parsePositiveSeconds,
} from "../src/lib/cli-flags.js";
import { isCI, isStdoutTTY } from "../src/lib/tty.js";
import {
  detectPackageManagerSync,
  getPackageManagerCommands,
} from "../src/lib/stacks.js";

// Read version from package.json dynamically
// Works from both source (bin/) and compiled (dist/bin/) locations.
// Note: the engines.node floor is read separately in bin/preflight.ts, which
// must run before this module's imports — see the side-effecting import above.
function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const candidate = resolve(dir, "package.json");
    try {
      const content = readFileSync(candidate, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.name === "sequant") {
        return pkg.version;
      }
    } catch {
      // Not found, continue searching
    }
    dir = dirname(dir);
  }
  return "0.0.0"; // Fallback
}
const version = getVersion();
import { updateCommand } from "../src/commands/update.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { statusCommand } from "../src/commands/status.js";
import { runCommand } from "../src/commands/run.js";
import { resumeCommand } from "../src/commands/resume.js";
import { logsCommand } from "../src/commands/logs.js";
import { statsCommand } from "../src/commands/stats.js";
import { dashboardCommand } from "../src/commands/dashboard.js";
import {
  stateInitCommand,
  stateRebuildCommand,
  stateCleanCommand,
} from "../src/commands/state.js";
import {
  syncCommand,
  areSkillsOutdated,
  checkAndWarnSkillsOutdated,
} from "../src/commands/sync.js";
import { mergeCommand } from "../src/commands/merge.js";
import {
  readyCommand,
  type ReadyCommandOptions,
} from "../src/commands/ready.js";
import { conventionsCommand } from "../src/commands/conventions.js";
import {
  locksListCommand,
  locksClearCommand,
  locksAcquireCommand,
  locksReleaseCommand,
  locksCheckCommand,
  locksCheckBatchCommand,
  locksCheckoutCommand,
} from "../src/commands/locks.js";
import { promptCommand } from "../src/commands/prompt.js";
import { watchCommand } from "../src/commands/watch.js";
import { abortCommand } from "../src/commands/abort.js";
import { assessRenderCommand } from "../src/commands/assess-render.js";
import { getManifest } from "../src/lib/manifest.js";
import { phaseRegistry } from "../src/lib/workflow/phase-registry.js";

/**
 * Validate `--phases` argument against the phase registry.
 *
 * Splits a comma-separated phase list, checks each name against
 * `phaseRegistry`, and exits with a clear error message if any phase
 * is unknown. Returns the original string unchanged so downstream
 * `RunOptions.phases` parsing in `config-resolver.ts` is undisturbed.
 */
function validatePhasesFlag(value: string): string {
  const names = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const unknown = names.filter((n) => !phaseRegistry.has(n));
  if (unknown.length > 0) {
    const available = phaseRegistry.names().join(", ");
    throw new InvalidArgumentError(
      `Unknown phase '${unknown[0]}'. Available: ${available}`,
    );
  }
  return value;
}

const program = new Command();

// Handle --no-color before parsing
if (process.argv.includes("--no-color")) {
  process.env.FORCE_COLOR = "0";
}

// Configure UI early based on environment and flags
configureUI({
  noColor: process.argv.includes("--no-color") || !!process.env.NO_COLOR,
  jsonMode: process.argv.includes("--json"),
  verbose: process.argv.includes("--verbose") || process.argv.includes("-v"),
  isTTY: isStdoutTTY(),
  isCI: isCI(),
  minimal: process.env.SEQUANT_MINIMAL === "1",
});

// (Node-version preflight guard runs at import time — see bin/preflight.ts.)

// Warn if running from a problematic install location.
// The home-stray case ($HOME/node_modules/sequant) gets a distinct warning
// because it pollutes resolution for every subdirectory of $HOME, which the
// generic "local node_modules" message doesn't communicate. Resolve the
// install root once and pass it to both predicates to avoid a second walk.
if (!process.argv.includes("--quiet")) {
  const installRoot = getInstallRoot();
  if (installRoot && isHomeStrayInstall(installRoot)) {
    console.warn(chalk.yellow(buildHomeStrayWarning(installRoot)));
  } else if (isLocalNodeModulesInstall()) {
    const pmCommands = getPackageManagerCommands(detectPackageManagerSync());
    console.warn(
      chalk.yellow(
        "!  Running sequant from local node_modules\n" +
          "   For latest version: npx sequant@latest\n" +
          `   To remove local: ${pmCommands.removePkg} sequant\n`,
      ),
    );
  }
}

program
  .name("sequant")
  .description(
    "Quantize your development workflow - Sequential AI phases with quality gates",
  )
  .version(version)
  .option("--no-color", "Disable colored output");

program
  .command("init")
  .description("Initialize Sequant in your project")
  .option("-s, --stack <stack>", "Specify stack (nextjs, rust, python, go)")
  .option("-y, --yes", "Skip confirmation prompts")
  .option("-f, --force", "Overwrite existing configuration")
  .option(
    "-i, --interactive",
    "Force interactive mode even in non-TTY environment",
  )
  .option("--skip-setup", "Skip the dependency setup wizard")
  .option(
    "--no-symlinks",
    "Use copies instead of symlinks for scripts/dev/ files",
  )
  .option("--no-agents-md", "Skip AGENTS.md generation")
  .option(
    "--mcp",
    "Add Sequant MCP server to detected clients (use with --yes)",
  )
  .option(
    "--upgrade-skills",
    "Upgrade skill files from installed package templates (with diff preview)",
  )
  .action(initCommand);

program
  .command("update")
  .description("Update templates from the Sequant package")
  .option("-d, --dry-run", "Show what would be updated without making changes")
  .option("-f, --force", "Overwrite local modifications")
  .option(
    "-y, --yes",
    "Apply updates without prompting (for CI/non-interactive shells)",
  )
  .action(updateCommand);

program
  .command("sync")
  .description(
    "Sync skills and templates from the Sequant package (non-interactive)",
  )
  .option(
    "-f, --force",
    "Sync even if versions match; also overwrites in-place customizations (e.g. the constitution)",
  )
  .option("-q, --quiet", "Suppress output")
  .option(
    "-d, --dry-run",
    "Show what sync would write without making changes (exits non-zero if work is pending)",
  )
  .action(syncCommand);

program
  .command("doctor")
  .description("Check your Sequant installation for issues")
  .option("--skip-issue-check", "Skip closed-issue verification check")
  .option("-q, --quiet", "Suppress informational warnings")
  .action(doctorCommand);

program
  .command("status")
  .description("Show Sequant version, configuration, and workflow state")
  .argument(
    "[issue]",
    "Issue number to show details for",
    parseWholeNumber("issue", { min: 1 }),
  )
  .option("--issues", "Show all tracked issues")
  .option("--json", "Output as JSON")
  .option("--rebuild", "Rebuild state from run logs")
  .option("--cleanup", "Clean up stale/orphaned entries")
  .option("--dry-run", "Preview cleanup without changes")
  .option(
    "--max-age <days>",
    "Remove entries older than N days",
    parseWholeNumber("--max-age", { min: 1, unit: "days" }),
  )
  .option(
    "--all",
    "Show all entries including expired; with --cleanup removes all orphaned",
  )
  .option("--offline", "Skip GitHub queries (pure local state)")
  .action((issue, options) => {
    // Support positional arg: `sequant status 42` → --issue 42
    if (issue) {
      options.issue = issue;
    }
    return statusCommand(options);
  });

program
  .command("run")
  .description("Execute workflow for GitHub issues using Claude Agent SDK")
  .argument("[issues...]", "Issue numbers to process")
  .option(
    "--phases <list>",
    "Phases to run (default: spec,exec,qa)",
    validatePhasesFlag,
  )
  .option("--sequential", "Stop on first issue failure (default: continue)")
  .option("-d, --dry-run", "Preview without execution")
  .option("-v, --verbose", "Verbose output with streaming")
  // #833: `parseInt` here let `--timeout abc` reach `setTimeout` as `NaN`,
  // which clamps to 0 and aborts every phase the moment it starts.
  .option(
    "--timeout <seconds>",
    "Timeout per phase in seconds",
    parsePositiveSeconds("--timeout"),
  )
  .option("--log-json", "Enable structured JSON logging (default: true)")
  .option("--no-log", "Disable JSON logging for this run")
  .option("--log-path <path>", "Custom log directory path")
  .option("-Q, --quality-loop", "Enable quality loop with auto-retry")
  // #705: `-q` is a hidden alias for the quality loop (Commander 14 allows only
  // one short flag per Option, so it can't live on --quality-loop directly).
  // `runCommand` ORs `qualityLoopAlias` into `qualityLoop`. `-q` no longer maps
  // to --quiet, which moved to `-s` to end the `-q`/`-Q` collision.
  .addOption(
    new Option(
      "-q, --quality-loop-alias",
      "Alias for -Q/--quality-loop",
    ).hideHelp(),
  )
  // #833: a `NaN` bound makes `while (iteration < maxIterations)` in
  // `batch-executor.ts` false on entry, so the issue silently runs zero phases.
  .option(
    "--max-iterations <n>",
    "Max iterations for quality loop (default: 3)",
    parseWholeNumber("--max-iterations", {
      min: 1,
      unit: "iterations",
      unitSingular: "iteration",
    }),
  )
  .option(
    "--batch <issues>",
    'Group of issues to run together (e.g., --batch "1 2" --batch "3")',
    (value: string, prev: string[]) => prev.concat([value]),
    [],
  )
  .option("--smart-tests", "Enable smart test detection (default)")
  .option("--no-smart-tests", "Disable smart test detection")
  .option("--testgen", "Run testgen phase after spec")
  .option("--security-review", "Run security-review phase after spec")
  .option(
    "-s, --quiet",
    "Suppress version warnings and non-essential output (heartbeat-only)",
  )
  .option(
    "--chain",
    "Chain issues: each successor is rebased onto the previous issue's committed work before it runs (implies --sequential)",
  )
  .option(
    "--stacked",
    "Stack PRs: middle PRs target predecessor branch instead of main; first/last target main (implies --chain)",
  )
  // #795: deliberately a visible `.option()`, NOT `.hideHelp()` like
  // `--experimental-tui` below. The two are different cases: `--qa-gate`
  // shipped in #133 and was documented across four user-facing docs, so users
  // need to find the deprecation notice; `--experimental-tui` was never
  // advertised. A flag that still works but is absent from --help is the worst
  // of both worlds — scripts keep passing it and nothing explains why to stop.
  .option(
    "--qa-gate",
    "DEPRECATED (#795): no-op, still accepted. --chain already halts on any failed issue, QA included",
  )
  .option(
    "--strict-preflight",
    "Make --chain content pre-flight warnings (missing AC, dependency/overlap order, closed issues) fatal before any worktree is provisioned",
  )
  .option(
    "--base <branch>",
    "Base branch for worktree creation (default: main or settings.run.defaultBase)",
  )
  .option("--no-mcp", "Disable MCP server injection in headless mode")
  .option(
    "--no-retry",
    "Disable automatic retry with MCP fallback (useful for debugging)",
  )
  .option(
    "--auto-wait <minutes>",
    "Total minutes to wait for an exhausted rate-limit window to reopen instead of halting (default: 0, off)",
    // #833: min 0 — #804 defines 0 as "off", so 0 is a meaningful value here
    // and must keep parsing. `NaN` was silently coerced to 0 by
    // `createAutoWaitLedger`, so `--auto-wait 30m` quietly bought 30 minutes.
    parseWholeNumber("--auto-wait", {
      min: 0,
      unit: "minutes",
      unitSingular: "minute",
    }),
  )
  .option(
    "--resume",
    "Resume from last completed phase (reads phase markers from GitHub)",
  )
  .option(
    "--no-rebase",
    "Skip pre-PR rebase onto origin/main (use when you want to handle rebasing manually)",
  )
  .option(
    "--no-pr",
    "Skip PR creation after successful QA (manual PR workflow)",
  )
  // #817: opt-in post-QA ready gate. Reuses the `sequant ready` engine and its
  // bounds (policy from settings.ready.policy, iteration cap, stagnation guard,
  // Non-Goals) — no new policy surface. Never merges; stops at the human gate.
  .option(
    "--ready-gate",
    "After phases succeed, run the post-QA ready gate (qa→loop→qa to the configured policy) — never merges, stops at the human merge gate",
  )
  .option(
    "-f, --force",
    "Force re-execution of completed issues (bypass pre-flight state guard) and take over per-issue locks",
  )
  .option(
    "--signal-other",
    "With --force, SIGTERM the prior PID holding the lock (same-host alive only)",
  )
  .option(
    "--concurrency <n>",
    "Max concurrent issues in parallel mode (default: 3)",
    // #833: `run.ts` already rejects non-integers, but only after `parseInt`
    // has silently turned `--concurrency 3x` into 3. Validating the raw string
    // catches that; the downstream check stays as a programmatic backstop.
    parseWholeNumber("--concurrency", { min: 1 }),
  )
  .option(
    "--isolate-parallel",
    "Isolate parallel agent groups in separate worktrees (prevents file conflicts)",
  )
  .option("--reflect", "Analyze run results and suggest improvements")
  .option(
    "--agent <name>",
    'Agent driver for phase execution (default: "claude-code")',
  )
  // #705: the boxed Ink TUI is now the default on a TTY. `--no-tui` opts out to
  // the line-based phase-matrix renderer; non-TTY / piped output auto-degrades.
  .option(
    "--no-tui",
    "Disable the boxed Ink dashboard; use the line-based phase-matrix renderer",
  )
  // #705: `--experimental-tui` is now a hidden no-op alias (the TUI is the
  // default) so existing scripts and muscle-memory keep parsing.
  .addOption(new Option("--experimental-tui").hideHelp())
  .option(
    "--no-relay",
    "Disable interactive relay (#383); `sequant prompt` cannot reach this run",
  )
  .action(runCommand);

// Durable halt-and-resume re-entry (#892). Safe to invoke from cron/launchd:
// a no-op (exit 0) until a halted issue's `resumeAt` passes.
program
  .command("resume")
  .description(
    "Re-enter runs halted on a rate-limit window (no-op until resumeAt; see docs/reference/halt-and-resume.md)",
  )
  .argument("[issues...]", "Issue numbers to resume (default: all halted)")
  .option("-d, --dry-run", "Show what would be resumed without running")
  // Arrow wrapper: commander passes the Command instance as a third
  // positional, which must not land in resumeCommand's injectable deps param.
  .action((issues: string[], options: { dryRun?: boolean }) =>
    resumeCommand(issues, options),
  );

program
  .command("prompt")
  .description("Send a message into a running headless sequant session (#383)")
  .argument("[args...]", '[<issue>] "<message>"')
  .option(
    "--type <type>",
    "Message type: query (default), directive, abort",
    "query",
  )
  .option(
    "--wait <seconds>",
    "Block until a reply arrives or the timeout elapses (#645, Gap 4)",
    parseWholeNumber("--wait", {
      min: 0,
      unit: "seconds",
      unitSingular: "second",
    }),
  )
  .option("--json", "Output as JSON")
  .action((args: string[], options: Record<string, unknown>) => {
    return promptCommand({
      args,
      options: {
        type: options.type as string | undefined,
        waitSeconds:
          typeof options.wait === "number" ? options.wait : undefined,
        json: Boolean(options.json),
      },
    });
  });

program
  .command("watch")
  .description(
    "Tail the relay outbox for replies from a running sequant session (#383)",
  )
  .argument("<issue>", "Issue number to watch")
  .option("--json", "Output as JSON lines")
  .action((issueArg: string, options: Record<string, unknown>) => {
    return watchCommand({
      args: [issueArg],
      options: { json: Boolean(options.json) },
    });
  });

program
  .command("abort")
  .description(
    "Out-of-band abort: signal a running sequant session directly (#645)",
  )
  .argument(
    "[issue]",
    "Issue number (auto-resolved when a single run is active)",
  )
  .option("--force", "Skip the SIGINT grace period; SIGTERM immediately")
  .option(
    "--grace <seconds>",
    "Seconds to wait after SIGINT before escalating (default: 10)",
    // #833: min 0 — `--grace 0` means "escalate immediately" and is meaningful.
    // `NaN` was worse than useless: `Math.max(0, NaN * 1000)` is `NaN`, so the
    // grace period was skipped entirely and SIGTERM followed at once.
    parseWholeNumber("--grace", {
      min: 0,
      unit: "seconds",
      unitSingular: "second",
    }),
  )
  .option("--json", "Output as JSON")
  .action((issueArg: string | undefined, options: Record<string, unknown>) => {
    const args = issueArg === undefined ? [] : [issueArg];
    return abortCommand({
      args,
      options: {
        force: Boolean(options.force),
        graceSeconds:
          typeof options.grace === "number" ? options.grace : undefined,
        json: Boolean(options.json),
      },
    });
  });

program
  .command("merge")
  .description(
    "Batch-level integration QA — verify feature branches before merging",
  )
  .argument(
    "[issues...]",
    "Issue numbers to check (auto-detects from most recent run if omitted)",
  )
  .option("--check", "Run Phase 1 deterministic checks (default)")
  .option("--scan", "Run Phase 1 + Phase 2 residual pattern detection")
  .option("--review", "Run Phase 1 + 2 + 3 AI briefing")
  .option("--all", "Run all phases")
  .option("--post", "Post report to GitHub as PR comments")
  .option(
    "--watch",
    "Poll each PR's CI checks until terminal, then run merge-check (never merges)",
  )
  .option(
    "--interval <seconds>",
    "Watch poll interval in seconds (default 30)",
    parsePositiveSeconds("--interval"),
  )
  .option(
    "--timeout <seconds>",
    "Watch give-up timeout in seconds (default 1800)",
    parsePositiveSeconds("--timeout"),
  )
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .action(mergeCommand);

program
  .command("ready")
  .description(
    "Post-resolve A+ QA gate — drive an issue to merge-readiness, then stop at the human merge gate (never merges)",
  )
  .argument("<issue>", "Issue number to drive to readiness")
  .option(
    "--policy <policy>",
    "Gate policy: 'ac' (default, stop at ACs met) or 'a-plus' (loop to READY_FOR_MERGE)",
  )
  .option(
    "--max-iterations <n>",
    "Max QA passes before halting for human review (default: settings.run.maxIterations)",
    // #833: `ready.ts` guards each of these three with `> 0`, so `NaN` already
    // fell back to the default rather than reaching a timer. What it could not
    // catch is the silent misparse — `--budget 10k` became 10, `--timeout 30m`
    // became 30 seconds — and a fallback is not the same as telling the user.
    parseWholeNumber("--max-iterations", {
      min: 1,
      unit: "iterations",
      unitSingular: "iteration",
    }),
  )
  .option(
    "--budget <tokens>",
    "Token budget; halt cleanly with a 'needs human' message on exhaustion",
    parseWholeNumber("--budget", {
      min: 1,
      unit: "tokens",
      unitSingular: "token",
    }),
  )
  .option(
    "--timeout <seconds>",
    "Timeout per phase in seconds",
    parsePositiveSeconds("--timeout"),
  )
  .option("--no-mcp", "Disable MCP server injection in headless mode")
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .action((issue: string, options: ReadyCommandOptions) =>
    readyCommand(issue, options),
  );

// #823: internal surface for the /assess skill, deliberately hidden from the
// top-level help — it takes a JSON payload no human hand-writes. `sequant
// assess-render --help` still works for debugging.
program
  .command("assess-render", { hidden: true })
  .description(
    "(internal) Render an /assess AssessResult JSON payload to stdout",
  )
  .argument("<file>", "Path to an AssessResult JSON file")
  .action(assessRenderCommand);

program
  .command("conventions")
  .description("View and manage codebase conventions")
  .option("--detect", "Re-run convention detection")
  .option("--reset", "Clear detected conventions (keep manual)")
  .option("--format <format>", "Output format (agents-md for AGENTS.md format)")
  .action(conventionsCommand);

program
  .command("logs")
  .description("View and analyze workflow run logs")
  .option("-p, --path <path>", "Custom log directory path")
  .option(
    "-n, --last <n>",
    "Show last N runs",
    parseWholeNumber("--last", { min: 1 }),
  )
  .option("--json", "Output as JSON")
  .option(
    "-i, --issue <number>",
    "Filter by issue number",
    parseWholeNumber("--issue", { min: 1 }),
  )
  .option("--failed", "Show only failed runs")
  .option("--rotate", "Rotate logs (delete oldest to meet thresholds)")
  .option("-d, --dry-run", "Show what would be rotated without deleting")
  .option("-v, --verbose", "Show full error context (all stderr lines)")
  .action(logsCommand);

program
  .command("stats")
  .description("Show aggregate statistics for workflow runs")
  .option("-p, --path <path>", "Custom log directory path")
  .option("--csv", "Output as CSV")
  .option("--json", "Output as JSON")
  .option(
    "--detailed",
    "Show detailed analytics (QA verdicts, trends, label segmentation)",
  )
  .option("--label <name>", "Filter to runs whose issues carry the given label")
  .option(
    "--since <date>",
    "Filter to runs with startTime on/after YYYY-MM-DD (UTC)",
  )
  .action(statsCommand);

program
  .command("dashboard")
  .description("Start visual workflow dashboard in browser")
  .option(
    "-p, --port <port>",
    "Port to run server on",
    parseWholeNumber("--port", { min: 1 }),
  )
  .option("--no-open", "Don't automatically open browser")
  .option("-v, --verbose", "Enable verbose logging")
  .action(dashboardCommand);

program
  .command("serve")
  .description("Start MCP server for workflow orchestration")
  .option(
    "--transport <type>",
    "Transport type: stdio (default) or sse",
    "stdio",
  )
  .option(
    "--port <port>",
    "Port for SSE transport (default: 3100)",
    parseWholeNumber("--port", { min: 1 }),
  )
  .action(async (options: Record<string, unknown>) => {
    const mod = await import("../src/commands/serve.js").catch(() => null);
    if (!mod) {
      const pmCmds = getPackageManagerCommands(detectPackageManagerSync());
      console.error(
        chalk.red(
          "Error: MCP server requires @modelcontextprotocol/sdk\n" +
            `Install it with: ${pmCmds.addPkg} @modelcontextprotocol/sdk`,
        ),
      );
      process.exit(1);
    }
    return mod.serveCommand(options);
  });

// State management command with subcommands
const stateCmd = program
  .command("state")
  .description("Manage workflow state for worktrees");

stateCmd
  .command("init")
  .description("Populate state for untracked worktrees")
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .action(stateInitCommand);

stateCmd
  .command("rebuild")
  .description("Recreate state from logs and worktrees")
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .option("-f, --force", "Force rebuild without confirmation")
  .action(stateRebuildCommand);

stateCmd
  .command("clean")
  .description("Remove entries for deleted worktrees")
  .option("--json", "Output as JSON")
  .option("-v, --verbose", "Enable verbose output")
  .option("-d, --dry-run", "Preview cleanup without changes")
  .option(
    "--max-age <days>",
    "Remove entries older than N days",
    parseWholeNumber("--max-age", { min: 1, unit: "days" }),
  )
  .option("--all", "Remove all orphaned entries (merged and abandoned)")
  .action(stateCleanCommand);

// Per-issue concurrency locks (#625)
const locksCmd = program
  .command("locks")
  .description("Inspect and clear per-issue concurrency locks");

locksCmd
  .command("list")
  .description("List active locks with staleness metadata")
  .option("--json", "Output as JSON")
  .action(locksListCommand);

locksCmd
  .command("clear <issue>")
  .description(
    "Manually clear the lock for an issue (safety check unless --force)",
  )
  .option(
    "-f, --force",
    "Skip safety check; clear even a fresh same-host alive lock",
  )
  .option("--json", "Output as JSON")
  .action(locksClearCommand);

locksCmd
  .command("acquire <issue>")
  .description(
    "Claim the lock for an issue (used by /fullsolve, /assess; exits 1 if held)",
  )
  .option("--command <command>", "Human-readable command label", "unknown")
  .option(
    "--skip-pid-check",
    "Mark the lock so stale recovery skips same-host PID checks (use from skill shells)",
  )
  .option("-f, --force", "Take over even if another holder is alive")
  .option(
    "--signal-other",
    "When forcing, SIGTERM the prior same-host holder if alive",
  )
  .option("--json", "Output as JSON")
  .action(locksAcquireCommand);

locksCmd
  .command("release <issue>")
  .description(
    "Release a lock previously acquired on this host (skill or current process)",
  )
  .option("--json", "Output as JSON")
  .action(locksReleaseCommand);

locksCmd
  .command("check <issue>")
  .description(
    "Read-only probe: print lock holder if any; exit 1 when held (for /assess)",
  )
  .option("--json", "Output as JSON")
  .action(locksCheckCommand);

locksCmd
  .command("check-batch <issues...>")
  .description(
    "Batch read-only probe: emit canonical ⚠ warning lines for held issues (for /assess dashboard)",
  )
  .option("--json", "Output as JSON instead of canonical text lines")
  .action(locksCheckBatchCommand);

// Checkout-scoped lock (#901). The per-issue locks above give no mutual
// exclusion on the shared working tree — two sessions on different issues take
// different lock files, yet `git checkout`/`reset`/`rebase`/`merge` are global
// to the tree. This lock represents the tree itself.
locksCmd
  .command("checkout <action>")
  .description(
    "Working-tree lock: acquire|release|check|clear (guards branch-mutating git in the main checkout)",
  )
  .option("--issue <issue>", "Issue this session is working on (acquire)")
  .option("--command <command>", "Human-readable command label", "unknown")
  .option(
    "--session-id <id>",
    "Claude Code session id; preferred holder identity for skill shells",
  )
  .option(
    "--skip-pid-check",
    "Mark the lock so stale recovery skips same-host PID checks (use from skill shells)",
  )
  .option("-f, --force", "Clear even a fresh holder (clear)")
  .option("--json", "Output as JSON")
  .action(locksCheckoutCommand);

// Auto-sync skills after npm upgrade (version mismatch detection)
// Only triggers when skills were previously synced (has .sequant-version marker).
// Projects that manage skills manually (no marker) are not affected.
program.hook("preAction", async (thisCommand) => {
  const cmd = thisCommand.name();
  // `update` is excluded alongside `init`/`sync`: it is itself the command that
  // resolves drift, so the warn-only "run sync/update" pre-flight would be a
  // circular nag right before it does exactly that.
  if (cmd === "init" || cmd === "sync" || cmd === "update") return;

  const manifest = await getManifest();
  if (!manifest) return;

  // `cache: true` opts the per-command pre-flight into the stat-only drift
  // fingerprint cache: the full template scan runs only when something that
  // affects drift changed, keeping latency off the hot path (AC-5).
  const status = await areSkillsOutdated({ cache: true });
  const { outdated, currentVersion, contentDrift } = status;

  // No version marker → the project manages skills manually; stay silent and
  // do nothing (unchanged behavior — see the header comment above the hook).
  if (currentVersion === null) return;

  if (outdated) {
    // Version-marker mismatch → stale install: auto-sync (copy) as before.
    await syncCommand({ quiet: true });
    return;
  }

  // Version-current but bundled content drifted in place (#708/#713). AC-3
  // decision: auto-sync (copy) stays gated on version bumps ONLY — we do NOT
  // copy here, because that would clobber in-place customizations (#711).
  // Content-only drift is surfaced as a non-destructive, warn-only signal,
  // leaving the fix to the user (`sequant sync`/`update`). The helper never
  // touches process.exitCode, so the command still exits normally.
  if (contentDrift > 0) {
    await checkAndWarnSkillsOutdated(status);
  }
});

// Parse and execute
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  console.log(banner());
  program.help();
}
