/** sequant run — Thin CLI adapter that delegates to RunOrchestrator. */

import chalk from "chalk";
import { getManifest } from "../lib/manifest.js";
import { formatElapsedTime } from "../lib/phase-spinner.js";
import { getSettings } from "../lib/settings.js";
import type { RunOptions } from "../lib/workflow/types.js";
import { checkVersionCached, getVersionWarning } from "../lib/version-check.js";
import { ui, colors } from "../lib/cli-ui.js";
import { parseBatches } from "../lib/workflow/batch-executor.js";
import { RunOrchestrator } from "../lib/workflow/run-orchestrator.js";
import { displayConfig, displaySummary } from "./run-display.js";

// Re-export public API for backwards compatibility
export * from "./run-compat.js";

/** Parse CLI args → validate → delegate to RunOrchestrator.run() → display summary. */
export async function runCommand(
  issues: string[],
  options: RunOptions,
): Promise<void> {
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

  const tuiEnabled =
    Boolean(options.experimentalTui) && Boolean(process.stdout.isTTY);

  const onProgress =
    !options.quiet && !tuiEnabled
      ? (
          issue: number,
          phase: string,
          event: "start" | "complete" | "failed",
          extra?: { durationSeconds?: number },
        ) => {
          if (event === "start")
            console.log(`  ${colors.running("▸")} #${issue}  ${phase}`);
          else if (event === "complete") {
            const dur =
              extra?.durationSeconds != null
                ? `  ${formatElapsedTime(extra.durationSeconds)}`
                : "";
            console.log(`  ${colors.success("✔")} #${issue}  ${phase}${dur}`);
          } else console.log(`  ${colors.error("✖")} #${issue}  ${phase}`);
        }
      : undefined;

  if (tuiEnabled) {
    const { renderTui } = await import("../ui/tui/index.js");
    let tuiHandle: { done: Promise<void>; unmount: () => void } | null = null;
    const result = await RunOrchestrator.run(
      {
        ...init,
        onProgress,
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
  }

  const result = await RunOrchestrator.run(
    { ...init, onProgress },
    issues,
    batches,
  );

  displaySummary(result);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
