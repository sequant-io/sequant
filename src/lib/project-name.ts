/**
 * Project name detection utility
 *
 * Detects project name from various sources in priority order:
 * 1. package.json → name field
 * 2. Cargo.toml → [package] name
 * 3. pyproject.toml → [project] name OR [tool.poetry] name
 * 4. go.mod → module path (last segment)
 * 5. git remote → extract repo name from origin URL
 * 6. Directory name → basename(cwd) (fallback)
 */

import { basename } from "path";
import { spawnSync } from "child_process";
import { fileExists, readFile } from "./fs.js";

/**
 * Result of project name detection
 */
export interface ProjectNameResult {
  /** The detected project name */
  name: string;
  /** The source from which the name was detected */
  source:
    | "package.json"
    | "Cargo.toml"
    | "pyproject.toml"
    | "go.mod"
    | "git-remote"
    | "directory";
}

/**
 * Extract project name from package.json
 */
async function fromPackageJson(): Promise<string | null> {
  if (!(await fileExists("package.json"))) {
    return null;
  }

  try {
    const content = await readFile("package.json");
    const pkg = JSON.parse(content);
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      return pkg.name.trim();
    }
  } catch {
    // Parse error or missing name field
  }

  return null;
}

/**
 * Extract project name from Cargo.toml (Rust)
 */
async function fromCargoToml(): Promise<string | null> {
  if (!(await fileExists("Cargo.toml"))) {
    return null;
  }

  try {
    const content = await readFile("Cargo.toml");
    // Look for: name = "project-name" in [package] section
    // Simple regex approach - handles most common formats
    const match = content.match(
      /\[package\][\s\S]*?name\s*=\s*["']([^"']+)["']/,
    );
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch {
    // Parse error
  }

  return null;
}

/**
 * Extract project name from pyproject.toml (Python)
 */
async function fromPyprojectToml(): Promise<string | null> {
  if (!(await fileExists("pyproject.toml"))) {
    return null;
  }

  try {
    const content = await readFile("pyproject.toml");

    // Try [project] name first (PEP 621 standard)
    const projectMatch = content.match(
      /\[project\][\s\S]*?name\s*=\s*["']([^"']+)["']/,
    );
    if (projectMatch && projectMatch[1]) {
      return projectMatch[1].trim();
    }

    // Fallback to [tool.poetry] name
    const poetryMatch = content.match(
      /\[tool\.poetry\][\s\S]*?name\s*=\s*["']([^"']+)["']/,
    );
    if (poetryMatch && poetryMatch[1]) {
      return poetryMatch[1].trim();
    }
  } catch {
    // Parse error
  }

  return null;
}

/**
 * Extract project name from go.mod (Go)
 */
async function fromGoMod(): Promise<string | null> {
  if (!(await fileExists("go.mod"))) {
    return null;
  }

  try {
    const content = await readFile("go.mod");
    // Look for: module github.com/org/project-name
    const match = content.match(/^module\s+(.+)$/m);
    if (match && match[1]) {
      const modulePath = match[1].trim();
      // Extract the last segment of the module path
      const segments = modulePath.split("/");
      const lastSegment = segments[segments.length - 1];
      if (lastSegment) {
        return lastSegment;
      }
    }
  } catch {
    // Parse error
  }

  return null;
}

/**
 * Extract project name from git remote origin URL
 */
function fromGitRemote(): string | null {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5000,
    });

    if (result.status !== 0 || !result.stdout) {
      return null;
    }

    const url = result.stdout.trim();

    // Handle SSH format: git@github.com:org/repo.git
    const sshMatch = url.match(/[:/]([^/]+)\.git$/);
    if (sshMatch && sshMatch[1]) {
      return sshMatch[1];
    }

    // Handle HTTPS format: https://github.com/org/repo.git or https://github.com/org/repo
    const httpsMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch && httpsMatch[1]) {
      return httpsMatch[1];
    }
  } catch {
    // Git not available or not a git repo
  }

  return null;
}

/**
 * Get project name from directory name (fallback)
 */
function fromDirectory(): string {
  return basename(process.cwd()) || "project";
}

/**
 * Detect project name from available sources
 *
 * Tries sources in priority order:
 * 1. package.json
 * 2. Cargo.toml
 * 3. pyproject.toml
 * 4. go.mod
 * 5. git remote
 * 6. directory name
 *
 * @returns The detected project name and its source
 */
export async function detectProjectName(): Promise<ProjectNameResult> {
  // 1. Try package.json
  const fromPkg = await fromPackageJson();
  if (fromPkg) {
    return { name: fromPkg, source: "package.json" };
  }

  // 2. Try Cargo.toml
  const fromCargo = await fromCargoToml();
  if (fromCargo) {
    return { name: fromCargo, source: "Cargo.toml" };
  }

  // 3. Try pyproject.toml
  const fromPyproject = await fromPyprojectToml();
  if (fromPyproject) {
    return { name: fromPyproject, source: "pyproject.toml" };
  }

  // 4. Try go.mod
  const fromGo = await fromGoMod();
  if (fromGo) {
    return { name: fromGo, source: "go.mod" };
  }

  // 5. Try git remote
  const fromRemote = fromGitRemote();
  if (fromRemote) {
    return { name: fromRemote, source: "git-remote" };
  }

  // 6. Fallback to directory name
  return { name: fromDirectory(), source: "directory" };
}

/**
 * Detect project name, returning just the name string
 *
 * Convenience function for cases where only the name is needed.
 */
export async function getProjectName(): Promise<string> {
  const result = await detectProjectName();
  return result.name;
}
