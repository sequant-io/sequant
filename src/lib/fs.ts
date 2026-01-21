/**
 * File system utilities
 */

import {
  access,
  constants,
  mkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  stat,
  lstat,
  symlink,
  unlink,
  readlink,
} from "fs/promises";
import { dirname } from "path";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

export async function readFile(path: string): Promise<string> {
  return fsReadFile(path, "utf-8");
}

export async function writeFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await fsWriteFile(path, content, "utf-8");
}

export async function getFileStats(path: string) {
  return stat(path);
}

/**
 * Check if a path is a symbolic link
 */
export async function isSymlink(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Get the target of a symbolic link
 */
export async function getSymlinkTarget(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch {
    return null;
  }
}

/**
 * Remove a file or symbolic link safely
 */
export async function removeFileOrSymlink(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a symbolic link with cross-platform handling
 * @param target The path the symlink should point to
 * @param path The path where the symlink will be created
 * @returns true if symlink was created, false if fallback to copy is needed
 */
export async function createSymlink(
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // On Windows, symlinks may require admin privileges
    // EPERM: Operation not permitted (Windows without privileges)
    // Return false to signal that caller should fall back to copy
    if (err.code === "EPERM" || err.code === "EACCES") {
      return false;
    }
    throw error;
  }
}
