/**
 * Behaviour gate for `templates/hooks/post-tool.sh` auto-format (#1264).
 *
 * Before this fix, the hook ran `npx prettier --write "$FILE_PATH"` on every
 * Edit/Write of a `.ts/.tsx/.js/.jsx/.json` file. With no local prettier
 * installed, npx silently downloaded the latest prettier from the registry
 * and ran it — an unpinned package launcher reaching the network from a hook
 * that runs in every installed project. The fix: only run
 * `$REPO_ROOT/node_modules/.bin/prettier`, and skip (with a logged reason)
 * when that binary doesn't exist.
 *
 * Both cases below spawn the real hook script against a throwaway git repo,
 * so the `git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel` call in
 * the hook resolves for real.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "templates", "hooks", "post-tool.sh");

let root: string;
let repo: string;
let home: string;
let npmCacheDir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function runHook(filePath: string): { exit: number; quietLog: string } {
  const result = spawnSync("bash", [HOOK], {
    cwd: repo,
    input: JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: "",
      npm_config_cache: npmCacheDir,
      CLAUDE_HOOKS_DISABLED: "",
      IS_PARALLEL_AGENT: "",
      SEQUANT_RELAY: "",
    },
    encoding: "utf-8",
  });

  const quietLogPath = join(home, ".sequant", "logs", "claude-quality.log");
  let quietLog = "";
  try {
    quietLog = readFileSync(quietLogPath, "utf-8");
  } catch {
    // No log written yet — fine, callers assert on contents only when present.
  }

  return { exit: result.status ?? -1, quietLog };
}

function npmCacheIsEmpty(): boolean {
  try {
    return readdirSync(npmCacheDir).length === 0;
  } catch {
    return true;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "post-tool-format-"));
  repo = join(root, "repo");
  home = join(root, "home");
  npmCacheDir = join(root, "npm-cache");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(npmCacheDir, { recursive: true });
  git(repo, "init", "-q");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("post-tool.sh auto-format (#1264)", () => {
  it("skips formatting and logs the reason when no local prettier exists", () => {
    const filePath = join(repo, "src", "example.ts");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "const x=1\n");

    const { exit, quietLog } = runHook(filePath);

    expect(exit).toBe(0);
    expect(npmCacheIsEmpty()).toBe(true);
    expect(quietLog).toMatch(/SKIP_FORMAT \(no local prettier\): .*example\.ts/);
    expect(quietLog).not.toMatch(/FORMATTED:/);
    // Untouched — no formatter ran against it.
    expect(readFileSync(filePath, "utf-8")).toBe("const x=1\n");
  });

  it("runs the project's local prettier stub, including for a nested file", () => {
    const binDir = join(repo, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const stubPath = join(binDir, "prettier");
    writeFileSync(
      stubPath,
      [
        "#!/bin/bash",
        'echo "stub prettier ran: $*" >> "' +
          join(root, "stub-invocations.log") +
          '"',
        "exit 0",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);

    const filePath = join(repo, "packages", "sub", "nested.ts");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "const y=2\n");

    const { exit, quietLog } = runHook(filePath);

    expect(exit).toBe(0);
    expect(npmCacheIsEmpty()).toBe(true);
    expect(quietLog).toMatch(/FORMATTED: .*nested\.ts/);
    expect(quietLog).not.toMatch(/SKIP_FORMAT/);

    const invocationLog = readFileSync(
      join(root, "stub-invocations.log"),
      "utf-8",
    );
    expect(invocationLog).toMatch(/stub prettier ran:.*nested\.ts/);
  });
});
