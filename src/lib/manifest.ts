/**
 * Manifest management for tracking installed version
 */

import { readFile, writeFile, fileExists } from "./fs.js";
import type { PackageManager } from "./stacks.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";

const MANIFEST_PATH = ".sequant-manifest.json";

// Get version from package.json dynamically
// Works from both source (src/lib/) and compiled (dist/src/lib/) locations
function findPackageJson(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const candidate = resolve(dir, "package.json");
    try {
      const content = readFileSync(candidate, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.name === "sequant") {
        return content;
      }
    } catch {
      // Not found, continue searching
    }
    dir = dirname(dir);
  }
  throw new Error("Could not find sequant package.json");
}
const pkg = JSON.parse(findPackageJson());
const PACKAGE_VERSION = pkg.version as string;

export function getPackageVersion(): string {
  return PACKAGE_VERSION;
}

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
