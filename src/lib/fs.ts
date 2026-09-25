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
import { lstatSync, unlinkSync, writeFileSync as fsWriteFileSync } from "fs";
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

/**
 * Write `content` to `path`, replacing an existing symlink rather than
 * following it (#1122).
 *
 * `fs.writeFile` follows a symlink: the link survives and its *target* is
 * overwritten. At a destination sequant owns that is silent data loss — the
 * target is an npx cache, a sibling checkout or a file outside the project
 * entirely. #1053 fixed this for one writer (`copyDir`); the rule lives here
 * so a new call site cannot reintroduce the class.
 *
 * A regular file is still overwritten in place, so nothing else changes for
 * the 30+ call sites that never see a link.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  if (await isSymlink(path)) {
    await removeFileOrSymlink(path);
  }
  await fsWriteFile(path, content, "utf-8");
}

/**
 * Sync twin of `writeFile` for the sync writers in `mcp-config.ts` (#1160).
 * Same rule: an existing symlink is replaced, never written through. It does
 * not create the parent directory; callers own that.
 */
export function writeFileSync(path: string, content: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    // missing path: nothing to replace
  }
  if (isLink) {
    unlinkSync(path);
  }
  fsWriteFileSync(path, content, "utf-8");
}

/**
 * True when `path` is a directory, without following a symlink to one.
 *
 * `fileExists` uses `access`, which answers true for a directory too, so every
 * guard written on it falls through into a `readFile`/`writeFile` that throws a
 * raw `EISDIR`. Writers use this to skip a colliding destination with a named
 * message instead (#1122).
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The one message every writer prints when a directory sits where a template
 * file goes (#1122). Single source so the string cannot drift between `init`,
 * `sync` and `update`.
 */
export function directoryCollisionMessage(path: string): string {
  return `${path.replace(/\\/g, "/")} is a directory; move it aside`;
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
