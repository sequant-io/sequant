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
import type {
  ProgressCallback,
  PhasePlanCallback,
} from "../lib/workflow/types.js";

export interface ProgressWiring {
  renderer: RunRenderer | null;
  heartbeat: LivenessHeartbeat | null;
  onProgress: ProgressCallback | undefined;
  /** #672 AC-2: forwarded to the orchestrator so batch-executor can hand the
   *  resolved phase pipeline back to the renderer once it's known. */
  onPhasePlan: PhasePlanCallback | undefined;
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
  /** AC-23: when auto-detect mode is on, the renderer shows `Phase: detecting…`
   *  while spec runs (before the resolved plan is known). */
  autoDetectPhases?: boolean;
  /** #672 AC-2: the base configured phase pipeline. In explicit-phase mode
   *  (not auto-detect) this is known upfront, so every issue — including those
   *  still queued behind the active one — can show its roadmap immediately
   *  rather than only once it starts running. `setPhasePlan` later refines it
   *  per issue (e.g. testgen/security-review insertion). Ignored in
   *  auto-detect mode, where the plan isn't known until spec resolves it. */
  basePhases?: string[];
  /** #624 Item 3 / D2: total allowed quality-loop iterations (from settings). */
  maxLoopIterations?: number;
}): ProgressWiring {
  const {
    tuiEnabled,
    quiet,
    issueNumbers,
    phaseTimeoutSeconds,
    autoDetectPhases,
    basePhases,
    maxLoopIterations,
  } = args;

  const heartbeat =
    quiet && !tuiEnabled
      ? new LivenessHeartbeat({ phaseTimeoutSeconds })
      : null;

  // RunRenderer (#618) — single owner of stdout, replaces legacy
  // PhaseSpinner (#244) + parallel-mode `▸/✔` lines (#458).
  // AC-26: derive a stall threshold from the configured phase timeout. Half
  // the timeout is a conservative "expected duration" proxy — phases that
  // routinely take longer would have failed timeout already.
  // #624 Item 1: pass terminal rows so the live zone can cap its height.
  // #624 Item 3 / D2: thread the configured maxLoopIterations through so
  // all three retry-suffix sites display the correct denominator.
  const renderer =
    !tuiEnabled && !quiet
      ? createRunRenderer({
          stallThresholdMs:
            phaseTimeoutSeconds > 0
              ? (phaseTimeoutSeconds * 1000) / 2
              : undefined,
          rows: process.stdout.rows,
          maxLoopIterations,
        })
      : null;
  if (renderer) {
    // #672 AC-2: seed the planned pipeline at registration when it's known
    // upfront (explicit-phase mode). This makes queued issues render their
    // roadmap before they start, matching the issue's multi-row matrix
    // mock-up. In auto-detect mode the plan isn't known yet, so we leave
    // `plannedPhases` undefined and rely on `setPhasePlan` once spec resolves.
    const seedPlan =
      !autoDetectPhases && basePhases && basePhases.length > 0
        ? basePhases
        : undefined;
    for (const issueNumber of issueNumbers) {
      renderer.registerIssue({
        issueNumber,
        autoDetect: autoDetectPhases,
        plannedPhases: seedPlan,
      });
    }
  }

  let onProgress: ProgressCallback | undefined;
  if (renderer) {
    onProgress = (issue, phase, event, extra) => {
      // #543: activity events only feed the TUI's nowLine — skip the line renderer.
      if (event === "activity") return;
      // #624 Item 3: pass the outer-loop iteration through so the renderer can
      // render `(attempt N/M)` / `loop N/M`.
      renderer.onEvent({
        issue,
        phase,
        event,
        durationSeconds: extra?.durationSeconds,
        error: extra?.error,
        iteration: extra?.iteration,
      });
    };
  } else if (heartbeat) {
    onProgress = (issue, phase, event) => {
      if (event === "activity") return;
      if (event === "start")
        heartbeat.start({
          issueNumber: issue,
          phase,
          startedAt: Date.now(),
        });
      else heartbeat.stop({ issueNumber: issue, phase });
    };
  }

  // #672 AC-2: only the renderer path consumes a phase plan; quiet / TUI
  // modes leave this undefined and the orchestrator no-ops the callback.
  const onPhasePlan: PhasePlanCallback | undefined = renderer
    ? (issue, phases) => renderer.setPhasePlan(issue, phases)
    : undefined;

  return { renderer, heartbeat, onProgress, onPhasePlan };
}
