/**
 * The upgrade hint must name the right yarn command for the project's yarn
 * major (#871).
 *
 * `getVersionWarning` prints `Run: <updatePkg> sequant` for a local install.
 * `PM_CONFIG.yarn.updatePkg` is berry's `yarn up`; Yarn 1 calls it
 * `yarn upgrade`. Reading the field straight off `PM_CONFIG` therefore hands
 * one of the two majors a command its yarn does not have — this is a string we
 * are telling a user to run, so it has to be resolved.
 *
 * Deliberately a separate file from `version-check.test.ts`: that file mocks the
 * `fs` module wholesale, which prevents `detectYarnMajor` from reading the
 * fixtures that decide the answer. Here `fs` is real and only `process.cwd` is
 * redirected, which is what both `detectPackageManagerSync()` and the resolver
 * read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVersionWarning } from "./version-check.js";

describe("getVersionWarning — yarn major (#871)", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "version-check-yarn-"));
    // Both detectPackageManagerSync() and resolvePackageManagerConfig read the
    // cwd; redirecting it points them at the fixture.
    vi.spyOn(process, "cwd").mockReturnValue(project);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  /** A yarn project pinned to `major` via Corepack's `packageManager` field. */
  function seedYarn(major: string): void {
    writeFileSync(join(project, "yarn.lock"), "# lock\n");
    writeFileSync(
      join(project, "package.json"),
      `{"name":"fixture","packageManager":"yarn@${major}"}`,
    );
  }

  // `isLocal: true` is passed explicitly so the assertion is about the command
  // string, not about install-location detection.
  it("tells a Yarn 1 user `yarn upgrade`, not berry's `yarn up`", () => {
    seedYarn("1.22.22");

    const warning = getVersionWarning("1.0.0", "1.5.3", true);

    expect(warning).toContain("yarn upgrade sequant");
  });

  it("tells a Yarn 2+ user `yarn up`, not classic's `yarn upgrade`", () => {
    seedYarn("4.1.0");

    const warning = getVersionWarning("1.0.0", "1.5.3", true);

    expect(warning).toContain("yarn up sequant");
    expect(warning).not.toContain("yarn upgrade");
  });
});
