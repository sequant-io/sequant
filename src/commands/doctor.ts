/**
 * sequant doctor - Check installation health
 */

import chalk from "chalk";
import { fileExists, isExecutable } from "../lib/fs.js";
import { getManifest } from "../lib/manifest.js";

interface DoctorOptions {
  fix?: boolean;
}

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: () => Promise<void>;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  console.log(chalk.blue("\n🔍 Running health checks...\n"));

  const checks: Check[] = [];

  // Check 1: Manifest exists
  const manifest = await getManifest();
  if (manifest) {
    checks.push({
      name: "Manifest",
      status: "pass",
      message: `Found .sequant-manifest.json (v${manifest.version})`,
    });
  } else {
    checks.push({
      name: "Manifest",
      status: "fail",
      message: "Missing .sequant-manifest.json - run `sequant init`",
    });
  }

  // Check 2: Skills directory
  const skillsExist = await fileExists(".claude/skills");
  if (skillsExist) {
    checks.push({
      name: "Skills",
      status: "pass",
      message: "Skills directory exists",
    });
  } else {
    checks.push({
      name: "Skills",
      status: "fail",
      message: "Missing .claude/skills/ directory",
    });
  }

  // Check 3: Core skills present
  const coreSkills = ["spec", "exec", "qa"];
  const missingSkills: string[] = [];
  for (const skill of coreSkills) {
    if (!(await fileExists(`.claude/skills/${skill}/SKILL.md`))) {
      missingSkills.push(skill);
    }
  }
  if (missingSkills.length === 0) {
    checks.push({
      name: "Core Skills",
      status: "pass",
      message: "All core skills present (spec, exec, qa)",
    });
  } else {
    checks.push({
      name: "Core Skills",
      status: "fail",
      message: `Missing skills: ${missingSkills.join(", ")}`,
    });
  }

  // Check 4: Hooks directory
  const hooksExist = await fileExists(".claude/hooks");
  if (hooksExist) {
    checks.push({
      name: "Hooks",
      status: "pass",
      message: "Hooks directory exists",
    });
  } else {
    checks.push({
      name: "Hooks",
      status: "warn",
      message: "No hooks directory (optional but recommended)",
    });
  }

  // Check 5: Hook scripts executable
  const preToolHook = ".claude/hooks/pre-tool.sh";
  if (await fileExists(preToolHook)) {
    if (await isExecutable(preToolHook)) {
      checks.push({
        name: "Hook Permissions",
        status: "pass",
        message: "Hook scripts are executable",
      });
    } else {
      checks.push({
        name: "Hook Permissions",
        status: "warn",
        message:
          "Hook scripts not executable - run: chmod +x .claude/hooks/*.sh",
      });
    }
  }

  // Check 6: Settings.json
  const settingsExist = await fileExists(".claude/settings.json");
  if (settingsExist) {
    checks.push({
      name: "Settings",
      status: "pass",
      message: "Settings file exists",
    });
  } else {
    checks.push({
      name: "Settings",
      status: "warn",
      message: "No settings.json (hooks won't be triggered)",
    });
  }

  // Check 7: Git repo
  const gitExists = await fileExists(".git");
  if (gitExists) {
    checks.push({
      name: "Git Repository",
      status: "pass",
      message: "Git repository detected",
    });
  } else {
    checks.push({
      name: "Git Repository",
      status: "warn",
      message: "Not a git repository (worktree features won't work)",
    });
  }

  // Display results
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    const icon =
      check.status === "pass"
        ? chalk.green("✓")
        : check.status === "warn"
          ? chalk.yellow("⚠")
          : chalk.red("✗");
    const color =
      check.status === "pass"
        ? chalk.green
        : check.status === "warn"
          ? chalk.yellow
          : chalk.red;

    console.log(`${icon} ${chalk.bold(check.name)}: ${color(check.message)}`);

    if (check.status === "pass") passCount++;
    else if (check.status === "warn") warnCount++;
    else failCount++;
  }

  // Summary
  console.log(chalk.bold("\nSummary:"));
  console.log(chalk.green(`  ✓ Passed: ${passCount}`));
  if (warnCount > 0) console.log(chalk.yellow(`  ⚠ Warnings: ${warnCount}`));
  if (failCount > 0) console.log(chalk.red(`  ✗ Failed: ${failCount}`));

  if (failCount > 0) {
    console.log(
      chalk.red("\n❌ Some checks failed. Run `sequant init` to fix."),
    );
    process.exit(1);
  } else if (warnCount > 0) {
    console.log(
      chalk.yellow("\n⚠️  Some warnings found but Sequant should work."),
    );
  } else {
    console.log(chalk.green("\n✅ All checks passed!"));
  }
}
