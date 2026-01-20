/**
 * Dashboard Command
 *
 * Launches a local web dashboard for visualizing workflow state.
 * Uses Hono + htmx + Pico CSS with SSE for live updates.
 */

import chalk from "chalk";
import { startDashboard } from "../../dashboard/server.js";

export interface DashboardOptions {
  port?: number;
  noOpen?: boolean;
  verbose?: boolean;
}

export async function dashboardCommand(
  options: DashboardOptions,
): Promise<void> {
  const port = options.port ?? 3456;
  const open = !options.noOpen;
  const verbose = options.verbose ?? false;

  console.log(chalk.cyan("\n📊 Starting Sequant Dashboard...\n"));

  try {
    const server = await startDashboard({ port, open, verbose });

    // Handle graceful shutdown
    const shutdown = () => {
      console.log(chalk.yellow("\n\nShutting down dashboard..."));
      server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep process alive
    console.log(chalk.dim("Press Ctrl+C to stop the server\n"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("EADDRINUSE")) {
      console.error(
        chalk.red(`\n❌ Port ${port} is already in use.\n`) +
          chalk.dim(`   Try: sequant dashboard --port ${port + 1}\n`),
      );
      process.exit(1);
    }
    throw error;
  }
}
