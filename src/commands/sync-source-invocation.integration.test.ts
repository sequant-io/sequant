/**
 * Regression tests for #822 — `sequant sync` invoked from a **source** tree.
 *
 * `getTemplatesDir()` used to assume the compiled layout (`dist/src/lib`), so a
 * `tsx bin/cli.ts sync` resolved `templates/` one level above the repo root.
 * Every `copyDir` then hit its ENOENT skip, the version marker was written
 * anyway, and sync printed `✔ Synced to vX` having installed nothing but
 * `.claude/skills/.sequant-version`.
 *
 * These must spawn the real CLI under `tsx`: the failure lived entirely in how
 * `import.meta.url` resolved at runtime, which an in-process test cannot
 * reproduce. `SEQUANT_TEMPLATES_DIR` is deliberately cleared for the happy path
 * — with the override set, the test would pass even against the old code.
 *
 * That `tsx` requirement is why this file keeps an explicit `testTimeout`
 * instead of following #842's sibling `phase-registry.integration.test.ts` onto
 * the prebuilt `dist/bin/cli.js`. Compiling under `tsx` *is* the thing under
 * test here, so the compile cannot be lifted out of the hot path — pointing
 * these at `dist` would delete #822's coverage entirely.
 *
 * Sizing (#842): a `tsx` spawn measured 4.2 s idle on a cold cache and
 * 7.5-17.8 s under full-suite load, against vitest's 5 s default. Off that
 * 17.8 s worst case:
 *   - the `spawnSync` child timeout is 60 s (~3.4x headroom), and
 *   - `testTimeout` is 90 s, strictly above it.
 * The ordering is deliberate. Whichever fires first decides the error message,
 * and the child timeout gives the better one: a killed child surfaces as
 * `result.signal === "SIGTERM"` with stdout/stderr captured, where vitest
 * firing first yields only the opaque `Test timed out in 5000ms` that produced
 * #842 in the first place. `state-update-cli.test.ts` pairs 30 s/60 s the same
 * way and has never flaked.
 */

import { spawnSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "fs/promises";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { fileExists } from "../lib/fs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");
const cliSource = resolve(projectRoot, "bin/cli.ts");

/** Core skills a real sync must install — see the #813 pre-flight. */
const CORE_SKILLS = ["spec", "exec", "qa"];

/** Child-process kill. Must stay strictly below `TEST_TIMEOUT_MS` — see header. */
const CHILD_TIMEOUT_MS = 60_000;
/** Vitest ceiling. Strictly above `CHILD_TIMEOUT_MS` so the child kill wins. */
const TEST_TIMEOUT_MS = 90_000;

describe(
  "sync invoked from source under tsx (#822)",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = await mkdtemp(join(tmpdir(), "sequant-sync-source-"));
      // A bare but *initialized* project: without a manifest, sync exits early
      // with "not initialized" and the test would pass for the wrong reason.
      await writeFile(
        join(projectDir, ".sequant-manifest.json"),
        JSON.stringify({
          version: "0.0.0-test",
          stack: "generic",
          installedAt: new Date(0).toISOString(),
          files: {},
        }),
      );
      await writeFile(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "bare-project", version: "1.0.0" }),
      );
      // Empty skills dir: only `.sequant-version` should ever have landed here
      // under the bug.
      await mkdir(join(projectDir, ".claude", "skills"), { recursive: true });
    });

    afterEach(async () => {
      await rm(projectDir, { recursive: true, force: true });
    });

    function runCli(args: string[], extraEnv: Record<string, string> = {}) {
      const env = { ...process.env, NO_COLOR: "1", ...extraEnv };
      // Must not be inherited from the developer's shell — it would mask the
      // resolution being tested.
      delete env.SEQUANT_TEMPLATES_DIR;
      if (extraEnv.SEQUANT_TEMPLATES_DIR !== undefined) {
        env.SEQUANT_TEMPLATES_DIR = extraEnv.SEQUANT_TEMPLATES_DIR;
      }

      return spawnSync(tsxBin, [cliSource, ...args], {
        cwd: projectDir,
        encoding: "utf-8",
        env,
        timeout: CHILD_TIMEOUT_MS,
      });
    }

    const runSync = (extraEnv: Record<string, string> = {}) =>
      runCli(["sync"], extraEnv);

    it("installs the core skills, not just the version marker (AC-3)", async () => {
      const result = runSync();

      expect(result.status).toBe(0);

      const installed = await readdir(join(projectDir, ".claude", "skills"));
      // The exact bug signature: the marker was the only thing written.
      expect(installed).not.toEqual([".sequant-version"]);

      for (const skill of CORE_SKILLS) {
        expect(
          await fileExists(
            join(projectDir, ".claude", "skills", skill, "SKILL.md"),
          ),
        ).toBe(true);
      }
    });

    it("exits non-zero naming the missing path when the templates root is absent (AC-2)", () => {
      const missing = join(projectDir, "no-such-templates");

      const result = runSync({ SEQUANT_TEMPLATES_DIR: missing });

      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(missing);
      // The original failure mode was a success banner over an empty tree.
      expect(output).not.toContain("✔ Synced");
    });

    // AC-2 names `init` alongside `sync`; without this the init half of the guard
    // is only covered by the unit-level mock, which stubs the guard out entirely.
    it("init also exits non-zero naming the missing path (AC-2)", async () => {
      const missing = join(projectDir, "no-such-templates");

      const result = runCli(["init", "--yes", "--skip-setup"], {
        SEQUANT_TEMPLATES_DIR: missing,
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(missing);
      // The guard sits ahead of every write, so a broken install must not leave
      // a half-provisioned project behind.
      expect(
        await fileExists(join(projectDir, ".claude", "settings.json")),
      ).toBe(false);
    });
  },
);
