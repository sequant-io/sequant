/**
 * Run progress wiring — keeps run.ts thin (#503 AC-2: <200 LOC).
 *
 * Builds the appropriate `onProgress` callback for the run mode:
 *   - tui   : no callback (the ink dashboard owns its own state)
 *   - quiet : LivenessHeartbeat-driven (TTY liveness + stall warning)
 *   - default: RunRenderer-driven (live grid + events log, #618)
 */

import { createRunRenderer } from "../lib/cli-ui/run-renderer.js";
import type { RunRenderer } from "../lib/cli-ui/run-renderer-types.js";
import { LivenessHeartbeat } from "../lib/workflow/heartbeat.js";
import type { ProgressCallback } from "../lib/workflow/types.js";

export interface ProgressWiring {
  renderer: RunRenderer | null;
  heartbeat: LivenessHeartbeat | null;
  onProgress: ProgressCallback | undefined;
}

/**
 * Construct the renderer + heartbeat + onProgress callback for a run.
 *
 * `tuiEnabled` and `quiet` are mutually exclusive with the renderer path.
 */
export function buildProgressWiring(args: {
  tuiEnabled: boolean;
  quiet: boolean;
  issueNumbers: number[];
  phaseTimeoutSeconds: number;
}): ProgressWiring {
  const { tuiEnabled, quiet, issueNumbers, phaseTimeoutSeconds } = args;

  const heartbeat =
    quiet && !tuiEnabled
      ? new LivenessHeartbeat({ phaseTimeoutSeconds })
      : null;

  // RunRenderer (#618) — single owner of stdout, replaces legacy
  // PhaseSpinner (#244) + parallel-mode `▸/✔` lines (#458).
  const renderer = !tuiEnabled && !quiet ? createRunRenderer() : null;
  if (renderer) {
    for (const issueNumber of issueNumbers) {
      renderer.registerIssue({ issueNumber });
    }
  }

  let onProgress: ProgressCallback | undefined;
  if (renderer) {
    onProgress = (issue, phase, event, extra) => {
      renderer.onEvent({
        issue,
        phase,
        event,
        durationSeconds: extra?.durationSeconds,
        error: extra?.error,
      });
    };
  } else if (heartbeat) {
    onProgress = (issue, phase, event) => {
      if (event === "start")
        heartbeat.start({
          issueNumber: issue,
          phase,
          startedAt: Date.now(),
        });
      else heartbeat.stop({ issueNumber: issue, phase });
    };
  }

  return { renderer, heartbeat, onProgress };
}
