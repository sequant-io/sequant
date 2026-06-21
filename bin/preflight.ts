#!/usr/bin/env node
/**
 * Runtime Node-version preflight (#734).
 *
 * This module is imported FIRST in `bin/cli.ts`, ahead of every third-party
 * import (commander, chalk, the agent SDK) and every command module. ESM
 * evaluates a module's dependencies depth-first in source order before the
 * importer's body runs, so this module's top-level guard executes before any
 * of those heavier modules are evaluated. That closes the import-time crash
 * window: if a dependency tripped a Node-22-only API at module-load time on an
 * old Node, the user would otherwise get an opaque stack trace from the import
 * itself — before the in-body guard at `cli.ts` ever ran.
 *
 * The only modules evaluated before this guard are Node built-ins plus the
 * first-party `version-check.ts` chain (→ `stacks.ts` → `fs.ts`), which import
 * built-ins only and are therefore safe on the old Node this guard rejects.
 *
 * The pure comparison logic lives in `src/lib/version-check.ts` (AC-6); this
 * file is just the early entry point that reads the floor and invokes it.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { assertNodeVersion } from "../src/lib/version-check.js";

// Derive the engines floor from package.json (single source of truth, AC-3),
// using the same walk-up read as getVersion() in cli.ts. Built-in globals only,
// so this runs — rather than crashes — on the old Node it is meant to reject.
function readEngineFloor(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = resolve(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if (pkg.name === "sequant") {
        return pkg.engines?.node ?? null;
      }
    } catch {
      // Not found at this level, keep walking up.
    }
    dir = dirname(dir);
  }
  return null; // Fallback — assertNodeVersion treats a null floor as "skip".
}

assertNodeVersion(readEngineFloor());
