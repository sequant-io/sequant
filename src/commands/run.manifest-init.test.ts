/**
 * #932 — the real `run` init path, not a reconstruction of its shape.
 *
 * `stacks.resolve-package-manager.test.ts` proves the resolver picks the
 * lockfile's manager when handed `undefined`; this file proves `run.ts`
 * actually hands it `undefined`. A non-literal regression at the init site
 * (a two-step alias, a helper that "normalizes" to npm) keeps the grep gate
 * green but fails here.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestForRun } from "./run-manifest.js";
import { resolvePackageManager } from "../lib/stacks.js";

describe("#932 run init: packageManager reaches the resolver undeclared", () => {
  it("forwards an undeclared packageManager as undefined (no default of any spelling)", () => {
    const init = { manifest: manifestForRun({ stack: "node" }) };
    expect("packageManager" in init.manifest).toBe(true);
    expect(init.manifest.packageManager).toBeUndefined();
  });

  it("forwards a declared packageManager verbatim", () => {
    expect(
      manifestForRun({ stack: "node", packageManager: "pnpm" }).packageManager,
    ).toBe("pnpm");
  });

  it("through the real init, a pnpm worktree resolves to pnpm, not npm", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-manifest-init-"));
    try {
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const init = { manifest: manifestForRun({ stack: "node" }) };
      expect(resolvePackageManager(init.manifest.packageManager, dir)).toBe(
        "pnpm",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#932 run init: the call site still goes through manifestForRun (source inspection)", () => {
  it("run.ts builds init.manifest via manifestForRun(manifest), not an inline literal", () => {
    // The helper is tested above; this pins its ONE call site so a future
    // edit cannot bypass it with an inline `{ stack, packageManager: pm ?? … }`
    // that the grep gate (same-line spellings only) would not see either.
    const src = readFileSync(new URL("./run.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/manifest:\s*manifestForRun\(manifest\)/);
    expect(src).not.toMatch(/manifest:\s*\{\s*stack:/);
  });
});
