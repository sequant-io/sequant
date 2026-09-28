/**
 * Gate test for #1164 AC-1: the MCP test files that exercise `sequant_status`
 * must leave the working checkout's `.sequant/state.json` byte-identical.
 *
 * Before #1164 each of them built `sequant_status` on the default state path
 * (`process.cwd()/.sequant/state.json`), so every run reconciled — and
 * rewrote — the developer's real state file. This test seeds a schema-valid
 * sentinel there, runs the three files in a child vitest with cwd = the
 * checkout, and asserts the bytes are unchanged. An empty-but-valid state is
 * the deterministic trigger: reconcile always rewrites `lastSynced` on it,
 * with no GitHub call involved.
 *
 * The original state file (if any) is restored in `finally`; if there was
 * none, only the sentinel (and a `.sequant/` dir this test created) is removed.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const STATE_DIR = path.join(REPO_ROOT, ".sequant");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const FILES_UNDER_TEST = [
  "src/mcp/server.test.ts",
  "__tests__/integration/mcp-e2e.integration.test.ts",
  "__tests__/integration/mcp-serve-async-refactor.integration.test.ts",
];

// Schema-valid, nothing tracked, deliberately old timestamps: any reconcile
// against this file rewrites it.
const SENTINEL =
  JSON.stringify(
    {
      version: 1,
      lastUpdated: "2000-01-01T00:00:00.000Z",
      lastSynced: "2000-01-01T00:00:00.000Z",
      issues: {},
    },
    null,
    2,
  ) + "\n";

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Child env: no vitest worker vars, no orchestrator vars (#1086). */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST") || key.startsWith("SEQUANT_")) continue;
    env[key] = value;
  }
  return env;
}

describe("#1164 AC-1: MCP tests leave the checkout's state.json untouched", () => {
  it("running the three sequant_status test files keeps .sequant/state.json byte-identical", () => {
    const hadDir = fs.existsSync(STATE_DIR);
    const original = fs.existsSync(STATE_FILE)
      ? fs.readFileSync(STATE_FILE)
      : null;

    // The child reuses the repo's vitest projects but skips globalSetup:
    // it would re-run `npm run build` and rewrite dist/ under the parent
    // suite. None of the three files needs dist/.
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sequant-hermetic-gate-"),
    );
    const configPath = path.join(configDir, "vitest.config.mjs");
    fs.writeFileSync(
      configPath,
      [
        `import base from ${JSON.stringify(path.join(REPO_ROOT, "vitest.config.ts"))};`,
        `export default {`,
        `  ...base,`,
        `  root: ${JSON.stringify(REPO_ROOT)},`,
        `  test: { ...base.test, globalSetup: [] },`,
        `};`,
        ``,
      ].join("\n"),
    );

    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, SENTINEL);
      const before = sha256(fs.readFileSync(STATE_FILE));

      const result = spawnSync(
        "npx",
        ["vitest", "run", "--config", configPath, ...FILES_UNDER_TEST],
        {
          cwd: REPO_ROOT,
          env: childEnv(),
          encoding: "utf-8",
          timeout: 280_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

      // Hermeticity first, so a write is reported as such even if the child
      // suite also failed for an unrelated reason.
      expect(fs.existsSync(STATE_FILE), output).toBe(true);
      const afterBytes = fs.readFileSync(STATE_FILE, "utf-8");
      expect(sha256(afterBytes), `state.json changed:\n${afterBytes}`).toBe(
        before,
      );

      // Then the child must actually have run all three files, green —
      // otherwise an unchanged file proves nothing.
      const childFailed = `child suite failed (not a hermeticity finding):\n${output}`;
      expect(result.status, childFailed).toBe(0);
      expect(output, childFailed).toMatch(/Test Files\s+3 passed \(3\)/);
    } finally {
      if (original !== null) {
        fs.writeFileSync(STATE_FILE, original);
      } else {
        fs.rmSync(STATE_FILE, { force: true });
        if (!hadDir) {
          // Only remove the dir this test created, and only if empty.
          try {
            fs.rmdirSync(STATE_DIR);
          } catch {
            /* not empty — something else wrote into it; leave it */
          }
        }
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }, 300_000);
});
