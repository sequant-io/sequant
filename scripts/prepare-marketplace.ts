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

  console.log(`Version: ${version}`);

  if (version !== pluginVersion) {
    console.error(
      `❌ Version mismatch: package.json (${version}) != plugin.json (${pluginVersion})`,
    );
    console.error("   Run ./scripts/release.sh to sync versions.");
    process.exit(1);
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

    // 4. Generate README
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

## Installation

\`\`\`
/plugin install sequant@claude-plugin-directory
\`\`\`

Or browse in \`/plugin > Discover\`.

## Features

- **16 workflow skills** for planning, implementation, testing, and code review
- **Automated quality gates** with test and QA loops
- **GitHub integration** for issue tracking and PR creation
- **Multi-stack support** (Next.js, Python, Go, Rust, and more)

## Skills

| Skill | Purpose |
|-------|---------|
| \`/spec\` | Plan implementation and extract acceptance criteria |
| \`/exec\` | Implement changes in a feature worktree |
| \`/test\` | Browser-based UI testing |
| \`/qa\` | Code review and AC validation |
| \`/fullsolve\` | End-to-end issue resolution |
| \`/assess\` | Triage issue, recommend workflow (6-action vocabulary) |

## Documentation

- [Getting Started](https://github.com/sequant-io/sequant/tree/main/docs/getting-started)
- [Configuration](https://github.com/sequant-io/sequant/tree/main/docs/reference)

## License

MIT
`;

main();
