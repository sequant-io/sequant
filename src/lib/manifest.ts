/**
 * Manifest management for tracking installed version
 */

import { readFile, writeFile, fileExists } from "./fs.js";
import { compareVersions } from "./version-check.js";
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
// Read lazily and memoize: a module-level `fs` read makes importing this module
// (or anything that transitively imports it) throw under a stubbed `fs`, and ESM
// import order has bitten this package before (#734).
let cachedPackageVersion: string | undefined;

export function getPackageVersion(): string {
  return (cachedPackageVersion ??= JSON.parse(findPackageJson())
    .version as string);
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
    version: getPackageVersion(),
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

  // Only update version if package version is >= manifest version
  // This prevents older cached CLI versions from downgrading the manifest
  const packageVersion = getPackageVersion();
  if (compareVersions(packageVersion, manifest.version) >= 0) {
    manifest.version = packageVersion;
  }
  manifest.updatedAt = new Date().toISOString();

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}
