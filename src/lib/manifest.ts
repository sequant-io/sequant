/**
 * Manifest management for tracking installed version
 */

import { readFile, writeFile, fileExists } from "./fs.js";
import type { PackageManager } from "./stacks.js";

const MANIFEST_PATH = ".sequant-manifest.json";
const PACKAGE_VERSION = "0.1.0";

export interface Manifest {
  version: string;
  stack: string;
  packageManager?: PackageManager;
  installedAt: string;
  updatedAt?: string;
  files: Record<string, string>; // path -> hash
}

export async function getManifest(): Promise<Manifest | null> {
  if (!(await fileExists(MANIFEST_PATH))) {
    return null;
  }

  try {
    const content = await readFile(MANIFEST_PATH);
    return JSON.parse(content) as Manifest;
  } catch {
    return null;
  }
}

export async function createManifest(
  stack: string,
  packageManager?: PackageManager,
): Promise<void> {
  const manifest: Manifest = {
    version: PACKAGE_VERSION,
    stack,
    ...(packageManager && { packageManager }),
    installedAt: new Date().toISOString(),
    files: {},
  };

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

export async function updateManifest(): Promise<void> {
  const manifest = await getManifest();
  if (!manifest) {
    return;
  }

  manifest.version = PACKAGE_VERSION;
  manifest.updatedAt = new Date().toISOString();

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}
