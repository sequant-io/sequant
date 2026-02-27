/**
 * Codebase conventions detector
 *
 * Deterministic detection of observable codebase patterns.
 * No AI/ML — just file scanning and pattern matching.
 */

import { readdir, stat } from "fs/promises";
import { join, extname, basename } from "path";
import { fileExists, readFile, writeFile, ensureDir } from "./fs.js";

/** Path to conventions file */
export const CONVENTIONS_PATH = ".sequant/conventions.json";

/**
 * A single detected convention
 */
export interface Convention {
  /** Machine-readable key */
  key: string;
  /** Human-readable label */
  label: string;
  /** Detected value */
  value: string;
  /** How it was detected */
  source: "detected" | "manual";
  /** What evidence triggered detection */
  evidence?: string;
}

/**
 * Full conventions file schema
 */
export interface ConventionsFile {
  /** Auto-detected conventions */
  detected: Record<string, string>;
  /** User-provided overrides */
  manual: Record<string, string>;
  /** When detection was last run */
  detectedAt: string;
}

/** Directories to skip during scanning */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "__pycache__",
  "target",
  ".claude",
  ".sequant",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
]);

/**
 * Collect source files up to a limit, skipping irrelevant directories
 */
async function collectFiles(
  dir: string,
  extensions: Set<string>,
  maxFiles: number,
  depth = 0,
): Promise<string[]> {
  if (depth > 5) return [];
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const sub = await collectFiles(
        join(dir, entry.name),
        extensions,
        maxFiles - results.length,
        depth + 1,
      );
      results.push(...sub);
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      results.push(join(dir, entry.name));
    }
  }

  return results;
}

/**
 * Count occurrences of a pattern in file contents
 */
async function countPattern(
  files: string[],
  pattern: RegExp,
  maxFiles = 50,
): Promise<number> {
  let count = 0;
  for (const file of files.slice(0, maxFiles)) {
    try {
      const content = await readFile(file);
      const matches = content.match(pattern);
      if (matches) count += matches.length;
    } catch {
      // Skip unreadable files
    }
  }
  return count;
}

/**
 * Detect test file naming convention
 */
async function detectTestPattern(root: string): Promise<Convention | null> {
  const testFiles = await collectFiles(
    root,
    new Set([".ts", ".tsx", ".js", ".jsx"]),
    500,
  );

  const dotTest = testFiles.filter((f) => /\.test\.[jt]sx?$/.test(f));
  const dotSpec = testFiles.filter((f) => /\.spec\.[jt]sx?$/.test(f));
  const underscoreTests = testFiles.filter((f) => f.includes("__tests__/"));

  if (
    dotTest.length === 0 &&
    dotSpec.length === 0 &&
    underscoreTests.length === 0
  ) {
    return null;
  }

  let value: string;
  let evidence: string;

  if (
    dotTest.length >= dotSpec.length &&
    dotTest.length >= underscoreTests.length
  ) {
    value = "*.test.ts";
    evidence = `${dotTest.length} .test.* files found`;
  } else if (dotSpec.length >= underscoreTests.length) {
    value = "*.spec.ts";
    evidence = `${dotSpec.length} .spec.* files found`;
  } else {
    value = "__tests__/";
    evidence = `${underscoreTests.length} files in __tests__/ directories`;
  }

  return {
    key: "testFilePattern",
    label: "Test file pattern",
    value,
    source: "detected",
    evidence,
  };
}

/**
 * Detect export style preference (named vs default)
 */
async function detectExportStyle(root: string): Promise<Convention | null> {
  const srcDir = join(root, "src");
  const searchDir = (await fileExists(srcDir)) ? srcDir : root;
  const files = await collectFiles(
    searchDir,
    new Set([".ts", ".tsx", ".js", ".jsx"]),
    100,
  );

  if (files.length === 0) return null;

  const defaultExports = await countPattern(files, /export\s+default\b/g, 50);
  const namedExports = await countPattern(
    files,
    /export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\b/g,
    50,
  );

  if (defaultExports === 0 && namedExports === 0) return null;

  const total = defaultExports + namedExports;
  const namedRatio = namedExports / total;

  let value: string;
  if (namedRatio > 0.7) {
    value = "named";
  } else if (namedRatio < 0.3) {
    value = "default";
  } else {
    value = "mixed";
  }

  return {
    key: "exportStyle",
    label: "Export style",
    value,
    source: "detected",
    evidence: `${namedExports} named, ${defaultExports} default exports`,
  };
}

/**
 * Detect async pattern preference
 */
async function detectAsyncPattern(root: string): Promise<Convention | null> {
  const srcDir = join(root, "src");
  const searchDir = (await fileExists(srcDir)) ? srcDir : root;
  const files = await collectFiles(
    searchDir,
    new Set([".ts", ".tsx", ".js", ".jsx"]),
    100,
  );

  if (files.length === 0) return null;

  const awaitCount = await countPattern(files, /\bawait\b/g, 50);
  const thenCount = await countPattern(files, /\.then\s*\(/g, 50);

  if (awaitCount === 0 && thenCount === 0) return null;

  const total = awaitCount + thenCount;
  const awaitRatio = awaitCount / total;

  let value: string;
  if (awaitRatio > 0.7) {
    value = "async/await";
  } else if (awaitRatio < 0.3) {
    value = "promise-chains";
  } else {
    value = "mixed";
  }

  return {
    key: "asyncPattern",
    label: "Async pattern",
    value,
    source: "detected",
    evidence: `${awaitCount} await, ${thenCount} .then() usages`,
  };
}

/**
 * Detect TypeScript strictness
 */
async function detectTypeScriptConfig(
  root: string,
): Promise<Convention | null> {
  const tsConfigPath = join(root, "tsconfig.json");
  if (!(await fileExists(tsConfigPath))) return null;

  try {
    const content = await readFile(tsConfigPath);
    // Strip comments (single-line) for JSON parsing
    const stripped = content.replace(/\/\/.*$/gm, "");
    const config = JSON.parse(stripped);
    const strict = config?.compilerOptions?.strict;

    return {
      key: "typescriptStrict",
      label: "TypeScript strict mode",
      value: strict ? "enabled" : "disabled",
      source: "detected",
      evidence: `tsconfig.json compilerOptions.strict = ${strict}`,
    };
  } catch {
    return null;
  }
}

/**
 * Detect source directory structure
 */
async function detectSourceStructure(root: string): Promise<Convention | null> {
  const candidates = [
    { path: "src", label: "src/" },
    { path: "lib", label: "lib/" },
    { path: "app", label: "app/" },
    { path: "pages", label: "pages/" },
  ];

  const found: string[] = [];
  for (const c of candidates) {
    const fullPath = join(root, c.path);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) found.push(c.label);
    } catch {
      // doesn't exist
    }
  }

  if (found.length === 0) return null;

  return {
    key: "sourceStructure",
    label: "Source directory structure",
    value: found.join(", "),
    source: "detected",
    evidence: `Found directories: ${found.join(", ")}`,
  };
}

/**
 * Detect package manager from lockfiles
 */
async function detectPackageManagerConvention(
  root: string,
): Promise<Convention | null> {
  const lockfiles: Array<{ file: string; manager: string }> = [
    { file: "bun.lockb", manager: "bun" },
    { file: "bun.lock", manager: "bun" },
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "yarn.lock", manager: "yarn" },
    { file: "package-lock.json", manager: "npm" },
  ];

  for (const { file, manager } of lockfiles) {
    if (await fileExists(join(root, file))) {
      return {
        key: "packageManager",
        label: "Package manager",
        value: manager,
        source: "detected",
        evidence: `Found ${file}`,
      };
    }
  }

  return null;
}

/**
 * Detect indentation style from source files
 */
async function detectIndentation(root: string): Promise<Convention | null> {
  const srcDir = join(root, "src");
  const searchDir = (await fileExists(srcDir)) ? srcDir : root;
  const files = await collectFiles(
    searchDir,
    new Set([".ts", ".tsx", ".js", ".jsx"]),
    30,
  );

  if (files.length === 0) return null;

  let twoSpace = 0;
  let fourSpace = 0;
  let tabs = 0;

  for (const file of files.slice(0, 20)) {
    try {
      const content = await readFile(file);
      const lines = content.split("\n").slice(0, 50);
      for (const line of lines) {
        if (/^\t/.test(line)) tabs++;
        else if (/^  [^ ]/.test(line)) twoSpace++;
        else if (/^    [^ ]/.test(line)) fourSpace++;
      }
    } catch {
      // skip
    }
  }

  const total = twoSpace + fourSpace + tabs;
  if (total === 0) return null;

  let value: string;
  if (tabs > twoSpace && tabs > fourSpace) {
    value = "tabs";
  } else if (twoSpace >= fourSpace) {
    value = "2 spaces";
  } else {
    value = "4 spaces";
  }

  return {
    key: "indentation",
    label: "Indentation",
    value,
    source: "detected",
    evidence: `${twoSpace} two-space, ${fourSpace} four-space, ${tabs} tab-indented lines`,
  };
}

/**
 * Detect semicolon usage
 */
async function detectSemicolons(root: string): Promise<Convention | null> {
  const srcDir = join(root, "src");
  const searchDir = (await fileExists(srcDir)) ? srcDir : root;
  const files = await collectFiles(
    searchDir,
    new Set([".ts", ".tsx", ".js", ".jsx"]),
    30,
  );

  if (files.length === 0) return null;

  let withSemicolon = 0;
  let withoutSemicolon = 0;

  for (const file of files.slice(0, 20)) {
    try {
      const content = await readFile(file);
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines, comments, opening/closing brackets
        if (
          !trimmed ||
          trimmed.startsWith("//") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("*") ||
          /^[{}()\[\]]$/.test(trimmed) ||
          /^import\s/.test(trimmed) ||
          /^export\s/.test(trimmed)
        )
          continue;

        if (trimmed.endsWith(";")) withSemicolon++;
        else if (
          trimmed.endsWith(")") ||
          trimmed.endsWith('"') ||
          trimmed.endsWith("'") ||
          trimmed.endsWith("`") ||
          /\w$/.test(trimmed)
        )
          withoutSemicolon++;
      }
    } catch {
      // skip
    }
  }

  const total = withSemicolon + withoutSemicolon;
  if (total === 0) return null;

  const semiRatio = withSemicolon / total;
  const value =
    semiRatio > 0.6 ? "required" : semiRatio < 0.3 ? "omitted" : "mixed";

  return {
    key: "semicolons",
    label: "Semicolons",
    value,
    source: "detected",
    evidence: `${withSemicolon} with, ${withoutSemicolon} without semicolons`,
  };
}

/**
 * Detect component directory structure (for frontend projects)
 */
async function detectComponentStructure(
  root: string,
): Promise<Convention | null> {
  const candidates = [
    "src/components",
    "components",
    "src/app",
    "app",
    "src/pages",
    "pages",
  ];

  for (const candidate of candidates) {
    const dirPath = join(root, candidate);
    try {
      const s = await stat(dirPath);
      if (s.isDirectory()) {
        return {
          key: "componentDir",
          label: "Component directory",
          value: candidate + "/",
          source: "detected",
          evidence: `Directory exists: ${candidate}/`,
        };
      }
    } catch {
      // doesn't exist
    }
  }

  return null;
}

/**
 * Run all convention detectors
 */
export async function detectConventions(
  projectRoot: string,
): Promise<Convention[]> {
  const detectors = [
    detectTestPattern,
    detectExportStyle,
    detectAsyncPattern,
    detectTypeScriptConfig,
    detectSourceStructure,
    detectPackageManagerConvention,
    detectIndentation,
    detectSemicolons,
    detectComponentStructure,
  ];

  const results: Convention[] = [];
  for (const detector of detectors) {
    try {
      const result = await detector(projectRoot);
      if (result) results.push(result);
    } catch {
      // Skip failed detectors
    }
  }

  return results;
}

/**
 * Load existing conventions file
 */
export async function loadConventions(): Promise<ConventionsFile | null> {
  if (!(await fileExists(CONVENTIONS_PATH))) return null;

  try {
    const content = await readFile(CONVENTIONS_PATH);
    return JSON.parse(content) as ConventionsFile;
  } catch {
    return null;
  }
}

/**
 * Save conventions, preserving manual entries
 */
export async function saveConventions(
  detected: Convention[],
): Promise<ConventionsFile> {
  // Load existing to preserve manual entries
  const existing = await loadConventions();
  const manual = existing?.manual ?? {};

  const detectedMap: Record<string, string> = {};
  for (const c of detected) {
    detectedMap[c.key] = c.value;
  }

  const conventions: ConventionsFile = {
    detected: detectedMap,
    manual,
    detectedAt: new Date().toISOString(),
  };

  await ensureDir(".sequant");
  await writeFile(CONVENTIONS_PATH, JSON.stringify(conventions, null, 2));
  return conventions;
}

/**
 * Get merged conventions (manual overrides detected)
 */
export function getMergedConventions(
  file: ConventionsFile,
): Record<string, string> {
  return { ...file.detected, ...file.manual };
}

/**
 * Format conventions for display
 */
export function formatConventions(file: ConventionsFile): string {
  const lines: string[] = [];

  lines.push("Detected conventions:");
  const detected = Object.entries(file.detected);
  if (detected.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [key, value] of detected) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  const manual = Object.entries(file.manual);
  if (manual.length > 0) {
    lines.push("");
    lines.push("Manual overrides:");
    for (const [key, value] of manual) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  lines.push("");
  lines.push(`Last detected: ${file.detectedAt}`);

  return lines.join("\n");
}

/**
 * Detect and save conventions in one call
 */
export async function detectAndSaveConventions(
  projectRoot: string,
): Promise<ConventionsFile> {
  const conventions = await detectConventions(projectRoot);
  return saveConventions(conventions);
}

/**
 * Format conventions as context for AI skills
 */
export function formatConventionsForContext(file: ConventionsFile): string {
  const merged = getMergedConventions(file);
  const entries = Object.entries(merged);

  if (entries.length === 0) return "";

  const lines = ["## Codebase Conventions", ""];
  for (const [key, value] of entries) {
    lines.push(`- **${key}**: ${value}`);
  }

  return lines.join("\n");
}
