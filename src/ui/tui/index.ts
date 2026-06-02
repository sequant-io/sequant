/**
 * Experimental multi-issue TUI entry point.
 *
 * Mounts an `ink` app that polls a snapshot provider's `getSnapshot()` at
 * 10 Hz. Unmounts when the snapshot reports `done` so the shell returns
 * cleanly. Only safe to call when `process.stdout.isTTY` is true.
 *
 * The provider is structural (`{ getSnapshot(): RunSnapshot }`) so any source
 * of run state can drive the TUI — `RunOrchestrator` for `sequant run`, or the
 * single-issue adapter `sequant ready` owns (#699). The TUI only ever reads
 * `getSnapshot()`, never the orchestrator's batch lifecycle.
 */

import { createElement } from "react";
import { render } from "ink";
import type { RunSnapshot } from "../../lib/workflow/run-state.js";
import { App } from "./App.js";
import { composeTeardownSummary } from "./teardown.js";

/** Minimal structural contract the TUI needs from its state source. */
export interface SnapshotProvider {
  getSnapshot(): RunSnapshot;
}

export interface TuiHandle {
  /** Promise that resolves when the TUI unmounts. */
  done: Promise<void>;
  /** Force-unmount (e.g., on SIGINT fallback). */
  unmount: () => void;
}

export function renderTui(provider: SnapshotProvider): TuiHandle {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const instance = render(
    createElement(App, {
      getSnapshot: () => provider.getSnapshot(),
      onDone: () => {
        instance.unmount();
      },
    }),
    { exitOnCtrlC: false },
  );

  instance.waitUntilExit().then(() => {
    // #699 AC-5: ink leaves no per-issue history on unmount, so write a durable
    // `✔/✘` transcript from the final snapshot into scrollback. Runs before
    // `done` resolves so the caller's own report (e.g. `ready`'s) prints after.
    const summary = composeTeardownSummary(provider.getSnapshot());
    if (summary) process.stdout.write(summary + "\n");
    resolveDone();
  });

  return {
    done,
    unmount: () => {
      instance.unmount();
    },
  };
}
