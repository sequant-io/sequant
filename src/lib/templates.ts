/**
 * Template management - copy and process templates
 */

import { readdir, chmod } from "fs/promises";
import { join, dirname, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { diffLines } from "diff";
import {
  readFile,
  writeFile,
  ensureDir,
  fileExists,
  isSymlink,
  createSymlink,
  removeFileOrSymlink,
} from "./fs.js";
import { getPackageVersion } from "./manifest.js";

const SKILLS_VERSION_PATH = ".claude/skills/.sequant-version";
import { getStackConfig, getStackNotes, getMultiStackNotes } from "./stacks.js";
import { isNativeWindows } from "./system.js";
import { getProjectName } from "./project-name.js";

// Get the package templates directory
export function getTemplatesDir(): string {
  // Allow overriding the templates source (used by tests; also lets the dir be
  // relocated without relying on the compiled-output layout below).
  if (process.env.SEQUANT_TEMPLATES_DIR) {
    return process.env.SEQUANT_TEMPLATES_DIR;
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Compiled structure: dist/src/lib/templates.js
  // So we need ../../../templates to reach project root templates/
  const devPath = join(__dirname, "..", "..", "..", "templates");

  return devPath;
}

/**
 * Process template variables in content
 */
export function processTemplate(
  content: string,
  variables: Record<string, string>,
): string {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

/**
 * List all template files
 */
export async function listTemplateFiles(): Promise<string[]> {
  const templatesDir = getTemplatesDir();
  const files: string[] = [];

  async function walk(dir: string, prefix: string = ""): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = join(prefix, entry.name);
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath, relativePath);
        } else {
          files.push(join("templates", relativePath));
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  await walk(templatesDir);
  return files;
}

/**
 * Get content of a template file
 */
export async function getTemplateContent(
  templatePath: string,
): Promise<string> {
  const templatesDir = getTemplatesDir();
  const relativePath = templatePath.replace("templates/", "");
  const fullPath = join(templatesDir, relativePath);

  return readFile(fullPath);
}

/**
 * Files that are meant to be edited in place per project (e.g. the
 * constitution). When one of these diverges from the rendered template
 * without a parallel `.claude/.local/` file, it is treated as a protected
 * local override rather than a stale "modified" file — so the default
 * (non-`--force`) update/sync path never silently overwrites it.
 */
export const CUSTOMIZABLE_FILES = [".claude/memory/constitution.md"];

/**
 * Whether a local path is a customizable file edited in place per project.
 */
export function isCustomizableFile(localPath: string): boolean {
  return CUSTOMIZABLE_FILES.includes(localPath);
}

/**
 * Build the full set of template variables used when rendering templates.
 *
 * This is the single source of truth shared by `copyTemplates` (write time)
 * and `computeTemplateChanges` (diff time) so the two can never drift — a
 * mismatch here is what caused `constitution.md` to read as "modified" on
 * every project (the diff used a different/incomplete variable set than the
 * write). See #708.
 */
export async function buildTemplateVariables(
  stack: string,
  tokens?: Record<string, string>,
  options: { additionalStacks?: string[] } = {},
): Promise<Record<string, string>> {
  const stackConfig = getStackConfig(stack);

  // Detect project name from available sources (package.json, Cargo.toml, etc.)
  const projectName = await getProjectName();

  // Get stack-specific notes for constitution template
  // Use multi-stack notes if additional stacks are provided
  const stackNotes =
    options.additionalStacks && options.additionalStacks.length > 0
      ? getMultiStackNotes(stack, options.additionalStacks)
      : getStackNotes(stack);

  return {
    ...stackConfig.variables,
    ...tokens,
    PROJECT_NAME: projectName,
    STACK: stack,
    STACK_NOTES: stackNotes,
  };
}

/**
 * A single template file's status relative to the installed copy.
 */
export interface TemplateChange {
  /** Installed path under `.claude/` */
  path: string;
  /** Source template path under `templates/` */
  templatePath: string;
  status: "new" | "modified" | "unchanged" | "local-override";
  /** Template content rendered with the project's variables */
  rendered: string;
  /** Unified-ish diff (installed → rendered), only set for `modified` */
  diff?: string;
}

/**
 * Compare bundled template content against what's installed under `.claude/`.
 *
 * Templates are rendered with the project's variables *before* comparison, so
 * an unmodified file (e.g. a constitution with `{{PROJECT_NAME}}` expanded)
 * reads as `unchanged` rather than `modified`. A file that diverges in place is
 * `local-override` (skip-by-default) when it has a parallel `.claude/.local/`
 * file or is in the customizable allow-list; otherwise it is `modified`.
 */
export async function computeTemplateChanges(
  stack: string,
  tokens?: Record<string, string>,
  options: { additionalStacks?: string[] } = {},
): Promise<TemplateChange[]> {
  const variables = await buildTemplateVariables(stack, tokens, options);
  const templateFiles = await listTemplateFiles();
  const changes: TemplateChange[] = [];

  for (const templatePath of templateFiles) {
    const localPath = templatePath.replace("templates/", ".claude/");

    // Skip .local files (user customizations are never overwritten)
    if (localPath.includes(".local/")) {
      continue;
    }

    const rendered = processTemplate(
      await getTemplateContent(templatePath),
      variables,
    );
    const exists = await fileExists(localPath);

    if (!exists) {
      changes.push({ path: localPath, templatePath, status: "new", rendered });
      continue;
    }

    const localContent = await readFile(localPath);
    if (localContent === rendered) {
      changes.push({
        path: localPath,
        templatePath,
        status: "unchanged",
        rendered,
      });
      continue;
    }

    // Content differs after rendering. Protect in-place customizations:
    // a parallel `.claude/.local/` override, or a known customizable file.
    const localOverridePath = localPath.replace(".claude/", ".claude/.local/");
    const hasLocalOverride = await fileExists(localOverridePath);

    if (hasLocalOverride || isCustomizableFile(localPath)) {
      changes.push({
        path: localPath,
        templatePath,
        status: "local-override",
        rendered,
      });
      continue;
    }

    const diff = diffLines(localContent, rendered)
      .map((part) => {
        const prefix = part.added ? "+" : part.removed ? "-" : " ";
        return part.value
          .split("\n")
          .filter((l) => l)
          .map((l) => `${prefix} ${l}`)
          .join("\n");
      })
      .join("\n");
    changes.push({
      path: localPath,
      templatePath,
      status: "modified",
      rendered,
      diff,
    });
  }

  return changes;
}

/**
 * Result of symlink creation attempt
 */
export interface SymlinkResult {
  created: boolean;
  path: string;
  target: string;
  fallbackToCopy: boolean;
  skipped: boolean;
  reason?: string;
}

/**
 * Options for copyTemplates
 */
export interface CopyTemplatesOptions {
  /** Use copies instead of symlinks for scripts (Windows default or user preference) */
  noSymlinks?: boolean;
  /** Force replacement of existing files/symlinks */
  force?: boolean;
  /** Additional stacks to include in constitution notes (for multi-stack projects) */
  additionalStacks?: string[];
}

/**
 * Create symlinks for files in a directory, with fallback to copy
 * @param srcDir Source directory containing template files
 * @param destDir Destination directory for symlinks
 * @param options Options controlling symlink behavior
 * @returns Array of results for each file
 */
export async function symlinkDir(
  srcDir: string,
  destDir: string,
  options: { force?: boolean } = {},
): Promise<SymlinkResult[]> {
  const results: SymlinkResult[] = [];

  try {
    const entries = await readdir(srcDir, { withFileTypes: true });
    await ensureDir(destDir);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Recursively handle subdirectories
        const subResults = await symlinkDir(
          join(srcDir, entry.name),
          join(destDir, entry.name),
          options,
        );
        results.push(...subResults);
        continue;
      }

      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      // Calculate relative path from destDir to srcPath for portable symlinks
      // Note: srcPath may already be absolute (when srcDir is absolute), so check first
      const absoluteDest = isAbsolute(destPath)
        ? destPath
        : join(process.cwd(), destPath);
      const absoluteSrc = isAbsolute(srcPath)
        ? srcPath
        : join(process.cwd(), srcPath);
      const relativeTarget = relative(dirname(absoluteDest), absoluteSrc);

      // Check if destination already exists
      // Note: isSymlink uses lstat and works on broken symlinks,
      // while fileExists uses access which fails on broken symlinks
      const destIsSymlink = await isSymlink(destPath);
      const destExists = destIsSymlink || (await fileExists(destPath));

      if (destExists && !destIsSymlink && !options.force) {
        // Regular file exists and force not specified - skip
        results.push({
          created: false,
          path: destPath,
          target: relativeTarget,
          fallbackToCopy: false,
          skipped: true,
          reason: "existing file (use --force to replace)",
        });
        continue;
      }

      // Remove existing file/symlink if force or if it's already a symlink
      // (symlinks are always replaced to ensure they point to correct target)
      if (destExists && (options.force || destIsSymlink)) {
        await removeFileOrSymlink(destPath);
      }

      // Try to create symlink
      const symlinkCreated = await createSymlink(relativeTarget, destPath);

      if (symlinkCreated) {
        results.push({
          created: true,
          path: destPath,
          target: relativeTarget,
          fallbackToCopy: false,
          skipped: false,
        });
      } else {
        // Symlink failed (likely Windows without privileges) - fall back to copy
        const content = await readFile(srcPath);
        await writeFile(destPath, content);

        // Make shell scripts executable
        if (entry.name.endsWith(".sh")) {
          await chmod(destPath, 0o755);
        }

        results.push({
          created: true,
          path: destPath,
          target: relativeTarget,
          fallbackToCopy: true,
          skipped: false,
          reason: "symlink not supported, copied instead",
        });
      }
    }
  } catch (error) {
    // Skip if source doesn't exist
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return results;
}

/**
 * Copy all templates to .claude/ directory
 */
export async function copyTemplates(
  stack: string,
  tokens?: Record<string, string>,
  options: CopyTemplatesOptions = {},
): Promise<{ scriptsSymlinked: boolean; symlinkResults?: SymlinkResult[] }> {
  const templatesDir = getTemplatesDir();

  // Single source of truth for template variables (shared with the diff path)
  const variables = await buildTemplateVariables(stack, tokens, options);

  async function copyDir(srcDir: string, destDir: string): Promise<void> {
    try {
      const entries = await readdir(srcDir, { withFileTypes: true });
      await ensureDir(destDir);

      for (const entry of entries) {
        const srcPath = join(srcDir, entry.name);
        const destPath = join(destDir, entry.name);

        if (entry.isDirectory()) {
          await copyDir(srcPath, destPath);
        } else {
          // Read, process, and write
          let content = await readFile(srcPath);
          content = processTemplate(content, variables);
          await writeFile(destPath, content);

          // Make shell scripts executable
          if (entry.name.endsWith(".sh")) {
            await chmod(destPath, 0o755);
          }
        }
      }
    } catch (error) {
      // Skip if source doesn't exist
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Copy skills
  await copyDir(join(templatesDir, "skills"), ".claude/skills");

  // Copy agent definitions
  await copyDir(join(templatesDir, "agents"), ".claude/agents");

  // Copy hooks
  await copyDir(join(templatesDir, "hooks"), ".claude/hooks");

  // Copy memory (constitution, etc.)
  await copyDir(join(templatesDir, "memory"), ".claude/memory");

  // Handle scripts directory - use symlinks unless disabled
  const useSymlinks = !options.noSymlinks && !isNativeWindows();
  let scriptsSymlinked = false;
  let symlinkResults: SymlinkResult[] | undefined;

  if (useSymlinks) {
    // Use symlinks for scripts - they don't need template variable processing
    symlinkResults = await symlinkDir(
      join(templatesDir, "scripts"),
      "scripts/dev",
      { force: options.force },
    );

    // Check if any symlinks were actually created (not all fell back to copy)
    scriptsSymlinked = symlinkResults.some(
      (r) => r.created && !r.fallbackToCopy,
    );
  } else {
    // Fall back to copies (Windows or --no-symlinks flag)
    await copyDir(join(templatesDir, "scripts"), "scripts/dev");
  }

  // Copy settings.json
  const settingsPath = join(templatesDir, "settings.json");
  if (await fileExists(settingsPath)) {
    const content = await readFile(settingsPath);
    await writeFile(
      ".claude/settings.json",
      processTemplate(content, variables),
    );
  }

  // Write skills version marker for sync detection
  await writeFile(SKILLS_VERSION_PATH, getPackageVersion());

  return { scriptsSymlinked, symlinkResults };
}
