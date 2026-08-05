/**
 * Prepare plugin package for official Claude Code marketplace submission
 *
 * Usage: npx tsx scripts/prepare-marketplace.ts [--validate-only]
 *
 * Builds the external_plugins/sequant/ directory structure required by
 * https://github.com/anthropics/claude-plugins-official
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(
  PROJECT_ROOT,
  "dist",
  "marketplace",
  "external_plugins",
  "sequant",
);
const validateOnly = process.argv.includes("--validate-only");

function countSkills(dir: string): number {
  let count = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir)) {
    const skillDir = join(dir, entry);
    if (
      statSync(skillDir).isDirectory() &&
      existsSync(join(skillDir, "SKILL.md"))
    ) {
      count++;
    }
  }
  return count;
}

function main(): void {
  console.log("📦 Preparing marketplace package...\n");

  // Verify prerequisites
  const packageJsonPath = join(PROJECT_ROOT, "package.json");
  if (!existsSync(packageJsonPath)) {
    console.error("❌ package.json not found. Run from project root.");
    process.exit(1);
  }

  const pluginJsonPath = join(PROJECT_ROOT, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJsonPath)) {
    console.error("❌ .claude-plugin/plugin.json not found.");
    process.exit(1);
  }

  // Get versions
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  const version = packageJson.version;
  const pluginVersion = pluginJson.version;

  // Check marketplace.json version
  const marketplaceJsonPath = join(
    PROJECT_ROOT,
    ".claude-plugin",
    "marketplace.json",
  );
  let marketplaceVersion: string | undefined;
  if (existsSync(marketplaceJsonPath)) {
    const marketplaceJson = JSON.parse(
      readFileSync(marketplaceJsonPath, "utf8"),
    );
    marketplaceVersion = marketplaceJson.plugins?.[0]?.version;
  }

  console.log(`Version: ${version}`);

  if (version !== pluginVersion) {
    console.error(
      `❌ Version mismatch: package.json (${version}) != plugin.json (${pluginVersion})`,
    );
    console.error("   Run ./scripts/release.sh to sync versions.");
    process.exit(1);
  }

  if (existsSync(marketplaceJsonPath) && marketplaceVersion !== version) {
    const marketplaceJson = JSON.parse(
      readFileSync(marketplaceJsonPath, "utf8"),
    );
    marketplaceJson.plugins[0].version = version;
    writeFileSync(
      marketplaceJsonPath,
      JSON.stringify(marketplaceJson, null, 2) + "\n",
    );
    console.log(
      `📝 Updated marketplace.json version: ${marketplaceVersion} → ${version}`,
    );
  }

  if (validateOnly) {
    console.log("\n🔍 Validating existing marketplace package...");
    if (!existsSync(OUTPUT_DIR)) {
      console.error(`❌ No marketplace package found at ${OUTPUT_DIR}`);
      console.error(
        "   Run without --validate-only first to build the package.",
      );
      process.exit(1);
    }
  } else {
    // Clean previous build
    const marketplaceDir = join(PROJECT_ROOT, "dist", "marketplace");
    if (existsSync(marketplaceDir)) {
      rmSync(marketplaceDir, { recursive: true });
    }
    mkdirSync(OUTPUT_DIR, { recursive: true });

    // 1. Copy plugin.json (marketplace.json is for self-hosted)
    console.log("📋 Copying plugin metadata...");
    const outputPluginDir = join(OUTPUT_DIR, ".claude-plugin");
    mkdirSync(outputPluginDir, { recursive: true });
    cpSync(pluginJsonPath, join(outputPluginDir, "plugin.json"));

    // 2. Copy skills from templates/
    console.log("📋 Copying skills...");
    const templatesSkillsDir = join(PROJECT_ROOT, "templates", "skills");
    if (existsSync(templatesSkillsDir)) {
      cpSync(templatesSkillsDir, join(OUTPUT_DIR, "skills"), {
        recursive: true,
      });
    }

    // 3. Copy hooks
    console.log("📋 Copying hooks...");
    const templatesHooksDir = join(PROJECT_ROOT, "templates", "hooks");
    if (existsSync(templatesHooksDir)) {
      const outputHooksDir = join(OUTPUT_DIR, "hooks");
      mkdirSync(outputHooksDir, { recursive: true });
      cpSync(templatesHooksDir, outputHooksDir, { recursive: true });
    }

    // 4. Copy .mcp.json (MCP server config for plugin users), pinning the
    //    server to this release's version (#793). The source template stays on
    //    `sequant@latest` (portable, tracks HEAD for contributors), but the
    //    distributed plugin config is stamped with the concrete version so an
    //    npx reconnect never re-resolves `@latest` — the reinstall-on-release
    //    that surfaced as `-32000`. Plugin users pick up the new pin when they
    //    update the plugin. `npm run prepare:marketplace` already runs on every
    //    release path, so the stamp stays in sync automatically.
    console.log("📋 Copying MCP server config...");
    const mcpJsonPath = join(PROJECT_ROOT, "templates", "mcp.json");
    if (existsSync(mcpJsonPath)) {
      const packageVersion = JSON.parse(
        readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
      ).version as string;
      const pinnedMcp = readFileSync(mcpJsonPath, "utf8").replace(
        /sequant@latest/g,
        `sequant@${packageVersion}`,
      );
      writeFileSync(join(OUTPUT_DIR, ".mcp.json"), pinnedMcp);
      console.log(`   Pinned MCP server to sequant@${packageVersion}`);
    } else {
      console.error(
        "❌ templates/mcp.json not found. Plugin users won't get MCP server.",
      );
      process.exit(1);
    }

    // 5. Generate README
    console.log("📋 Generating README...");
    writeFileSync(join(OUTPUT_DIR, "README.md"), README_CONTENT);
  }

  // Validate
  validate();
}

function validate(): void {
  console.log("\n🔍 Validating marketplace structure...");
  let errors = 0;

  const outputPluginJson = join(OUTPUT_DIR, ".claude-plugin", "plugin.json");
  if (existsSync(outputPluginJson)) {
    console.log("  ✅ .claude-plugin/plugin.json");

    const plugin = JSON.parse(readFileSync(outputPluginJson, "utf8"));

    // Required fields
    for (const field of ["name", "description", "version", "author"]) {
      if (!plugin[field]) {
        console.error(`  ❌ plugin.json missing required field: ${field}`);
        errors++;
      }
    }

    // Recommended fields
    for (const field of ["homepage", "repository", "license", "keywords"]) {
      if (!plugin[field]) {
        console.warn(`  ⚠️  plugin.json missing recommended field: ${field}`);
      }
    }
  } else {
    console.error("  ❌ .claude-plugin/plugin.json (MISSING)");
    errors++;
  }

  // Validate .mcp.json
  const outputMcpJson = join(OUTPUT_DIR, ".mcp.json");
  if (existsSync(outputMcpJson)) {
    const mcpConfig = JSON.parse(readFileSync(outputMcpJson, "utf8"));
    // Plugin .mcp.json uses flat format (server name as top-level key)
    const sequantServer = mcpConfig?.sequant;
    const args: unknown = sequantServer?.args;
    const pin = Array.isArray(args)
      ? args.find((a) => typeof a === "string" && a.startsWith("sequant@"))
      : undefined;
    if (!sequantServer) {
      console.error("  ❌ .mcp.json missing sequant server entry");
      errors++;
    } else if (sequantServer.command !== "npx") {
      console.error(
        '  ❌ .mcp.json must use "npx" command (not hardcoded paths)',
      );
      errors++;
    } else if (!pin || pin === "sequant@latest") {
      // Must be a concrete pin (#793) — `@latest` re-resolves on every reconnect.
      console.error(
        `  ❌ .mcp.json must pin a concrete sequant version (got ${pin ?? "no sequant@ arg"}, not sequant@latest)`,
      );
      errors++;
    } else {
      console.log(`  ✅ .mcp.json (MCP server config, pinned ${pin})`);
    }
  } else {
    console.error(
      "  ❌ .mcp.json (MISSING — plugin users won't get MCP tools)",
    );
    errors++;
  }

  const skillsDir = join(OUTPUT_DIR, "skills");
  if (existsSync(skillsDir)) {
    const count = countSkills(skillsDir);
    console.log(`  ✅ skills/ (${count} skills found)`);
  } else {
    console.warn("  ⚠️  skills/ (not found — no skills will be installed)");
  }

  const hooksDir = join(OUTPUT_DIR, "hooks");
  if (existsSync(hooksDir)) {
    console.log("  ✅ hooks/");
  } else {
    console.log("  ℹ️  hooks/ (not included)");
  }

  if (existsSync(join(OUTPUT_DIR, "README.md"))) {
    console.log("  ✅ README.md");
  } else {
    console.warn("  ⚠️  README.md (recommended for marketplace listing)");
  }

  console.log("");
  if (errors > 0) {
    console.error(`❌ Validation failed with ${errors} error(s).`);
    process.exit(1);
  }

  console.log("✅ Marketplace package is valid!");
  console.log(`\nPackage location: ${OUTPUT_DIR}`);
  console.log("\nNext steps:");
  console.log(`  1. Review the package: ls -la ${OUTPUT_DIR}`);
  console.log("  2. Submit via: https://clau.de/plugin-directory-submission");
  console.log(
    "  3. Reference: https://github.com/anthropics/claude-plugins-official",
  );
}

const README_CONTENT = `# Sequant

AI coding agent orchestrator for Claude Code — resolve GitHub issues end-to-end with isolated git worktrees and quality gates, through spec → exec → qa phases.

## Prerequisites

- **Git** with a GitHub remote
- **GitHub CLI** (\`gh\`) authenticated (\`gh auth status\`)
- **Node.js 22.13+** (for MCP server via \`npx\`)

## Installation

### Plugin (interactive users)

\`\`\`
/plugin install sequant@sequant-io/sequant
\`\`\`

Or browse in \`/plugin > Discover\`.

After installing, run \`/sequant:setup\` to configure your project.

> **Plugins do not auto-update.** Claude Code pins a plugin to the version you installed. To pick up a new release, run \`claude plugin update sequant@sequant\`, then restart Claude Code.

### npm (power users / CI)

\`\`\`bash
npm install -g sequant
sequant init
\`\`\`

## What You Get

### 19 Workflow Skills

| Skill | Purpose |
|-------|---------|
| \`/assess\` | Triage issue, recommend workflow |
| \`/spec\` | Plan implementation and extract acceptance criteria |
| \`/exec\` | Implement changes in a feature worktree |
| \`/test\` | Browser-based UI testing |
| \`/qa\` | Code review and AC validation |
| \`/fullsolve\` | End-to-end issue resolution |
| \`/loop\` | Quality loop — iterate until gates pass |
| \`/testgen\` | Generate test stubs from spec criteria |
| \`/verify\` | CLI/script execution verification |
| \`/docs\` | Generate documentation for features |
| \`/reflect\` | Strategic workflow reflection |
| \`/improve\` | Codebase analysis and improvement |
| \`/clean\` | Repository cleanup |
| \`/security-review\` | Deep security analysis |
| \`/solve\` | Generate the recommended workflow for one or more issues |
| \`/merger\` | Multi-issue integration and merge |
| \`/release\` | Version bump, git tag, GitHub release, npm publish |
| \`/upstream\` | Monitor Claude Code releases for breaking changes |
| \`/setup\` | Project initialization for plugin users |

### MCP Tools (automatic with plugin)

| Tool | Purpose |
|------|---------|
| \`sequant_status\` | Check issue progress and workflow state |
| \`sequant_run\` | Execute workflow phases |
| \`sequant_logs\` | Review past run results |

### MCP Resources

| Resource | Purpose |
|----------|---------|
| \`sequant://state\` | Dashboard view of all tracked issues |
| \`sequant://config\` | Current workflow settings |

### Hooks

- **Pre-tool guardrails** — blocks dangerous commands, enforces worktree safety
- **Post-tool tracking** — timing, quality metrics, smart test runner

## Quick Start

\`\`\`
sequant ready        # Boxed pre-flight: which issues are ready to run?
/assess 123          # Analyze issue, get recommended workflow
/fullsolve 123       # End-to-end: spec → exec → qa → PR
\`\`\`

See the [\`sequant ready\` command reference](https://github.com/sequant-io/sequant/blob/main/docs/reference/ready-command.md) for the full pre-flight readiness check.

## Riding out a rate-limit window

By default, a rate limit whose window reopens hours from now halts the run, so a multi-hour job needs a manual restart. \`--auto-wait <minutes>\` opts into waiting instead:

\`\`\`bash
sequant run 42 --auto-wait 360   # wait up to 6 hours total for the window to reopen
\`\`\`

- **Off by default** (\`0\`) — the halt behavior is unchanged unless you ask for the wait.
- The value is a **total** budget per issue, not per occurrence, capped at 2 waits.
- **Never waits on out-of-credits failures** — credits are purchased, not waited out. (These do carry a reset timestamp, so the gate is the error type, not the timestamp.)
- The wait is shown live and Ctrl-C ends it promptly.
- **In-process only: it does not survive closing the terminal** — for waits that must survive a closed terminal or reboot, use halt-and-resume below.
- Worktree and issue locks are held throughout — deliberate, since Claude rate limits are account-wide and no other run could progress during the window anyway.

Also settable as \`run.autoWaitMinutes\` or \`SEQUANT_AUTO_WAIT_MINUTES\`. Full details in the [run command reference](https://github.com/sequant-io/sequant/blob/main/docs/reference/run-command.md#auto-wait-for-a-rate-limit-window).

### Durable recovery: \`sequant resume\`

Without \`--auto-wait\` (or once its budget is exhausted), a run that fails on a waitable rate-limit window writes a durable halt record with its reset time and exits cleanly, releasing the per-issue lock. \`sequant resume\` re-enters after the window reopens, skipping completed phases and issues — safe to invoke repeatedly, so a single cron/launchd entry handles unattended machines. Recipes and full mechanics in the [halt-and-resume reference](https://github.com/sequant-io/sequant/blob/main/docs/reference/halt-and-resume.md).

## Wait for CI, then verify (\`merge --watch\`)

\`sequant merge <issue> --watch\` kills the "merge after green" polling loop: it waits for the PR's CI checks to finish before running merge-check, so the verdict is real the moment the command exits.

\`\`\`bash
sequant merge 818 --watch                 # poll CI to terminal, then run merge-check
sequant merge 818 --watch --scan --post   # composes with depth flags and --post
\`\`\`

- **It never merges** — \`--watch\` only decides _when_ the existing report runs; the human merge gate stays.
- **Foreground only** — a plain poll loop, no daemon or OS notifications. Chain on the exit code to notify yourself.
- **Configurable** \`--interval <seconds>\` (default 30) and \`--timeout <seconds>\` (default 1800); a timeout exits with a distinct code (3).
- **Dispatch blocks short-circuit to BLOCKED** with the cause — merge conflicts (\`CONFLICTING\`), zero checks after a dispatch block, and a runner-never-started billing lockout — instead of polling until timeout.

Full details in the [merge command reference](https://github.com/sequant-io/sequant/blob/main/docs/reference/merge-command.md).

## Running the ready gate inside \`run\`

\`--ready-gate\` opts a \`sequant run\` into the same post-QA gate as \`sequant ready\`, without the second manual command — it automates the habitual any-gaps → fix-gaps second look:

\`\`\`bash
sequant run 42 --ready-gate   # phases, then the gate, then a PR — never merges
\`\`\`

- **Off by default** — without the flag the run path is unchanged.
- Once the standard phases pass, the gate runs a full-weight \`qa → loop → qa\` pass (to \`ready.policy\`) **before** the PR opens, so its fixes land in the PR.
- **It never merges.** The run stops at the human merge gate with the issue \`waiting_for_human_merge\` (threshold reached) or \`blocked\` (a guard halted it).
- Reuses \`ready\`'s policy, iteration cap, and stagnation guard — **no new settings**.

Full details in the [run command reference](https://github.com/sequant-io/sequant/blob/main/docs/reference/run-command.md#ready-gate-post-qa-second-look).

## Documentation

- [Getting Started](https://github.com/sequant-io/sequant/tree/main/docs/getting-started)
- [Configuration](https://github.com/sequant-io/sequant/tree/main/docs/reference)

## License

MIT
`;

main();
