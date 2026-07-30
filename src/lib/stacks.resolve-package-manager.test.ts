/**
 * Unit tests for `resolvePackageManager` (#870).
 *
 * The resolver exists because the worktree manifest's `packageManager` is a
 * snapshot taken at `sequant init` and is absent on manifest-less or pre-init
 * trees. Call sites used to spell the fallback `(declared as keyof typeof
 * PM_CONFIG) || "npm"`, which assumed npm in exactly that case — disagreeing
 * with the lockfile-detecting shell path (`new-feature.sh`, #847) on
 * pnpm/yarn/bun projects.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolvePackageManager } from "./stacks.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sequant-pm-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolvePackageManager", () => {
  it("prefers a declared manager that PM_CONFIG knows", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    // The manifest is the more specific signal — detection is only a fallback.
    expect(resolvePackageManager("yarn", dir)).toBe("yarn");
  });

  it("keeps a declared Python manager, which the JS-only detector cannot return", () => {
    // pip/poetry/uv are PM_CONFIG keys but absent from LOCKFILE_PRIORITY, so
    // routing them to detection would silently rewrite them to npm.
    expect(resolvePackageManager("poetry", dir)).toBe("poetry");
  });

  it("detects from the lockfile when no manager is declared", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(resolvePackageManager(undefined, dir)).toBe("pnpm");
  });

  it("detects from the lockfile when the declared value is empty", () => {
    writeFileSync(join(dir, "bun.lockb"), "");

    expect(resolvePackageManager("", dir)).toBe("bun");
  });

  it("detects rather than crashing when the declared value is not a known manager", () => {
    // The old `as keyof typeof PM_CONFIG` cast made this index PM_CONFIG to
    // undefined, so the next property access threw a TypeError.
    writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");

    expect(resolvePackageManager("npm@10", dir)).toBe("yarn");
  });

  it("falls back to npm when nothing is declared and no lockfile exists", () => {
    expect(resolvePackageManager(undefined, dir)).toBe("npm");
  });

  it("resolves against the given root, not the process cwd", () => {
    // Provisioning passes the *worktree* path; reading the cwd instead would
    // report the manager of whatever repo the CLI happens to run from.
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(resolvePackageManager(undefined, dir)).toBe("pnpm");
    expect(resolvePackageManager(undefined, process.cwd())).toBe("npm");
  });
});
