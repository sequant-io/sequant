/**
 * sequant dashboard - Visual workflow state dashboard
 *
 * Starts a local web server displaying workflow state in a browser-based
 * dashboard with live updates via SSE.
 *
 * @example
 * ```bash
 * sequant dashboard           # Start on default port 3456
 * sequant dashboard --port 8080  # Custom port
 * sequant dashboard --no-open    # Don't auto-open browser
 * ```
 */

import chalk from "chalk";

export interface DashboardCommandOptions {
  /** Port to run the server on */
  port?: number;
  /** Don't automatically open browser */
  noOpen?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Dashboard command handler
 */
export async function dashboardCommand(
  options: DashboardCommandOptions = {},
): Promise<void> {
  const port = options.port ?? 3456;
  const shouldOpen = !options.noOpen;
  const verbose = options.verbose ?? false;

  console.log(chalk.bold("\n📊 Sequant Dashboard\n"));

  try {
    // Dynamic import to avoid loading dashboard code unless needed
    const { startDashboard } = await import("../../dashboard/server.js");

    const server = await startDashboard({
      port,
      open: shouldOpen,
      verbose,
    });

    // Handle graceful shutdown
    const shutdown = () => {
      server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log(chalk.gray("Press Ctrl+C to stop the server\n"));
  } catch (error) {
    console.error(chalk.red(`\n✗ Failed to start dashboard: ${error}\n`));
    process.exit(1);
  }
}
