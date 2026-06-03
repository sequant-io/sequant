/** sequant run — Thin CLI adapter that delegates to RunOrchestrator. */

import chalk from "chalk";
import { getManifest } from "../lib/manifest.js";
import { getSettings } from "../lib/settings.js";
import type { RunOptions } from "../lib/workflow/types.js";
import { checkVersionCached, getVersionWarning } from "../lib/version-check.js";
import { ui } from "../lib/cli-ui.js";
import { parseBatches } from "../lib/workflow/batch-executor.js";
import { RunOrchestrator } from "../lib/workflow/run-orchestrator.js";
import { displayConfig, displaySummary } from "./run-display.js";
import { buildProgressWiring } from "./run-progress.js";
import { normalizeQualityLoop, resolveTuiEnabled } from "./run-flags.js";

// Re-export public API for backwards compatibility
export * from "./run-compat.js";

/** Parse CLI args → validate → delegate to RunOrchestrator.run() → display summary. */
export async function runCommand(
  issues: string[],
  options: RunOptions,
): Promise<void> {
  // #705: `-q` is a hidden alias for the quality loop (it no longer maps to
  // --quiet, which moved to `-s`). Normalize before any consumer reads
  // `qualityLoop` so `-q` and `-Q` produce identical behavior.
  options.qualityLoop = normalizeQualityLoop(options);

  console.log(ui.headerBox("SEQUANT WORKFLOW"));

  if (!options.quiet) {
    try {
      const v = await checkVersionCached();
      if (v.isOutdated && v.latestVersion) {
        console.log(
          chalk.yellow(
            `  !  ${getVersionWarning(v.currentVersion, v.latestVersion, v.isLocalInstall)}`,
          ),
        );
        console.log("");
      }
    } catch {
      /* non-critical */
    }
  }

  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    return;
  }

  const settings = await getSettings();

  // #605: --stacked implies --chain; reject explicit --no-chain combo before
  // we evaluate any --chain-dependent constraint below.
  if (options.stacked && options.chain === false) {
    console.log(chalk.red("❌ --stacked cannot be combined with --no-chain"));
    return;
  }
  if (options.stacked) {
    options.chain = true;
  }

  // Validate constraints
  if (options.chain && options.batch?.length) {
    console.log(chalk.red("❌ --chain cannot be used with --batch"));
    return;
  }
  if (
    options.concurrency !== undefined &&
    (options.concurrency < 1 || !Number.isInteger(options.concurrency))
  ) {
    console.log(
      chalk.red(
        `❌ Invalid --concurrency value: ${options.concurrency}. Must be a positive integer.`,
      ),
    );
    return;
  }
  if (options.qaGate && !options.chain) {
    console.log(chalk.red("❌ --qa-gate requires --chain flag"));
    return;
  }

  let batches: number[][] | null = null;
  if (options.batch?.length) {
    batches = parseBatches(options.batch);
    console.log(
      chalk.gray(
        `  Batch mode: ${batches.map((b) => `[${b.join(", ")}]`).join(" → ")}`,
      ),
    );
  }

  const init = {
    options,
    settings,
    manifest: {
      stack: manifest.stack,
      packageManager: manifest.packageManager ?? "npm",
    },
  };
  const resolved = RunOrchestrator.resolveConfig(init, issues, batches);
  displayConfig(resolved);

  // #705: the boxed Ink TUI is the default on a TTY; `--no-tui` opts out,
  // non-TTY auto-degrades, and `--quiet`/`-s` suppresses it (heartbeat-only).
  // See resolveTuiEnabled for the full precedence.
  const tuiEnabled = resolveTuiEnabled(options, Boolean(process.stdout.isTTY));

  // RunRenderer (#618) + LivenessHeartbeat (#574) wiring lives in
  // run-progress.ts to keep this adapter under the 200-LOC cap (#503 AC-2).
  const { renderer, heartbeat, onProgress, onPhasePlan } = buildProgressWiring({
    tuiEnabled,
    quiet: Boolean(options.quiet),
    issueNumbers: resolved.issueNumbers,
    phaseTimeoutSeconds: settings.run.timeout,
    autoDetectPhases: resolved.autoDetectPhases,
    // #672 AC-2: base pipeline so queued issues show their roadmap upfront in
    // explicit-phase mode (ignored when auto-detect resolves the plan later).
    basePhases: resolved.config.phases,
    // #624 Item 3 / D2: route the resolved maxIterations into the renderer so
    // `(attempt N/M)` and `loop N/M` reflect actual configured limits.
    maxLoopIterations: resolved.config.maxIterations,
  });

  if (tuiEnabled) {
    const { renderTui } = await import("../ui/tui/index.js");
    let tuiHandle: { done: Promise<void>; unmount: () => void } | null = null;
    // Unmount the TUI before ShutdownManager writes its shutdown banner so
    // the two don't race on stdout / leave the terminal in alt-screen buffer.
    // `process.once` fires listeners in registration order, so this runs
    // before ShutdownManager's SIGINT handler registered inside run().
    const sigintHandler = (): void => {
      tuiHandle?.unmount();
    };
    process.once("SIGINT", sigintHandler);
    try {
      const result = await RunOrchestrator.run(
        {
          ...init,
          onProgress,
          onPhasePlan,
          phasePauseHandle: renderer ?? undefined,
          onOrchestratorReady: (orch) => {
            tuiHandle = renderTui(orch);
          },
        },
        issues,
        batches,
      );
      if (tuiHandle) {
        await (tuiHandle as { done: Promise<void> }).done;
      }
      displaySummary(result);
      if (result.exitCode !== 0) process.exit(result.exitCode);
      return;
    } finally {
      process.off("SIGINT", sigintHandler);
    }
  }

  // SIGINT handler: clear the live zone before ShutdownManager writes its
  // cleanup banner so the two don't collide. See AC-29.
  const sigintHandler = (): void => {
    renderer?.dispose();
  };
  if (renderer) process.once("SIGINT", sigintHandler);

  try {
    const result = await RunOrchestrator.run(
      {
        ...init,
        onProgress,
        onPhasePlan,
        phasePauseHandle: renderer ?? undefined,
      },
      issues,
      batches,
    );

    // Record PR info in renderer state before summary so done rows show PR #s.
    if (renderer) {
      for (const r of result.results) {
        if (r.prNumber && r.prUrl) {
          renderer.setPullRequest(r.issueNumber, r.prNumber, r.prUrl);
        }
      }
    }

    displaySummary(result, renderer);
    renderer?.dispose();
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } finally {
    heartbeat?.dispose();
    if (renderer) process.off("SIGINT", sigintHandler);
  }
}
