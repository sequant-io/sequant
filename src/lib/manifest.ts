/**
 * Manifest management for tracking installed version
 */

import { readFile, writeFile, fileExists } from "./fs.js";
import { compareVersions } from "./version-check.js";
import type { PackageManager } from "./stacks.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { noteSuppressed } from "./workflow/suppressed.js";

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
    } catch (err) {
      // Not found, continue searching
      noteSuppressed("other", err, "manifest:27");
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

/**
 * A template group an install can be scoped to — the `sync --only`
 * vocabulary (#1209). `"skills"` is `.claude/skills/**`.
 */
export type InstallGroup = "skills";

export interface Manifest {
  version: string;
  stack: string;
  packageManager?: PackageManager;
  installedAt: string;
  updatedAt?: string;
  files: Record<string, string>; // path -> hash
  /**
   * The template groups this install holds (#1409). Absent means a full
   * install — every manifest written before #1409, and every full `init`.
   * `init --manifest-only` writes `[]`; `sync --only skills` adds `"skills"`.
   */
  groups?: InstallGroup[];
}

/**
 * What a project installed: every template (`full`), or only the listed
 * groups (`partial`). Drift and its remedy are scoped to this, so a file a
 * partial install never wrote is not reported as drift (#1409).
 */
export type InstallScope =
  { kind: "full" } | { kind: "partial"; groups: InstallGroup[] };

/** The install scope a manifest records. A manifest without `groups` is a full install. */
export function getInstallScope(manifest: Manifest): InstallScope {
  if (!Array.isArray(manifest.groups)) return { kind: "full" };
  return { kind: "partial", groups: [...manifest.groups] };
}

export async function getManifest(): Promise<Manifest | null> {
  try {
    return await readManifestStrict();
  } catch {
    return null;
  }
}

/**
 * Like {@link getManifest}, but only an absent manifest reads as `null`: a
 * manifest that exists yet can't be read or isn't valid JSON throws. For
 * callers that must tell "not installed" apart from "installed but broken"
 * — `sequant://install` (#1195 AC-2).
 */
export async function readManifestStrict(): Promise<Manifest | null> {
  if (!(await fileExists(MANIFEST_PATH))) {
    return null;
  }
  const content = await readFile(MANIFEST_PATH);
  return JSON.parse(content) as Manifest;
}

/**
 * Serialize the manifest as written to disk. Ends with a newline so the file
 * passes Prettier / `insert_final_newline` checks in the user's repo (#1355).
 */
function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * @param options.groups - Record a partial install scope. Omit for a full
 *   install; `init --manifest-only` passes `[]` (nothing installed yet).
 */
export async function createManifest(
  stack: string,
  packageManager?: PackageManager,
  options: { groups?: InstallGroup[] } = {},
): Promise<void> {
  const manifest: Manifest = {
    version: getPackageVersion(),
    stack,
    ...(packageManager && { packageManager }),
    installedAt: new Date().toISOString(),
    files: {},
    ...(options.groups && { groups: [...options.groups] }),
  };

  await writeFile(MANIFEST_PATH, serializeManifest(manifest));
}

/**
 * @param options.addGroup - A group the caller just installed. Added to a
 *   partial scope; a full install (no `groups`) stays full, so a later
 *   `sync --only` never narrows it and hides drift on files it has (#1409).
 * @param options.full - The caller installed every group: drop `groups` so
 *   the manifest records a full install.
 */
export async function updateManifest(
  options: { addGroup?: InstallGroup; full?: boolean } = {},
): Promise<void> {
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
  if (options.full) {
    delete manifest.groups;
  } else if (
    options.addGroup &&
    Array.isArray(manifest.groups) &&
    !manifest.groups.includes(options.addGroup)
  ) {
    manifest.groups.push(options.addGroup);
  }

  await writeFile(MANIFEST_PATH, serializeManifest(manifest));
}
