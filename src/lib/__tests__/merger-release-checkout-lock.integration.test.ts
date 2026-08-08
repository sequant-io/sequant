/**
 * Contention integration test for /merger and /release checkout-lock
 * participation (issue #911, AC-8, from the issue's Test plan).
 *
 * Drives the REAL `.claude/hooks/pre-tool.sh` as a subprocess, because the hook
 * — not the TypeScript — is what refuses a non-holder's branch-mutating git. A
 * file-reading gate proves the prompt *says* to acquire/release; this proves the
 * commands the prompt names are actually the ones the guard governs:
 *
 *   - Session A holds the checkout lock (a different issue).
 *   - Session B runs each skill's FIRST guarded command → refused.
 *   - The holding session runs the same command → allowed (no self-block),
 *     which is exactly the protection acquiring buys the skill.
 *
 * Modeled on `src/lib/locks/checkout-lock.integration.test.ts`; kept separate so
 * the #911 skill gates and this contention proof move together.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir, hostname } from "os";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/lib/__tests__ -> repo root */
const REPO_ROOT = resolve(HERE, "../../..");
const HOOK = join(REPO_ROOT, ".claude/hooks/pre-tool.sh");

const HOLDER_SESSION = "session-holder-911";
const OTHER_SESSION = "session-foreign-911";
const HOLDER_ISSUE = 23;

let checkout: string;

/** Hermetic git: no user config, no signing, no hooks. */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=sequant-test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/** A REAL main checkout — the guard resolves cwd with `git rev-parse`. */
function makeMainCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "sequant-911-"));
  git(dir, "init", "-q", "-b", "main", ".");
  mkdirSync(join(dir, ".sequant/locks"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  // A second commit so `git reset --soft HEAD~1` (release's guarded verb) has a
  // parent to target — the guard blocks before it runs, but we want a realistic
  // command the guard would otherwise let execute.
  writeFileSync(join(dir, "CHANGELOG.md"), "changelog\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "second");
  return dir;
}

function writeCheckoutLock(
  dir: string,
  overrides: Record<string, unknown> = {},
): void {
  const payload = {
    pid: 4711,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    command: `/fullsolve ${HOLDER_ISSUE}`,
    issue: HOLDER_ISSUE,
    sessionId: HOLDER_SESSION,
    skipPidCheck: true,
    ...overrides,
  };
  writeFileSync(
    join(dir, ".sequant/locks/checkout.lock"),
    JSON.stringify(payload, null, 2),
  );
}

function runHook(opts: { command: string; sessionId?: string }): {
  status: number;
  stderr: string;
} {
  const payload: Record<string, unknown> = {
    tool_name: "Bash",
    tool_input: { command: opts.command },
    cwd: checkout,
  };
  if (opts.sessionId) payload.session_id = opts.sessionId;

  const result = spawnSync("bash", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: checkout,
      CLAUDE_PLUGIN_DATA: join(checkout, ".hooklogs"),
      CLAUDE_HOOKS_DISABLED: "",
      SEQUANT_ORCHESTRATOR: "",
      SEQUANT_ISSUE: "",
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

beforeEach(() => {
  checkout = makeMainCheckout();
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

// Each skill's FIRST guarded command in the main checkout.
const FIRST_GUARDED = [
  { skill: "/merger", command: "git checkout main" },
  { skill: "/release", command: "git reset --soft HEAD~1" },
] as const;

describe("#911/AC-8: a foreign holder refuses each skill's first guarded command", () => {
  it.each(FIRST_GUARDED)(
    "$skill: `$command` is refused when another session holds the checkout",
    ({ command }) => {
      writeCheckoutLock(checkout);

      const { status, stderr } = runHook({
        command,
        sessionId: OTHER_SESSION,
      });

      expect(status).toBe(2);
      expect(stderr).toContain(
        "HOOK_BLOCKED: Checkout held by another session",
      );
      expect(stderr).toContain(`#${HOLDER_ISSUE}`);
    },
  );

  it.each(FIRST_GUARDED)(
    "$skill: the HOLDING session runs `$command` unrefused (acquiring is what buys this)",
    ({ command }) => {
      writeCheckoutLock(checkout);

      const { status } = runHook({ command, sessionId: HOLDER_SESSION });

      expect(status).toBe(0);
    },
  );

  it.each(FIRST_GUARDED)(
    "$skill: `$command` is allowed when no checkout lock is held",
    ({ command }) => {
      // Baseline: without a holder the guard never fires, so the refusals above
      // are caused by the lock, not by the command shape.
      const { status } = runHook({ command, sessionId: OTHER_SESSION });
      expect(status).toBe(0);
    },
  );
});
