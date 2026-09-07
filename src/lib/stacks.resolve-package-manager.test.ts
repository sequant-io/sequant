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

import { resolvePackageManager, PM_CONFIG } from "./stacks.js";

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

  it.each([
    "toString",
    "constructor",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])("routes the inherited Object.prototype key %j to detection", (key) => {
    // Guards the `in` → `hasOwnProperty` choice. `in` walks the prototype
    // chain, so each of these would pass the membership test and be returned
    // as a package manager; `PM_CONFIG[key]` is then an inherited function
    // (or Object.prototype) whose `ciInstall` is undefined, and the caller
    // crashes on `.split(" ")` — the very failure this guard prevents.
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(resolvePackageManager(key, dir)).toBe("pnpm");
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

describe("#932: run path resolves through the lockfile, not a literal fallback", () => {
  // `run.ts` used to substitute a literal "npm" default for an undeclared
  // manifest value — a valid PM_CONFIG key that short-circuited
  // `resolvePackageManager`'s lockfile detection before it ever ran. The
  // fixed init lets an absent declared value flow through as `undefined`,
  // matching `update.ts`'s call. These tests build that init shape (no
  // literal fallback) and assert the resolved install command.
  it.each([
    {
      lockfile: "pnpm-lock.yaml",
      contents: "lockfileVersion: '9.0'\n",
      pm: "pnpm" as const,
    },
    {
      lockfile: "yarn.lock",
      contents: "# yarn lockfile v1\n",
      pm: "yarn" as const,
    },
    { lockfile: "bun.lockb", contents: "", pm: "bun" as const },
  ])(
    "932: manifest without packageManager + $lockfile resolves to $pm's ciInstall",
    ({ lockfile, contents, pm }) => {
      writeFileSync(join(dir, lockfile), contents);

      // Mirrors `run.ts`'s init: `manifest.packageManager` (undeclared) flows
      // through untouched, no `?? "npm"`.
      const init = { manifest: { stack: "node", packageManager: undefined } };

      const resolved = resolvePackageManager(init.manifest.packageManager, dir);

      expect(resolved).toBe(pm);
      expect(PM_CONFIG[resolved].ciInstall).toBe(PM_CONFIG[pm].ciInstall);
    },
  );
});
