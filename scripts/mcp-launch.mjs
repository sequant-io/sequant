#!/usr/bin/env node
// #1084: launcher shipped with the plugin so `npx` never resolves `sequant`
// from the open project's own node_modules (npx's local-project lookup keys
// off cwd, and no npx flag defeats it — only the working directory does).
// Runs before `npm install`, so this file must import only `node:` builtins.
//
// Usage: node mcp-launch.mjs <package-spec>
//   e.g. node mcp-launch.mjs sequant@2.15.1

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spec = process.argv[2];
if (!spec) {
  process.stderr.write("mcp-launch: missing package spec argument\n");
  process.exit(1);
}

// ${CLAUDE_PROJECT_DIR} is substituted by Claude Code before this process
// starts; an unset or empty placeholder falls back to our own cwd.
const projectDir = process.env.SEQUANT_PROJECT_DIR || process.cwd();

let launchCwd;
try {
  // A cwd with no package.json/node_modules ancestor forces npx to resolve
  // from its cache/registry instead of a locally shadowing install.
  launchCwd = mkdtempSync(join(tmpdir(), "sequant-mcp-launch-"));
} catch (err) {
  process.stderr.write(
    `mcp-launch: failed to create an isolated launch directory: ${err.message}\n`,
  );
  process.exit(1);
}

process.stderr.write(
  `mcp-launch: project dir ${projectDir}; launching npx from ${launchCwd}\n`,
);

function cleanup() {
  try {
    rmSync(launchCwd, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

const child = spawn("npx", ["-y", spec, "serve"], {
  cwd: launchCwd,
  stdio: "inherit",
  shell: false,
  env: { ...process.env, SEQUANT_PROJECT_DIR: projectDir },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  });
}

child.on("error", (err) => {
  process.stderr.write(`mcp-launch: failed to spawn npx: ${err.message}\n`);
  cleanup();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  cleanup();
  if (signal) {
    // Re-raise the same signal so our own exit reflects the child's cause,
    // rather than translating it into an opaque exit code.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
