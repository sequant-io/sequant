// #1084 AC-4: reproduces the exact shadow from the issue's measured table —
// a project with a stale `node_modules/sequant` that doesn't implement
// `serve` — and proves mcp-launch.mjs spawns `npx` from a cwd where that
// shadowing package can't be resolved.
//
// Mutation-verified: pointing the launcher's spawn `cwd` at `projectDir`
// (instead of an mkdtemp dir) fails the cwd assertion below.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const LAUNCHER = path.join(REPO_ROOT, "scripts", "mcp-launch.mjs");

describe("#1084 AC-4: mcp-launch.mjs isolates npx from a shadowing local sequant", () => {
  let projectDir: string;
  let fakeNpxDir: string;
  let recordPath: string;

  beforeEach(() => {
    // Reproduce the issue's own repro: a pre-`serve` sequant shadowing the
    // project's node_modules.
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sequant-shadow-project-"),
    );
    fs.mkdirSync(path.join(projectDir, "node_modules", "sequant", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectDir, "node_modules", "sequant", "package.json"),
      JSON.stringify({ name: "sequant", version: "1.20.1", bin: "bin/cli.js" }),
    );
    fs.writeFileSync(
      path.join(projectDir, "node_modules", "sequant", "bin", "cli.js"),
      "#!/usr/bin/env node\n" +
        "process.stderr.write(\"error: unknown command 'serve'\\n\");\n" +
        "process.exit(0);\n",
      { mode: 0o755 },
    );

    // A fake `npx` placed first on PATH. It doesn't simulate real resolution
    // — it only records its own invocation cwd/args, which is all the
    // launcher's contract (an isolated cwd, the pinned spec) can be judged on.
    fakeNpxDir = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-fake-npx-"));
    recordPath = path.join(fakeNpxDir, "npx-invocation.json");
    fs.writeFileSync(
      path.join(fakeNpxDir, "npx"),
      "#!/usr/bin/env node\n" +
        "const fs = require('fs');\n" +
        `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n` +
        "process.exit(0);\n",
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(fakeNpxDir, { recursive: true, force: true });
  });

  it("spawns npx from a dir outside the shadowing project, with the pinned spec", async () => {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [LAUNCHER, "sequant@2.15.1"], {
        cwd: projectDir,
        env: {
          ...process.env,
          PATH: `${fakeNpxDir}${path.delimiter}${process.env.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(
        () =>
          reject(
            new Error(`launcher did not exit in time; stderr:\n${stderr}`),
          ),
        10_000,
      );
      child.on("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      child.on("error", reject);
    });

    expect(fs.existsSync(recordPath), "fake npx was never invoked").toBe(true);
    const recorded = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      cwd: string;
      argv: string[];
    };

    expect(recorded.cwd).not.toBe(projectDir);
    expect(recorded.cwd.startsWith(projectDir + path.sep)).toBe(false);
    expect(recorded.argv).toEqual(["-y", "sequant@2.15.1", "serve"]);
  });
});
