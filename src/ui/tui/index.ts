/**
 * Experimental multi-issue TUI entry point.
 *
 * Mounts an `ink` app that polls `RunOrchestrator.getSnapshot()` at 10 Hz.
 * Unmounts when the orchestrator reports `done` so the shell returns
 * cleanly. Only safe to call when `process.stdout.isTTY` is true.
 */

import { createElement } from "react";
import { render } from "ink";
import type { RunOrchestrator } from "../../lib/workflow/run-orchestrator.js";
import { App } from "./App.js";

export interface TuiHandle {
  /** Promise that resolves when the TUI unmounts. */
  done: Promise<void>;
  /** Force-unmount (e.g., on SIGINT fallback). */
  unmount: () => void;
}

export function renderTui(orchestrator: RunOrchestrator): TuiHandle {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const instance = render(
    createElement(App, {
      getSnapshot: () => orchestrator.getSnapshot(),
      onDone: () => {
        instance.unmount();
      },
    }),
    { exitOnCtrlC: false },
  );

  instance.waitUntilExit().then(() => resolveDone());

  return {
    done,
    unmount: () => {
      instance.unmount();
    },
  };
}
