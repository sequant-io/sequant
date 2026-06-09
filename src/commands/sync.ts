/**
 * sequant sync - Fast, non-interactive template sync
 *
 * Syncs skills and other templates from the package to the local project.
 * Designed for plugin users who need to update after upgrading sequant.
 */

import chalk from "chalk";
import { join } from "path";
import { createHash } from "crypto";
import {
  getManifest,
  updateManifest,
  getPackageVersion,
} from "../lib/manifest.js";
import {
  copyTemplates,
  computeTemplateChanges,
  listTemplateFiles,
  getTemplatesDir,
  type CopyTemplatesOptions,
} from "../lib/templates.js";
import { getConfig } from "../lib/config.js";
import { writeFile, readFile, fileExists, getFileStats } from "../lib/fs.js";
import {
  generateAgentsMd,
  writeAgentsMd,
  AGENTS_MD_PATH,
} from "../lib/agents-md.js";
import { getProjectName } from "../lib/project-name.js";
import { getStackConfig } from "../lib/stacks.js";

const SKILLS_VERSION_PATH = ".claude/skills/.sequant-version";

// Where the cheap drift-fingerprint cache lives (gitignored via `**/.sequant/`).
const DRIFT_CACHE_PATH = ".claude/.sequant/.skills-drift-cache.json";
// Mirrors config.ts / manifest.ts (those constants are module-private). These
// install paths are stable; we stat them only to invalidate the drift cache
// when the project's config tokens or manifest stack change.
const CONFIG_FILE_PATH = ".claude/.sequant/config.json";
const MANIFEST_FILE_PATH = ".sequant-manifest.json";

interface SyncOptions {
  force?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
}

interface DriftCache {
  fingerprint: string;
  contentDrift: number;
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
 * Cheap stat-only fingerprint of every input that can change the content-drift
 * result: package version plus the mtime (or absence) of each bundled template,
 * its installed counterpart, any `.claude/.local/` override, and the config and
 * manifest. A full read+render+diff scan is ~15ms per command; this fingerprint
 * is ~2-5ms, so the per-command pre-flight can skip the scan when nothing that
 * affects drift has changed (AC-5). A per-file hash (not a max-mtime) is used so
 * editing an *older* file — whose new mtime may still trail another file's —
 * still changes the fingerprint and forces a rescan (no missed warnings).
 *
 * Returns `null` if it cannot be computed; the caller then scans uncached.
 */
async function computeDriftFingerprint(
  packageVersion: string,
): Promise<string | null> {
  try {
    const templateFiles = await listTemplateFiles();
    const templatesDir = getTemplatesDir();
    const lines: string[] = [`v=${packageVersion}`];

    const addPath = async (fsPath: string, key: string): Promise<void> => {
      try {
        const stats = await getFileStats(fsPath);
        lines.push(`${key}:${Math.round(stats.mtimeMs)}`);
      } catch {
        // Missing file is itself signal: a `.local` override or installed file
        // appearing/disappearing flips this line and invalidates the cache.
        lines.push(`${key}:absent`);
      }
    };

    for (const templatePath of templateFiles) {
      const normalized = templatePath.replace(/\\/g, "/");
      const localPath = normalized.replace("templates/", ".claude/");
      if (localPath.includes(".local/")) continue;
      const templateFsPath = join(
        templatesDir,
        normalized.replace("templates/", ""),
      );
      const overridePath = localPath.replace(".claude/", ".claude/.local/");
      await addPath(templateFsPath, `t:${normalized}`);
      await addPath(localPath, `l:${localPath}`);
      await addPath(overridePath, `o:${overridePath}`);
    }
    await addPath(CONFIG_FILE_PATH, "config");
    await addPath(MANIFEST_FILE_PATH, "manifest");

    lines.sort();
    return createHash("sha1").update(lines.join("\n")).digest("hex");
  } catch {
    return null;
  }
}

async function readDriftCache(): Promise<DriftCache | null> {
  try {
    if (!(await fileExists(DRIFT_CACHE_PATH))) return null;
    const parsed = JSON.parse(await readFile(DRIFT_CACHE_PATH));
    if (
      typeof parsed?.fingerprint === "string" &&
      typeof parsed?.contentDrift === "number"
    ) {
      return parsed as DriftCache;
    }
    return null;
  } catch {
    // Corrupt/unreadable cache → treat as a miss; the scan path rebuilds it.
    return null;
  }
}

async function writeDriftCache(cache: DriftCache): Promise<void> {
  try {
    await writeFile(DRIFT_CACHE_PATH, JSON.stringify(cache));
  } catch {
    // The cache is a pure optimization — never fail a command over a write miss
    // (e.g. the `.claude/.sequant/` dir not existing yet).
  }
}

/**
 * Run the content-drift scan (the source-of-truth `computeTemplateChanges` diff),
 * returning the count of `new`+`modified` files. When `useCache` is true (the
 * per-command pre-flight), a stat-only fingerprint short-circuits the scan if no
 * drift-affecting input changed since the last run. Callers that need fresh
 * truth (`doctor`, and `sync` itself) leave caching off — the default.
 */
async function computeContentDrift(
  packageVersion: string,
  useCache: boolean,
): Promise<number> {
  let fingerprint: string | null = null;
  if (useCache) {
    fingerprint = await computeDriftFingerprint(packageVersion);
    if (fingerprint) {
      const cached = await readDriftCache();
      if (cached && cached.fingerprint === fingerprint) {
        return cached.contentDrift;
      }
    }
  }

  try {
    const manifest = await getManifest();
    if (!manifest) return 0;
    const config = await getConfig();
    const tokens = config?.tokens || {};
    const changes = await computeTemplateChanges(manifest.stack, tokens);
    const contentDrift = changes.filter(
      (c) => c.status === "new" || c.status === "modified",
    ).length;
    if (useCache && fingerprint) {
      await writeDriftCache({ fingerprint, contentDrift });
    }
    return contentDrift;
  } catch {
    // The pre-flight must never break the actual command. If the content diff
    // fails (missing templates, read error), treat it as "no detectable drift"
    // and let the command proceed.
    return 0;
  }
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
 *
 * `options.cache` opts into a stat-only fingerprint cache for the content scan,
 * so the hot pre-flight path (which runs before most commands, including batched
 * `/assess` dashboard calls) pays the full ~15ms scan only when something that
 * affects drift actually changed. Off by default so diagnostic callers (`doctor`)
 * always see fresh truth.
 */
export async function areSkillsOutdated(
  options: { cache?: boolean } = {},
): Promise<SkillsOutdatedStatus> {
  const currentVersion = await getSkillsVersion();
  const packageVersion = getPackageVersion();
  const outdated = currentVersion !== packageVersion;

  let contentDrift = 0;
  if (!outdated) {
    contentDrift = await computeContentDrift(
      packageVersion,
      options.cache === true,
    );
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
  const { force = false, quiet = false, dryRun = false } = options;

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

  // Preview path: report exactly what the apply would write, then stop without
  // mutating (#722). This branch is only reached when `force` is set or the
  // version marker mismatches — i.e. the path that runs `copyTemplates(force:
  // true)` and rewrites the whole tree. (A matching-version, non-force dry-run
  // already returned at the report-only short-circuit above, which never
  // mutates.) `copyTemplates` does NOT protect in-place customizations the way
  // `update` does — the force copy overwrites them — so the preview counts
  // `local-override` files alongside `new`/`modified`. Reporting only
  // new+modified would under-report the write-set, the exact divergence #722
  // is about.
  if (dryRun) {
    const changes = await computeTemplateChanges(manifest.stack, tokens);
    const newFiles = changes.filter((c) => c.status === "new");
    const modifiedFiles = changes.filter((c) => c.status === "modified");
    const localOverrides = changes.filter((c) => c.status === "local-override");
    const toWrite = [...newFiles, ...modifiedFiles, ...localOverrides];

    if (!quiet) {
      console.log(chalk.bold("Summary (dry-run):"));
      console.log(chalk.green(`  New files: ${newFiles.length}`));
      console.log(chalk.yellow(`  Modified: ${modifiedFiles.length}`));
      console.log(
        chalk.blue(
          `  Local overrides (overwritten by sync): ${localOverrides.length}`,
        ),
      );

      if (modifiedFiles.length > 0) {
        console.log(chalk.bold("\nModified files:"));
        for (const file of modifiedFiles) {
          console.log(chalk.yellow(`  ${file.path}`));
        }
      }
      if (newFiles.length > 0) {
        console.log(chalk.bold("\nNew files:"));
        for (const file of newFiles) {
          console.log(chalk.green(`  ${file.path}`));
        }
      }
      if (localOverrides.length > 0) {
        console.log(
          chalk.bold("\nLocal overrides (will be overwritten by sync):"),
        );
        for (const file of localOverrides) {
          console.log(chalk.blue(`  ${file.path}`));
        }
      }

      if (toWrite.length === 0) {
        console.log(chalk.green("\n✔ Skills are already up to date!"));
      } else {
        console.log(chalk.gray("\n(dry-run mode - no changes made)"));
      }
    }

    // Non-zero exit when work is pending so the documented preview surface can
    // gate CI/automation (the #709 intent): a dry-run reporting nothing must
    // mean nothing to do. The matching-version short-circuit signals drift the
    // same way.
    if (toWrite.length > 0) {
      process.exitCode = 1;
    }
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
