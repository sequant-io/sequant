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
