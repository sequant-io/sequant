// #988 AC-2 / AC-3: `sequant serve` started against a stale skills install
// must (a) modify no project file and (b) say so on stderr with the fix.
// Drives the real built CLI (dist/bin/cli.js, produced by vitest.global-setup)
// as a subprocess with cwd = a fixture project — the exact shape of the
// incident: the plugin's `npx sequant@latest serve` launched by Claude Code
// with cwd = the open repo, against a `.sequant-version` two releases behind.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "bin", "cli.js");
const CUSTOM_HOOK = "#!/bin/bash\necho custom commit-on-main guard\n";

function writeStaleProject(root: string): void {
  fs.mkdirSync(path.join(root, ".claude", "skills", "qa"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".sequant"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".sequant-manifest.json"),
    JSON.stringify({
      version: "0.0.1",
      stack: "nextjs",
      installedAt: "2026-01-01T00:00:00Z",
      files: {},
    }),
  );
  fs.writeFileSync(
    path.join(root, ".claude", "skills", ".sequant-version"),
    "0.0.1",
  );
  fs.writeFileSync(
    path.join(root, ".claude", "hooks", "pre-tool.sh"),
    CUSTOM_HOOK,
  );
  fs.writeFileSync(
    path.join(root, ".claude", "skills", "qa", "SKILL.md"),
    "# custom qa\n",
  );
  fs.writeFileSync(path.join(root, "AGENTS.md"), "custom agents\n");
  fs.writeFileSync(
    path.join(root, ".sequant", "settings.json"),
    JSON.stringify({ version: "1.0", run: { timeout: 1800 } }),
  );
}

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(root, full), fs.readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return out;
}

describe("#988 AC-2/AC-3: `sequant serve` is side-effect-free on a stale install", () => {
  let root: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-serve-"));
    writeStaleProject(root);
  });

  afterEach(() => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    child = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts, warns on stderr naming `update`, and leaves every file byte-identical", async () => {
    expect(
      fs.existsSync(CLI),
      "dist/bin/cli.js must be built (vitest.global-setup)",
    ).toBe(true);
    const before = snapshot(root);

    child = spawn(process.execPath, [CLI, "serve"], {
      cwd: root,
      env: { ...process.env, SEQUANT_ORCHESTRATOR: "", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    const started = new Promise<void>((resolveStarted, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`serve did not start; stderr so far:\n${stderr}`)),
        25_000,
      );
      child!.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        // Both lines are written synchronously after connect(); wait for the
        // warning itself so the assertion is not racing the second write.
        if (/No files were modified/.test(stderr)) {
          clearTimeout(timer);
          resolveStarted();
        }
      });
      child!.on("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`serve exited early (code ${code}); stderr:\n${stderr}`),
        );
      });
    });
    await started;

    // Give any would-be background write a moment to land before comparing.
    await new Promise((r) => setTimeout(r, 300));

    expect(stderr).toContain("Sequant MCP server started (stdio)");
    expect(stderr).toMatch(
      /!  Skills install is stale \(0\.0\.1 → \d+\.\d+\.\d+[^)]*\)\. No files were modified\. Run: (npx )?sequant update/,
    );
    expect(
      fs.readFileSync(
        path.join(root, ".claude", "hooks", "pre-tool.sh"),
        "utf8",
      ),
    ).toBe(CUSTOM_HOOK);
    expect(
      fs.readFileSync(
        path.join(root, ".claude", "skills", ".sequant-version"),
        "utf8",
      ),
    ).toBe("0.0.1");
    expect(snapshot(root)).toEqual(before);

    child.kill("SIGTERM");
  });
});

describe("#1084 AC-3: `sequant serve` operates on SEQUANT_PROJECT_DIR, not cwd", () => {
  let projectDir: string;
  let launchCwd: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    // Reproduces the launcher's shape (#1084): npx runs from an isolated,
    // unrelated dir, and the real project is passed via the env var.
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sequant-serve-projectdir-"),
    );
    writeStaleProject(projectDir);
    launchCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "sequant-serve-launchcwd-"),
    );
  });

  afterEach(() => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    child = null;
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(launchCwd, { recursive: true, force: true });
  });

  it("chdirs to SEQUANT_PROJECT_DIR and reports that project's stale-skills warning, not cwd's", async () => {
    expect(
      fs.existsSync(CLI),
      "dist/bin/cli.js must be built (vitest.global-setup)",
    ).toBe(true);

    child = spawn(process.execPath, [CLI, "serve"], {
      cwd: launchCwd,
      env: {
        ...process.env,
        SEQUANT_ORCHESTRATOR: "",
        NO_COLOR: "1",
        SEQUANT_PROJECT_DIR: projectDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    const started = new Promise<void>((resolveStarted, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`serve did not start; stderr so far:\n${stderr}`)),
        25_000,
      );
      child!.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (/No files were modified/.test(stderr)) {
          clearTimeout(timer);
          resolveStarted();
        }
      });
      child!.on("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`serve exited early (code ${code}); stderr:\n${stderr}`),
        );
      });
    });
    await started;

    // If serve had stayed on cwd (launchCwd, which has no .sequant-manifest.json
    // at all), the stale-skills warning naming 0.0.1 could not appear.
    expect(stderr).toMatch(
      /!  Skills install is stale \(0\.0\.1 → \d+\.\d+\.\d+[^)]*\)\. No files were modified\. Run: (npx )?sequant update/,
    );

    child.kill("SIGTERM");
  });

  it("rejects a non-directory SEQUANT_PROJECT_DIR with a stderr message naming the path and a non-zero exit", async () => {
    expect(
      fs.existsSync(CLI),
      "dist/bin/cli.js must be built (vitest.global-setup)",
    ).toBe(true);
    const bogusPath = path.join(launchCwd, "does-not-exist");

    const exit = await new Promise<{ code: number | null; stderr: string }>(
      (resolveExit, reject) => {
        child = spawn(process.execPath, [CLI, "serve"], {
          cwd: launchCwd,
          env: {
            ...process.env,
            SEQUANT_ORCHESTRATOR: "",
            NO_COLOR: "1",
            SEQUANT_PROJECT_DIR: bogusPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        const timer = setTimeout(
          () =>
            reject(new Error(`serve did not exit; stderr so far:\n${stderr}`)),
          10_000,
        );
        child.stderr!.on(
          "data",
          (chunk: Buffer) => (stderr += chunk.toString()),
        );
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolveExit({ code, stderr });
        });
      },
    );

    expect(exit.code).not.toBe(0);
    expect(exit.stderr).toContain(bogusPath);
  });
});
