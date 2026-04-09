/** sequant run — Thin CLI adapter that delegates to RunOrchestrator. */

import chalk from "chalk";
import { getManifest } from "../lib/manifest.js";
import { formatElapsedTime } from "../lib/phase-spinner.js";
import { getSettings } from "../lib/settings.js";
import type { RunOptions } from "../lib/workflow/types.js";
import { checkVersionCached, getVersionWarning } from "../lib/version-check.js";
import { ui, colors } from "../lib/cli-ui.js";
import { formatDuration } from "../lib/workflow/phase-executor.js";
import { parseBatches } from "../lib/workflow/batch-executor.js";
import { RunOrchestrator } from "../lib/workflow/run-orchestrator.js";
import type { RunResult } from "../lib/workflow/run-orchestrator.js";
import { analyzeRun, formatReflection } from "../lib/workflow/run-reflect.js";

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

  console.log(chalk.gray(`  ${"Stack".padEnd(15)}${manifest.stack}`));

  const onProgress = !options.quiet
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

  const result = await RunOrchestrator.run(
    {
      options,
      settings,
      manifest: {
        stack: manifest.stack,
        packageManager: manifest.packageManager ?? "npm",
      },
      onProgress,
    },
    issues,
    batches,
  );

  displaySummary(result);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

function displaySummary(result: RunResult): void {
  const { results, logPath, config, mergedOptions } = result;
  if (results.length === 0) return;

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log("\n" + ui.divider());
  console.log(colors.info("  Summary"));
  console.log(ui.divider());
  console.log(
    `\n  ${colors.success(`${passed} passed`)} ${colors.muted("·")} ${colors.error(`${failed} failed`)}`,
  );
  for (const r of results) {
    const status = r.success
      ? ui.statusIcon("success")
      : ui.statusIcon("error");
    const duration = r.durationSeconds
      ? colors.muted(` (${formatDuration(r.durationSeconds)})`)
      : "";
    const phases = r.phaseResults
      .map((p) => (p.success ? colors.success(p.phase) : colors.error(p.phase)))
      .join(" → ");
    const loopInfo = r.loopTriggered ? colors.warning(" [loop]") : "";
    const prInfo = r.prUrl ? colors.muted(` → PR #${r.prNumber}`) : "";
    console.log(
      `  ${status} #${r.issueNumber}: ${phases}${loopInfo}${prInfo}${duration}`,
    );
  }
  console.log("");
  if (logPath) {
    console.log(colors.muted(`  Log: ${logPath}`));
    console.log("");
  }
  if (mergedOptions.reflect && results.length > 0) {
    const reflection = analyzeRun({
      results,
      issueInfoMap: result.issueInfoMap,
      runLog: result.logWriter?.getRunLog() ?? null,
      config: { phases: config.phases, qualityLoop: config.qualityLoop },
    });
    const reflectionOutput = formatReflection(reflection);
    if (reflectionOutput) {
      console.log(reflectionOutput);
      console.log("");
    }
  }
  if (results.length > 1 && passed > 0 && !config.dryRun) {
    console.log(
      colors.muted("  Tip: Verify batch integration before merging:"),
    );
    console.log(colors.muted("     sequant merge --check"));
    console.log("");
  }
  if (config.dryRun) {
    console.log(
      colors.warning(
        "  ℹ️  This was a dry run. Use without --dry-run to execute.",
      ),
    );
    console.log("");
  }
}
