/**
 * Template management - copy and process templates
 */

import { readdir, chmod } from "fs/promises";
import { join, dirname, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import {
  readFile,
  writeFile,
  ensureDir,
  fileExists,
  isSymlink,
  createSymlink,
  removeFileOrSymlink,
} from "./fs.js";
import { getStackConfig, getStackNotes } from "./stacks.js";
import { isNativeWindows } from "./system.js";
import { getProjectName } from "./project-name.js";

// Get the package templates directory
function getTemplatesDir(): string {
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
  const stackConfig = getStackConfig(stack);

  // Detect project name from available sources (package.json, Cargo.toml, etc.)
  const projectName = await getProjectName();

  // Get stack-specific notes for constitution template
  const stackNotes = getStackNotes(stack);

  const variables = {
    ...stackConfig.variables,
    ...tokens,
    PROJECT_NAME: projectName,
    STACK: stack,
    STACK_NOTES: stackNotes,
  };

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

  return { scriptsSymlinked, symlinkResults };
}
