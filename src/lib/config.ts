/**
 * Sequant configuration management
 *
 * Stores user-configured values (like DEV_URL) that persist across updates.
 */

import { readFile, writeFile, fileExists, ensureDir } from "./fs.js";
import { dirname } from "path";

const CONFIG_PATH = ".claude/.sequant/config.json";

export interface SequantConfig {
  tokens: Record<string, string>;
  stack: string;
  initialized: string;
}

/**
 * Get the current sequant configuration
 */
export async function getConfig(): Promise<SequantConfig | null> {
  if (!(await fileExists(CONFIG_PATH))) {
    return null;
  }

  try {
    const content = await readFile(CONFIG_PATH);
    return JSON.parse(content) as SequantConfig;
  } catch {
    return null;
  }
}

/**
 * Save the sequant configuration
 */
export async function saveConfig(config: SequantConfig): Promise<void> {
  await ensureDir(dirname(CONFIG_PATH));
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}
