/**
 * Template management - copy and process templates
 */

import { readdir, copyFile, chmod } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile, ensureDir, fileExists } from "./fs.js";
import { getStackConfig } from "./stacks.js";

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
function processTemplate(
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
 * Copy all templates to .claude/ directory
 */
export async function copyTemplates(stack: string): Promise<void> {
  const templatesDir = getTemplatesDir();
  const stackConfig = getStackConfig(stack);
  const variables = {
    ...stackConfig.variables,
    PROJECT_NAME: process.cwd().split("/").pop() || "project",
    STACK: stack,
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

  // Copy scripts (worktree helpers, etc.)
  await copyDir(join(templatesDir, "scripts"), "scripts/dev");

  // Copy settings.json
  const settingsPath = join(templatesDir, "settings.json");
  if (await fileExists(settingsPath)) {
    const content = await readFile(settingsPath);
    await writeFile(
      ".claude/settings.json",
      processTemplate(content, variables),
    );
  }
}
