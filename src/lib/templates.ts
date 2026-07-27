/**
 * Template management - copy and process templates
 */

import { readdir, chmod, stat } from "fs/promises";
import { existsSync, readFileSync } from "fs";
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

/**
 * Offsets from this module's directory to the bundled `templates/` root, in
 * probe order. This module lives at `src/lib/templates.ts`, so it sits three
 * levels below the package root once compiled (`dist/src/lib/templates.js`) but
 * only two when executed straight from source under `tsx` (`src/lib/`).
 *
 * The compiled offset is listed first so consumers — who always run the compiled
 * binary — keep byte-identical behavior. See #822.
 */
const TEMPLATES_DIR_OFFSETS = [
  ["..", "..", "..", "templates"], // compiled: dist/src/lib → <pkg>/templates
  ["..", "..", "templates"], // source (tsx): src/lib → <repo>/templates
] as const;

/**
 * How well a candidate path matches "the templates root of *this* package".
 *
 * `package-root` outranks `exists` because the two offsets are not mutually
 * exclusive: from a source tree at `<repo>/src/lib`, the *compiled* offset
 * resolves to `<repo>/../templates` — a directory one level **above** the repo.
 * A bare existence probe would happily bind to an unrelated `templates/` that
 * happens to sit beside the checkout. Requiring the candidate's parent to be
 * the sequant package root removes that ambiguity without walking the tree.
 */
export type TemplatesCandidateRank = "package-root" | "exists" | "missing";

/**
 * Resolve the templates root relative to a module directory, given a ranking
 * function.
 *
 * Split out from `getTemplatesDir` purely so both layouts are testable: a test
 * cannot relocate `import.meta.url`, so without injection the "works from both
 * layouts" assertion could only ever exercise whichever layout the test runner
 * happens to use.
 *
 * Resolution order: the first `package-root` candidate, else the first that
 * merely `exists` (keeps any layout that works today working, even one whose
 * package root is not where we expect), else the **compiled** offset — so the
 * caller's error message names the canonical expected location rather than a
 * source-tree guess.
 */
export function resolveTemplatesDirFrom(
  baseDir: string,
  rank: (candidate: string) => TemplatesCandidateRank,
): string {
  const candidates = TEMPLATES_DIR_OFFSETS.map((offset) =>
    join(baseDir, ...offset),
  );
  const ranked = candidates.map((candidate) => ({
    candidate,
    rank: rank(candidate),
  }));

  return (
    ranked.find((c) => c.rank === "package-root")?.candidate ??
    ranked.find((c) => c.rank === "exists")?.candidate ??
    candidates[0]
  );
}

/**
 * Rank a candidate by checking whether it exists and whether its parent is the
 * sequant package root. Anchoring on `package.json` mirrors how every other
 * root resolver in this codebase locates the package (`version.ts`,
 * `manifest.ts`, `bin/preflight.ts`).
 */
function rankTemplatesCandidate(candidate: string): TemplatesCandidateRank {
  if (!existsSync(candidate)) {
    return "missing";
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(candidate, "..", "package.json"), "utf-8"),
    );
    if (pkg.name === "sequant") {
      return "package-root";
    }
  } catch {
    // No readable/parseable package.json beside it — still a usable directory,
    // just not a positively identified package root.
  }
  return "exists";
}

/**
 * Memoized bundled-templates path. Resolution is now stat-backed rather than a
 * pure string join, and `getTemplateContent` calls it once per template file
 * during a drift scan — ~2ms per scan uncached, on a pre-flight path #708
 * deliberately keeps in the 2-5ms range. The install layout cannot change
 * within a process, so caching it is safe. Only the *bundled* resolution is
 * cached; the env override is re-read every call, so tests that set and unset
 * `SEQUANT_TEMPLATES_DIR` are unaffected.
 */
let cachedBundledTemplatesDir: string | undefined;

// Get the package templates directory
export function getTemplatesDir(): string {
  // Allow overriding the templates source (used by tests; also lets the dir be
  // relocated without relying on the compiled-output layout below). Returned
  // verbatim — the override is authoritative and is never probed, so a bad
  // value surfaces at `assertTemplatesDirExists` rather than silently falling
  // back to the bundled tree.
  if (process.env.SEQUANT_TEMPLATES_DIR) {
    return process.env.SEQUANT_TEMPLATES_DIR;
  }

  if (cachedBundledTemplatesDir === undefined) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    cachedBundledTemplatesDir = resolveTemplatesDirFrom(
      __dirname,
      rankTemplatesCandidate,
    );
  }
  return cachedBundledTemplatesDir;
}

/**
 * Resolve the templates root and fail loudly when it does not exist.
 *
 * A missing templates *root* means the install is broken: every `copyDir` call
 * below would hit `copyDir`'s per-directory ENOENT skip, no-op, and let the
 * caller print a success message over an empty tree (#822). That skip is
 * deliberate for individual subdirectories — a stack may legitimately ship
 * without `memory/` — but it must not absorb the whole source tree.
 *
 * Throws rather than printing so the lib layer stays free of presentation;
 * commands catch and render.
 */
export async function assertTemplatesDirExists(): Promise<string> {
  const templatesDir = getTemplatesDir();
  // A *directory* check, not a bare existence check: a stray file at that path
  // would pass `access()` and then fail deeper in `readdir` with the same silent
  // ENOTDIR-shaped confusion this guard exists to prevent.
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(templatesDir)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory) {
    return templatesDir;
  }
  throw new Error(
    `Bundled templates directory not found: ${templatesDir}\n` +
      "This usually means the Sequant install is incomplete or was run from an unexpected layout.\n" +
      "Reinstall sequant, or set SEQUANT_TEMPLATES_DIR to the templates/ directory.",
  );
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
  // Normalize OS path separators so the allow-list match holds on Windows,
  // where template paths are assembled with backslashes (#708).
  return CUSTOMIZABLE_FILES.includes(localPath.replace(/\\/g, "/"));
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
    // Normalize separators first: listTemplateFiles builds paths with the OS
    // separator (backslashes on Windows), but the prefix swap and the .local/
    // and customizable-file checks below all assume forward slashes (#708).
    const localPath = templatePath
      .replace(/\\/g, "/")
      .replace("templates/", ".claude/");

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
    //
    // Note: this protects a managed file that was *edited in place* (e.g. the
    // constitution) when a parallel `.claude/.local/` twin exists. It is NOT a
    // skill-loading mechanism — the harness never loads `.claude/.local/skills/
    // <name>/SKILL.md`, so a full-file SKILL.md shadow does nothing at runtime
    // (#711). Skills are instead customized via a runtime overlay: each managed
    // SKILL.md opens (before its first heading) with a directive to honor
    // `.claude/.local/skills/<name>/overrides.md`, and that overrides file is
    // auto-skipped above because it lives under `.local/`. The directive sits at
    // the top, not end-of-file, so it fires reliably even in 3000-line skills.
    // See docs/guides/customization.md.
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
  /**
   * Opt in to overwriting in-place customizations (files in `CUSTOMIZABLE_FILES`,
   * e.g. the constitution) that already exist and differ from the rendered
   * template. Deliberately separate from `force`: `force` refreshes the managed
   * skills/agents/hooks trees, but that always-on tree overwrite must NOT imply
   * consent to clobber user-owned files. Only an explicit user `--force` sets
   * this. A missing or identical customizable file is written regardless (#814).
   */
  overwriteCustomizable?: boolean;
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
): Promise<{
  scriptsSymlinked: boolean;
  symlinkResults?: SymlinkResult[];
  /**
   * Customizable files that already existed, differed from the rendered
   * template, and were left untouched because `overwriteCustomizable` was not
   * set. Normalized to forward slashes so callers can report them verbatim.
   */
  preservedCustomizable: string[];
}> {
  const templatesDir = getTemplatesDir();

  // Single source of truth for template variables (shared with the diff path)
  const variables = await buildTemplateVariables(stack, tokens, options);

  // Customizable files skipped on the write path (see copyDir), surfaced to the
  // caller so it can report them without a second diff pass (#814).
  const preservedCustomizable: string[] = [];

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

          // Protect in-place customizations on the write path. A file in
          // CUSTOMIZABLE_FILES that already exists and differs from the
          // rendered template is preserved unless the caller explicitly opted
          // in via `overwriteCustomizable`. A missing file (fresh install) or
          // an identical one falls through and is written as usual (#814).
          if (
            !options.overwriteCustomizable &&
            isCustomizableFile(destPath) &&
            (await fileExists(destPath))
          ) {
            const existing = await readFile(destPath);
            if (existing !== content) {
              preservedCustomizable.push(destPath.replace(/\\/g, "/"));
              continue;
            }
          }

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

  return { scriptsSymlinked, symlinkResults, preservedCustomizable };
}
