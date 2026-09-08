/**
 * Sequant hook shim for opencode (#996, #862 P1).
 *
 * opencode has no equivalent of Claude Code's `PreToolUse` hook, so an
 * opencode phase would otherwise run with none of sequant's force-push,
 * commit-message, or worktree-boundary guards. This plugin bridges the two:
 * it translates opencode's `(input, output)` tool-call pair into the stdin
 * envelope `.claude/hooks/pre-tool.sh` expects, spawns that hook, and throws
 * when the hook blocks.
 *
 * It deliberately re-uses the real 1,576-line `pre-tool.sh` rather than
 * reimplementing the guards in TypeScript: forking that surface is out of
 * scope for #996 and would drift immediately.
 *
 * ## Fail closed
 *
 * Every path that cannot *prove* a call is safe throws. That includes a
 * malformed args object, an unrecognised tool, a missing hook script, a
 * missing `jq`, a spawn failure, a timeout, and any unexpected exit code.
 * A `try/catch` that swallows and returns would be the single
 * highest-severity defect available here — passing a call through is
 * indistinguishable from having checked it.
 *
 * ## Translate, never forward
 *
 * opencode's tool arguments are camelCase (`filePath`); `pre-tool.sh` reads
 * snake_case (`.tool_input.file_path`, lines 1495/1539). Forwarding `args`
 * verbatim would leave `FILE_PATH` empty, skip the worktree-boundary and
 * file-lock guards entirely, and fall through to `exit 0` — a silent
 * fail-open that looks exactly like "checked and allowed". Every guarded
 * field is therefore mapped by name, and an absent one throws.
 *
 * ## No runtime dependency on `@opencode-ai/plugin`
 *
 * The driver redirects `XDG_CONFIG_HOME` to a fresh temp dir per run, so the
 * vendored plugin package is not present at phase time. Types are declared
 * structurally here; only Node builtins are imported at runtime.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Emitted on stderr when this module loads.
 *
 * opencode **silently ignores a plugin that throws at load** — verified on
 * 1.18.27: a plugin containing a bare `throw` yields exit 0, empty stderr,
 * and a fully resolved tool map. So "the plugin file exists" proves nothing
 * about whether the guards are running, and neither a doctor check nor a
 * driver preflight that stats the file can close that gap.
 *
 * This sentinel is the handshake that can: if it is absent from a run's
 * stderr, the shim did not load and the phase was unguarded.
 */
export const SHIM_LOADED_SENTINEL = "SEQUANT_HOOK_SHIM_ACTIVE";

/** Hook script this shim delegates to, relative to the project directory. */
export const HOOK_RELATIVE_PATH = ".claude/hooks/pre-tool.sh";

/** Hard cap on the hook subprocess, in milliseconds. A hang fails closed. */
export const HOOK_TIMEOUT_MS = 30_000;

/**
 * opencode tool id → the `tool_name` `pre-tool.sh` dispatches on.
 *
 * Exactly the three the hook gates: `Bash` (:605, :712, and the `git commit`
 * guards), `Edit`/`Write` (:1454, :1536). Anything else it would evaluate and
 * pass through anyway.
 */
export const GUARDED_TOOLS: Readonly<Record<string, string>> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
};

/**
 * Read-only / non-mutating opencode tools that need no guard.
 *
 * Enumerated from the resolved tool map of opencode 1.18.27's default agent
 * (`opencode debug agent build`). Kept as an explicit allowlist rather than a
 * default-allow so that a *new* tool in a future opencode release fails
 * closed instead of slipping through unguarded.
 *
 * ⚠️ Never add a file-mutating tool to this set. `patch` / `apply_patch`
 * (args: `{patchText}`) is the live example — it writes files but carries no
 * path field at all, so the Edit/Write guard structurally cannot see its
 * targets. It is not in 1.18.27's default tool map; if it becomes reachable
 * it must be denied in the agent definition, not passed through here.
 */
export const PASSTHROUGH_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "task",
  "todowrite",
  "todoread",
  "webfetch",
  "skill",
  "question",
  "invalid",
]);

/**
 * Environment variables that disable the guards, stripped before the hook is
 * spawned.
 *
 * `pre-tool.sh:9` exits 0 unconditionally when `CLAUDE_HOOKS_DISABLED=true`,
 * and the value rides an unbroken inheritance chain into this plugin:
 * `phase-executor.ts` (`...process.env`) → the opencode driver
 * (`...process.env`) → opencode → here. One ambient export in a shell or a CI
 * `env:` block would otherwise disable every guard for a whole run, silently.
 * The shim is the choke point, so it is the cheapest place to close that.
 */
export const STRIPPED_ENV_VARS: readonly string[] = [
  "CLAUDE_HOOKS_DISABLED",
  "CLAUDE_HOOKS_FILE_LOCKING",
];

/** The stdin envelope `pre-tool.sh` parses (jq path at :19-34). */
export interface HookEnvelope {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
  cwd: string;
}

/** Directory context opencode hands the plugin. */
export interface ShimContext {
  /** opencode's `PluginInput.directory` — the main checkout (#901). */
  directory: string;
  /** opencode's `PluginInput.worktree` — where the tool will actually run. */
  worktree: string;
  /** Session id from the tool-call input. */
  sessionID: string;
}

/** Thrown for every fail-closed condition, so the driver can classify it. */
export class SequantHookBlocked extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SequantHookBlocked";
    this.code = code;
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    // Fail closed: an unmappable call is never forwarded. This is the case
    // AC-1 exercises with a missing `command`.
    throw new SequantHookBlocked(
      `sequant hook shim: opencode "${tool}" call is missing a usable "${key}" ` +
        `(got ${value === undefined ? "undefined" : typeof value}). ` +
        `Refusing to run it unguarded.`,
      "malformed-args",
    );
  }
  return value;
}

/**
 * Resolve a tool-supplied path the same way opencode will.
 *
 * opencode resolves a relative `filePath` against its `directory` (the main
 * checkout) — `isAbsolute(p) ? p : join(directory, p)` in the 1.18.27 tool
 * implementation. `pre-tool.sh` resolves against its *own* cwd before the
 * `$SEQUANT_WORKTREE` prefix test at :1512. Left alone, the two bases differ
 * and the boundary check compares paths that were never comparable.
 */
export function resolveToolPath(rawPath: string, directory: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(join(directory, rawPath));
}

/**
 * Translate one opencode tool call into a hook envelope.
 *
 * @returns the envelope to send to `pre-tool.sh`, or `null` when the tool is
 *   a known-unguarded passthrough and the hook need not be spawned.
 * @throws {SequantHookBlocked} on a malformed args object or an unrecognised
 *   tool — both fail closed.
 */
export function mapToolCall(
  tool: string,
  args: unknown,
  ctx: ShimContext,
): HookEnvelope | null {
  if (PASSTHROUGH_TOOLS.has(tool)) return null;

  const toolName = GUARDED_TOOLS[tool];
  if (toolName === undefined) {
    // An opencode release that adds a tool sequant has never seen could be
    // adding a mutating one. Blocking is noisy; passing through is unguarded.
    // The version floor and the CI smoke job are what keep this from firing.
    throw new SequantHookBlocked(
      `sequant hook shim: unknown opencode tool "${tool}". ` +
        `sequant cannot tell whether it mutates the workspace, so it is blocked. ` +
        `Upgrade sequant, or deny "${tool}" in the agent definition.`,
      "unknown-tool",
    );
  }

  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new SequantHookBlocked(
      `sequant hook shim: opencode "${tool}" call has no args object ` +
        `(got ${args === null ? "null" : Array.isArray(args) ? "array" : typeof args}).`,
      "malformed-args",
    );
  }

  const argsObj = args as Record<string, unknown>;

  if (tool === "bash") {
    const command = requireString(argsObj, "command", tool);
    // `bash` accepts an optional `workdir` that overrides where the command
    // runs. The hook evaluates directory-sensitive guards (the #901 checkout
    // lock) against `.cwd`, so if the tool will run elsewhere the guard must
    // be told — otherwise it rules on a directory the command never uses.
    const workdir = argsObj.workdir;
    const cwd =
      typeof workdir === "string" && workdir.length > 0
        ? resolveToolPath(workdir, ctx.directory)
        : ctx.worktree;

    return {
      tool_name: toolName,
      tool_input: { command },
      session_id: ctx.sessionID,
      cwd,
    };
  }

  // edit / write. Both carry `filePath`; the hook reads `file_path`.
  const filePath = requireString(argsObj, "filePath", tool);

  return {
    tool_name: toolName,
    tool_input: { file_path: resolveToolPath(filePath, ctx.directory) },
    session_id: ctx.sessionID,
    cwd: ctx.worktree,
  };
}

/** What the shim should do with a hook process's outcome. */
export interface HookDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Interpret a `pre-tool.sh` exit code.
 *
 * The hook's own contract (its header comment): 0 = allow, 2 = block,
 * 1 = non-blocking error. Anything else is undefined behaviour, and undefined
 * behaviour in a security guard is a block.
 */
export function decideFromHook(
  exitCode: number | null,
  stderr: string,
): HookDecision {
  if (exitCode === 0) return { allow: true };
  if (exitCode === 1) {
    // Documented as non-blocking: the hook logged a problem but did not
    // object to the call.
    return { allow: true, reason: stderr.trim() || undefined };
  }
  if (exitCode === 2) {
    return {
      allow: false,
      reason: stderr.trim() || "HOOK_BLOCKED (no detail on stderr)",
    };
  }
  return {
    allow: false,
    reason:
      `sequant hook shim: pre-tool.sh exited ${exitCode === null ? "on a signal" : `with ${exitCode}`}, ` +
      `which is outside its documented 0/1/2 contract. Blocking.` +
      (stderr.trim() ? ` stderr: ${stderr.trim()}` : ""),
  };
}

/**
 * Build the hook's environment: inherited, minus the guard-disabling vars,
 * plus the two directory variables the hook's #901 logic depends on.
 */
export function buildHookEnv(
  base: NodeJS.ProcessEnv,
  ctx: Pick<ShimContext, "directory" | "worktree">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV_VARS) delete env[key];
  // CLAUDE_PROJECT_DIR stays pinned to the main checkout even while the agent
  // works in a worktree — the distinction the checkout-lock guard reads.
  env.CLAUDE_PROJECT_DIR = ctx.directory;
  return env;
}

/**
 * Spawn `pre-tool.sh` with `envelope` on stdin and enforce its verdict.
 *
 * @throws {SequantHookBlocked} when the hook blocks, or when the shim cannot
 *   establish that it ran correctly.
 */
export function runHook(envelope: HookEnvelope, ctx: ShimContext): void {
  const hookPath = join(ctx.directory, HOOK_RELATIVE_PATH);

  if (!existsSync(hookPath)) {
    // A plugin present but a hook missing is exactly the silently-unguarded
    // state #996 exists to prevent.
    throw new SequantHookBlocked(
      `sequant hook shim: ${HOOK_RELATIVE_PATH} not found under ${ctx.directory}. ` +
        `The guards cannot run, so the call is blocked. Run \`sequant init\` to restore it.`,
      "hook-missing",
    );
  }

  const env = buildHookEnv(process.env, ctx);

  // `pre-tool.sh` branches on `command -v jq` (:18) and falls back to a
  // grep/sed parser that truncates nested objects. opencode runs under Bun,
  // whose PATH is not necessarily the login shell's, so a silently degraded
  // parse is a real possibility. Degraded parsing of a security envelope is
  // not something to allow quietly.
  const jq = spawnSync("sh", ["-c", "command -v jq"], { env, encoding: "utf-8" });
  if (jq.status !== 0) {
    throw new SequantHookBlocked(
      `sequant hook shim: jq is not on PATH, so pre-tool.sh would parse the ` +
        `envelope with its degraded fallback. Blocking rather than guessing. ` +
        `Install jq (\`brew install jq\` / \`apt-get install jq\`).`,
      "jq-missing",
    );
  }

  const result = spawnSync(hookPath, [], {
    input: JSON.stringify(envelope),
    env,
    cwd: envelope.cwd,
    encoding: "utf-8",
    timeout: HOOK_TIMEOUT_MS,
  });

  if (result.error) {
    throw new SequantHookBlocked(
      `sequant hook shim: could not run ${HOOK_RELATIVE_PATH} (${result.error.message}). Blocking.`,
      "hook-spawn-failed",
    );
  }

  const decision = decideFromHook(result.status, result.stderr ?? "");
  if (!decision.allow) {
    throw new SequantHookBlocked(decision.reason ?? "blocked", "hook-blocked");
  }
}

/**
 * Plugin entry point.
 *
 * Structurally typed — see the module header on why `@opencode-ai/plugin` is
 * not imported. The `tool.execute.before` signature on 1.18.27 is
 * `(input: {tool, sessionID, callID}, output: {args}) => Promise<void>`:
 * two arguments, not one `{tool, args}` object.
 */
export const server = async (input?: {
  directory?: string;
  worktree?: string;
}) => {
  // Load handshake. Must be the first thing the module does that is
  // externally observable — see SHIM_LOADED_SENTINEL.
  process.stderr.write(`${SHIM_LOADED_SENTINEL}\n`);

  const directory = input?.directory ?? process.cwd();
  const worktree = input?.worktree ?? directory;

  return {
    "tool.execute.before": async (
      toolInput: { tool: string; sessionID: string; callID: string },
      toolOutput: { args: unknown },
    ): Promise<void> => {
      const envelope = mapToolCall(toolInput.tool, toolOutput.args, {
        directory,
        worktree,
        sessionID: toolInput.sessionID,
      });
      if (envelope === null) return;
      runHook(envelope, { directory, worktree, sessionID: toolInput.sessionID });
    },
  };
};

export default server;
