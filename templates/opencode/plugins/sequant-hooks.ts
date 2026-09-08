/**
 * Sequant hook shim — opencode plugin entry point (#996, #862 P1).
 *
 * This file exports **only** the plugin function, and that is a hard
 * requirement, not a style choice: opencode load-checks every export of a
 * file it finds in `.opencode/plugin/` and rejects the whole module with
 * "Plugin export is not a function" if any export is a constant. It then
 * swallows the rejection — ERROR to the debug log, but exit 0, empty stderr,
 * and a fully resolved tool map. A plugin can therefore be present, correct,
 * and completely inert with no visible signal.
 *
 * All logic and constants live in `./lib/sequant-hooks-core.js`, which sits
 * one directory down because the plugin scan is non-recursive.
 *
 * The `tool.execute.before` signature on 1.18.27 is
 * `(input: {tool, sessionID, callID}, output: {args}) => Promise<void>` —
 * two arguments, not one `{tool, args}` object.
 */

import {
  SHIM_LOADED_SENTINEL,
  mapToolCall,
  runHook,
} from "./lib/sequant-hooks-core.js";

export const server = async (input?: {
  directory?: string;
  worktree?: string;
}) => {
  // Load handshake. opencode gives no other evidence that a plugin is live,
  // so the driver treats the absence of this line as "phase ran unguarded".
  process.stderr.write(`${SHIM_LOADED_SENTINEL}\n`);

  const directory = input?.directory ?? process.cwd();
  const worktree = input?.worktree ?? directory;

  return {
    "tool.execute.before": async (
      toolInput: { tool: string; sessionID: string; callID: string },
      toolOutput: { args: unknown },
    ): Promise<void> => {
      const ctx = {
        directory,
        worktree,
        sessionID: toolInput.sessionID,
      };
      const envelope = mapToolCall(toolInput.tool, toolOutput.args, ctx);
      if (envelope === null) return;
      runHook(envelope, ctx);
    },
  };
};
