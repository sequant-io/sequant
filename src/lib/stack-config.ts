/**
 * Stack configuration persistence
 *
 * Manages user's stack configuration in .sequant/stack.json
 */

import { fileExists, readFile, writeFile, ensureDir } from "./fs.js";
import { dirname } from "path";

/**
 * Stack entry with optional path for subdirectory stacks
 */
export interface StackEntry {
  name: string;
  path?: string;
}

/**
 * Persisted stack configuration
 */
export interface StackConfigFile {
  /** Primary stack (determines dev URL and main commands) */
  primary: StackEntry;
  /** Additional stacks to include in constitution notes */
  additional?: StackEntry[];
  /** When this configuration was last updated */
  lastUpdated?: string;
}

const STACK_CONFIG_PATH = ".sequant/stack.json";

/**
 * Load stack configuration from .sequant/stack.json
 *
 * @returns Stack configuration or null if not found
 */
export async function loadStackConfig(): Promise<StackConfigFile | null> {
  try {
    if (!(await fileExists(STACK_CONFIG_PATH))) {
      return null;
    }

    const content = await readFile(STACK_CONFIG_PATH);
    const config = JSON.parse(content) as StackConfigFile;

    // Validate required fields
    if (!config.primary || !config.primary.name) {
      return null;
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Save stack configuration to .sequant/stack.json
 *
 * @param config - Stack configuration to save
 */
export async function saveStackConfig(config: StackConfigFile): Promise<void> {
  const configWithTimestamp: StackConfigFile = {
    ...config,
    lastUpdated: new Date().toISOString(),
  };

  await ensureDir(dirname(STACK_CONFIG_PATH));
  await writeFile(
    STACK_CONFIG_PATH,
    JSON.stringify(configWithTimestamp, null, 2) + "\n",
  );
}

/**
 * Check if stack configuration exists
 */
export async function hasStackConfig(): Promise<boolean> {
  return fileExists(STACK_CONFIG_PATH);
}

/**
 * Get the primary stack name from configuration
 *
 * @returns Primary stack name or null if not configured
 */
export async function getPrimaryStack(): Promise<string | null> {
  const config = await loadStackConfig();
  return config?.primary?.name ?? null;
}

/**
 * Get all configured stacks (primary + additional)
 *
 * @returns Array of all stack names
 */
export async function getAllConfiguredStacks(): Promise<string[]> {
  const config = await loadStackConfig();
  if (!config) return [];

  const stacks = [config.primary.name];
  if (config.additional) {
    for (const entry of config.additional) {
      if (!stacks.includes(entry.name)) {
        stacks.push(entry.name);
      }
    }
  }
  return stacks;
}
