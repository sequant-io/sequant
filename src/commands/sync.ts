/**
 * sequant sync - Fast, non-interactive template sync
 *
 * Syncs skills and other templates from the package to the local project.
 * Designed for plugin users who need to update after upgrading sequant.
 */

import chalk from "chalk";
import {
  getManifest,
  updateManifest,
  getPackageVersion,
} from "../lib/manifest.js";
import {
  copyTemplates,
  computeTemplateChanges,
  type CopyTemplatesOptions,
} from "../lib/templates.js";
import { getConfig } from "../lib/config.js";
import { writeFile, readFile, fileExists } from "../lib/fs.js";
import {
  generateAgentsMd,
  writeAgentsMd,
  AGENTS_MD_PATH,
} from "../lib/agents-md.js";
import { getProjectName } from "../lib/project-name.js";
import { getStackConfig } from "../lib/stacks.js";

const SKILLS_VERSION_PATH = ".claude/skills/.sequant-version";

interface SyncOptions {
  force?: boolean;
  quiet?: boolean;
}

/**
 * Get the version of skills currently installed
 */
export async function getSkillsVersion(): Promise<string | null> {
  if (!(await fileExists(SKILLS_VERSION_PATH))) {
    return null;
  }
  try {
    const content = await readFile(SKILLS_VERSION_PATH);
    return content.trim();
  } catch {
    return null;
  }
}

/**
 * Skills status relative to the bundled package, as seen by the pre-flight path.
 */
export interface SkillsOutdatedStatus {
  /** Version-marker mismatch (`.sequant-version` ≠ package). Cheap fast-path. */
  outdated: boolean;
  currentVersion: string | null;
  packageVersion: string;
  /**
   * Count of bundled files that are `new` or `modified` in place at a *matching*
   * version (the #708 blind spot the version marker can't see). Only computed
   * when versions match; `0` otherwise (a mismatch already means stale). Excludes
   * `local-override`/`unchanged` so customized files (e.g. constitution, #711)
   * don't register as drift.
   */
  contentDrift: number;
}

/**
 * Check if skills are outdated compared to package version.
 *
 * The version marker is only a cheap hint: a tree at the matching version can
 * still have drifted bundled content in place (the #708 root cause). So when the
 * marker matches we run the same content diff `sync` uses (`computeTemplateChanges`,
 * the single source of truth from #708/#710) and surface a `contentDrift` count.
 * On a version *mismatch* we skip the diff entirely — the install is already stale
 * and the copy path handles it — keeping the per-command pre-flight cheap (AC-5).
 */
export async function areSkillsOutdated(): Promise<SkillsOutdatedStatus> {
  const currentVersion = await getSkillsVersion();
  const packageVersion = getPackageVersion();
  const outdated = currentVersion !== packageVersion;

  let contentDrift = 0;
  if (!outdated) {
    try {
      const manifest = await getManifest();
      if (manifest) {
        const config = await getConfig();
        const tokens = config?.tokens || {};
        const changes = await computeTemplateChanges(manifest.stack, tokens);
        contentDrift = changes.filter(
          (c) => c.status === "new" || c.status === "modified",
        ).length;
      }
    } catch {
      // The pre-flight must never break the actual command. If the content diff
      // fails (missing templates, read error), treat it as "no detectable drift"
      // and let the command proceed.
      contentDrift = 0;
    }
  }

  return { outdated, currentVersion, packageVersion, contentDrift };
}

/**
 * Update the skills version marker
 */
async function updateSkillsVersion(): Promise<void> {
  await writeFile(SKILLS_VERSION_PATH, getPackageVersion());
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  const { force = false, quiet = false } = options;

  if (!quiet) {
    console.log(chalk.blue("\nSyncing templates...\n"));
    console.log(
      chalk.yellow(
        "Note: For seamless auto-updates, install sequant as a Claude Code plugin:\n" +
          "   /plugin install sequant@claude-plugin-directory\n" +
          "   Plugin users get auto-updates without running sync manually.\n",
      ),
    );
  }

  // Check if initialized
  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    process.exitCode = 1;
    return;
  }

  const packageVersion = getPackageVersion();
  const skillsVersion = await getSkillsVersion();

  if (!quiet) {
    console.log(chalk.gray(`Skills version: ${skillsVersion || "(unknown)"}`));
    console.log(chalk.gray(`Package version: ${packageVersion}`));
    console.log(chalk.gray(`Stack: ${manifest.stack}\n`));
  }

  // Get config tokens for template processing
  const config = await getConfig();
  const tokens = config?.tokens || {};

  // The version marker is only a fast-path hint — verify actual content before
  // claiming "up to date". On a version match we still diff bundled templates
  // against installed content (rendered with the same variables) so we never
  // declare success while real drift sits in place (#708).
  if (!force && skillsVersion === packageVersion) {
    const changes = await computeTemplateChanges(manifest.stack, tokens);
    const drifted = changes.filter(
      (c) => c.status === "new" || c.status === "modified",
    );

    if (drifted.length === 0) {
      // Truthful no-op: content is actually identical.
      if (!quiet) {
        console.log(chalk.green("✔ Skills are already up to date!"));
      }
      return;
    }

    // Version current but content differs — report, don't mutate (report-only
    // keeps the fast path from silently overwriting in-place customizations).
    if (!quiet) {
      console.log(
        chalk.yellow(
          `!  Version current, but ${drifted.length} file(s) differ — run \`update\` or \`sync --force\``,
        ),
      );
    }
    // Signal drift with a non-zero exit code even under --quiet. The exit code
    // is the machine signal the (suppressible) message is not, so the
    // non-interactive / CI path we recommend can't treat a drifted tree as
    // success — the original failure mode in #708.
    process.exitCode = 1;
    return;
  }

  // Copy templates with force to overwrite existing files
  const copyOptions: CopyTemplatesOptions = {
    force: true, // Always overwrite when syncing
  };

  if (!quiet) {
    console.log(chalk.blue("Copying templates..."));
  }

  await copyTemplates(manifest.stack, tokens, copyOptions);

  // Update version markers
  await updateSkillsVersion();
  await updateManifest();

  // Regenerate AGENTS.md if it exists
  if (await fileExists(AGENTS_MD_PATH)) {
    try {
      const stackConfig = getStackConfig(manifest.stack);
      const projectName = await getProjectName();
      const agentsMdContent = await generateAgentsMd({
        projectName,
        stack: manifest.stack,
        buildCommand: stackConfig.variables.BUILD_COMMAND,
        testCommand: stackConfig.variables.TEST_COMMAND,
        lintCommand: stackConfig.variables.LINT_COMMAND,
      });
      await writeAgentsMd(agentsMdContent);
      if (!quiet) {
        console.log(chalk.blue("Regenerated AGENTS.md"));
      }
    } catch {
      if (!quiet) {
        console.log(
          chalk.yellow("!  Could not regenerate AGENTS.md (non-blocking)"),
        );
      }
    }
  }

  if (!quiet) {
    console.log(chalk.green(`\n✔ Synced to v${packageVersion}`));
    console.log(
      chalk.gray("\nSkills, hooks, and memory files have been updated."),
    );
  }
}

/**
 * Check and warn if skills are outdated (for use by other commands).
 *
 * Warns on either signal: a version-marker mismatch, or in-place content drift at
 * a matching version (#708/#713). The content-drift path is warn-only by design —
 * it never mutates files and never sets `process.exitCode` (this is a pre-flight,
 * not the command itself), so customized installs (#711) are left intact.
 *
 * Callers that have already computed the status (e.g. the `preAction` hook) can
 * pass it in to avoid a second template scan on the hot path (AC-5).
 *
 * @returns `true` if a warning was emitted, `false` if up to date.
 */
export async function checkAndWarnSkillsOutdated(
  status?: SkillsOutdatedStatus,
): Promise<boolean> {
  const { outdated, currentVersion, packageVersion, contentDrift } =
    status ?? (await areSkillsOutdated());

  if (outdated) {
    console.log(
      chalk.yellow(
        `\n!  Skills are outdated (${currentVersion || "unknown"} → ${packageVersion})`,
      ),
    );
    console.log(chalk.yellow("   Run: npx sequant sync\n"));
    return true;
  }

  if (contentDrift > 0) {
    // Mirror syncCommand's own drift remediation: a bare `sync` at a matching
    // version is report-only (it won't copy), so point at the commands that
    // actually resolve in-place drift — `sync --force` or `update`.
    console.log(
      chalk.yellow(
        `\n!  Version current, but ${contentDrift} file(s) differ from bundled content`,
      ),
    );
    console.log(
      chalk.yellow(
        "   Run: npx sequant sync --force (or npx sequant update)\n",
      ),
    );
    return true;
  }

  return false;
}
