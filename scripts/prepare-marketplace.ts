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

    // 4. Copy .mcp.json (MCP server config for plugin users)
    console.log("📋 Copying MCP server config...");
    const mcpJsonPath = join(PROJECT_ROOT, "templates", "mcp.json");
    if (existsSync(mcpJsonPath)) {
      cpSync(mcpJsonPath, join(OUTPUT_DIR, ".mcp.json"));
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
    if (!sequantServer) {
      console.error("  ❌ .mcp.json missing sequant server entry");
      errors++;
    } else if (sequantServer.command !== "npx") {
      console.error(
        '  ❌ .mcp.json must use "npx" command (not hardcoded paths)',
      );
      errors++;
    } else {
      console.log("  ✅ .mcp.json (MCP server config)");
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

Structured workflow system for Claude Code — GitHub issue resolution with spec, exec, test, and QA phases.

## Prerequisites

- **Git** with a GitHub remote
- **GitHub CLI** (\`gh\`) authenticated (\`gh auth status\`)
- **Node.js 20+** (for MCP server via \`npx\`)

## Installation

### Plugin (interactive users)

\`\`\`
/plugin install sequant@sequant-io/sequant
\`\`\`

Or browse in \`/plugin > Discover\`.

After installing, run \`/sequant:setup\` to configure your project.

### npm (power users / CI)

\`\`\`bash
npm install -g sequant
sequant init
\`\`\`

## What You Get

### 17 Workflow Skills

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
| \`/release\` | Automated release workflow |
| \`/merger\` | Multi-issue integration and merge |
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
/assess 123          # Analyze issue, get recommended workflow
/fullsolve 123       # End-to-end: spec → exec → qa → PR
\`\`\`

## Documentation

- [Getting Started](https://github.com/sequant-io/sequant/tree/main/docs/getting-started)
- [Configuration](https://github.com/sequant-io/sequant/tree/main/docs/reference)

## License

MIT
`;

main();
