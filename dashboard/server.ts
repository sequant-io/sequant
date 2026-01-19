/**
 * Dashboard server for Sequant workflow visualization
 *
 * Uses Hono for the server, htmx for reactive updates, and Pico CSS for styling.
 * File watching via chokidar provides live state updates through SSE.
 *
 * @example
 * ```typescript
 * import { createDashboardServer, startDashboard } from './dashboard/server';
 *
 * // Start with defaults
 * await startDashboard();
 *
 * // Or create server for testing
 * const app = createDashboardServer({ statePath: '.sequant/state.json' });
 * ```
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import open from "open";
import {
  type WorkflowState,
  type IssueState,
  type Phase,
  WORKFLOW_PHASES,
  STATE_FILE_PATH,
} from "../src/lib/workflow/state-schema.js";

export interface DashboardOptions {
  /** Port to run on (default: 3456) */
  port?: number;
  /** Path to state.json (default: .sequant/state.json) */
  statePath?: string;
  /** Auto-open browser (default: true) */
  openBrowser?: boolean;
  /** Verbose logging (default: false) */
  verbose?: boolean;
}

interface SSEClient {
  id: string;
  send: (data: string) => void;
  close: () => void;
}

const clients = new Map<string, SSEClient>();
let watcher: chokidar.FSWatcher | null = null;

/**
 * Read and parse the state file
 */
function readStateFile(statePath: string): WorkflowState | null {
  try {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    const content = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(content) as WorkflowState;
  } catch {
    return null;
  }
}

/**
 * Get phase status class for styling
 */
function getPhaseClass(issue: IssueState, phase: Phase): string {
  const phaseState = issue.phases[phase];
  if (!phaseState) return "pending";
  return phaseState.status;
}

/**
 * Get phase status icon
 */
function getPhaseIcon(issue: IssueState, phase: Phase): string {
  const phaseState = issue.phases[phase];
  if (!phaseState) return "○";

  switch (phaseState.status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "●";
    case "failed":
      return "✗";
    case "skipped":
      return "−";
    default:
      return "○";
  }
}

/**
 * Get status badge color
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "in_progress":
      return "var(--pico-primary)";
    case "ready_for_merge":
      return "var(--pico-ins-color)";
    case "merged":
      return "var(--pico-color-green-550)";
    case "blocked":
      return "var(--pico-del-color)";
    case "abandoned":
      return "var(--pico-muted-color)";
    default:
      return "var(--pico-secondary)";
  }
}

/**
 * Render the main dashboard HTML
 */
function renderDashboard(state: WorkflowState | null): string {
  const issues = state ? Object.values(state.issues) : [];
  const sortedIssues = issues.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
  );

  const issueCards = sortedIssues
    .map((issue) => renderIssueCard(issue))
    .join("");

  const emptyState = `
    <article>
      <header>
        <h3>No Issues Tracked</h3>
      </header>
      <p>Run <code>sequant run &lt;issue&gt;</code> to start tracking workflow progress.</p>
    </article>
  `;

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sequant Dashboard</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
  <script src="https://unpkg.com/htmx.org@1.9.10/dist/ext/sse.js"></script>
  <style>
    :root {
      --phase-pending: var(--pico-secondary);
      --phase-in_progress: var(--pico-primary);
      --phase-completed: var(--pico-ins-color);
      --phase-failed: var(--pico-del-color);
      --phase-skipped: var(--pico-muted-color);
    }

    .header-bar {
      background: var(--pico-background-color);
      border-bottom: 1px solid var(--pico-muted-border-color);
      padding: 1rem 0;
      margin-bottom: 2rem;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 1280px;
      margin: 0 auto;
      padding: 0 1rem;
    }

    .header-title {
      margin: 0;
      font-size: 1.5rem;
    }

    .header-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--pico-muted-color);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--pico-ins-color);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .issue-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 1.5rem;
    }

    .issue-card {
      margin: 0;
    }

    .issue-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0;
    }

    .issue-number {
      font-weight: bold;
      color: var(--pico-primary);
    }

    .issue-title {
      margin: 0.5rem 0 1rem;
      font-size: 1rem;
      font-weight: 500;
    }

    .status-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: var(--pico-border-radius);
      text-transform: uppercase;
      font-weight: 600;
    }

    .phase-bar {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;
    }

    .phase-item {
      flex: 1;
      text-align: center;
      padding: 0.5rem 0.25rem;
      border-radius: var(--pico-border-radius);
      font-size: 0.75rem;
      transition: all 0.2s;
    }

    .phase-item.pending {
      background: var(--pico-secondary-background);
      color: var(--pico-secondary);
    }

    .phase-item.in_progress {
      background: color-mix(in srgb, var(--pico-primary) 20%, transparent);
      color: var(--pico-primary);
      font-weight: 600;
    }

    .phase-item.completed {
      background: color-mix(in srgb, var(--pico-ins-color) 20%, transparent);
      color: var(--pico-ins-color);
    }

    .phase-item.failed {
      background: color-mix(in srgb, var(--pico-del-color) 20%, transparent);
      color: var(--pico-del-color);
    }

    .phase-item.skipped {
      background: var(--pico-secondary-background);
      color: var(--pico-muted-color);
      text-decoration: line-through;
    }

    .phase-icon {
      display: block;
      font-size: 1rem;
      margin-bottom: 0.25rem;
    }

    .phase-label {
      display: block;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--pico-muted-color);
      margin-top: 1rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--pico-muted-border-color);
    }

    .pr-link {
      color: var(--pico-primary);
    }

    .summary-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .summary-card {
      text-align: center;
      padding: 1rem;
      background: var(--pico-card-background-color);
      border-radius: var(--pico-border-radius);
      border: 1px solid var(--pico-muted-border-color);
    }

    .summary-value {
      font-size: 2rem;
      font-weight: bold;
      color: var(--pico-primary);
    }

    .summary-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--pico-muted-color);
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0 1rem 2rem;
    }
  </style>
</head>
<body hx-ext="sse" sse-connect="/events" sse-swap="state-update">
  <header class="header-bar">
    <div class="header-content">
      <h1 class="header-title">⚗️ Sequant Dashboard</h1>
      <div class="header-status">
        <span class="status-dot"></span>
        <span>Live</span>
      </div>
    </div>
  </header>

  <main class="container" id="dashboard-content">
    ${renderSummary(sortedIssues)}
    <div class="issue-grid" id="issue-list">
      ${issueCards || emptyState}
    </div>
  </main>

  <script>
    // Handle theme toggle
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    if (prefersDark.matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    prefersDark.addEventListener('change', (e) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    });
  </script>
</body>
</html>`;
}

/**
 * Render summary cards
 */
function renderSummary(issues: IssueState[]): string {
  const total = issues.length;
  const inProgress = issues.filter((i) => i.status === "in_progress").length;
  const readyForMerge = issues.filter(
    (i) => i.status === "ready_for_merge",
  ).length;
  const blocked = issues.filter((i) => i.status === "blocked").length;

  return `
    <div class="summary-cards">
      <div class="summary-card">
        <div class="summary-value">${total}</div>
        <div class="summary-label">Total Issues</div>
      </div>
      <div class="summary-card">
        <div class="summary-value">${inProgress}</div>
        <div class="summary-label">In Progress</div>
      </div>
      <div class="summary-card">
        <div class="summary-value">${readyForMerge}</div>
        <div class="summary-label">Ready to Merge</div>
      </div>
      <div class="summary-card">
        <div class="summary-value">${blocked}</div>
        <div class="summary-label">Blocked</div>
      </div>
    </div>
  `;
}

/**
 * Render a single issue card
 */
function renderIssueCard(issue: IssueState): string {
  const phases = WORKFLOW_PHASES.filter(
    (p) => p !== "security-review" && p !== "loop",
  ); // Show main phases

  const phaseItems = phases
    .map(
      (phase) => `
      <div class="phase-item ${getPhaseClass(issue, phase)}">
        <span class="phase-icon">${getPhaseIcon(issue, phase)}</span>
        <span class="phase-label">${phase}</span>
      </div>
    `,
    )
    .join("");

  const lastActivity = new Date(issue.lastActivity).toLocaleString();
  const prLink = issue.pr
    ? `<a href="${issue.pr.url}" class="pr-link" target="_blank">PR #${issue.pr.number}</a>`
    : "No PR";

  return `
    <article class="issue-card">
      <div class="issue-header">
        <span class="issue-number">#${issue.number}</span>
        <span class="status-badge" style="background: ${getStatusColor(issue.status)}; color: white;">
          ${issue.status.replace(/_/g, " ")}
        </span>
      </div>
      <h3 class="issue-title">${escapeHtml(issue.title)}</h3>
      <div class="phase-bar">
        ${phaseItems}
      </div>
      <div class="meta-row">
        <span>${prLink}</span>
        <span title="${lastActivity}">Updated ${formatRelativeTime(issue.lastActivity)}</span>
      </div>
    </article>
  `;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format relative time
 */
function formatRelativeTime(isoDate: string): string {
  const now = new Date();
  const date = new Date(isoDate);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

/**
 * Create the Hono dashboard server
 */
export function createDashboardServer(options: DashboardOptions = {}): Hono {
  const statePath = options.statePath ?? STATE_FILE_PATH;
  const verbose = options.verbose ?? false;

  const app = new Hono();

  // Static files
  app.use("/public/*", serveStatic({ root: "./dashboard" }));

  // Main dashboard route
  app.get("/", (c) => {
    const state = readStateFile(statePath);
    return c.html(renderDashboard(state));
  });

  // API endpoint for current state (JSON)
  app.get("/api/state", (c) => {
    const state = readStateFile(statePath);
    return c.json(state ?? { version: 1, lastUpdated: null, issues: {} });
  });

  // SSE endpoint for live updates
  app.get("/events", async (c) => {
    return streamSSE(c, async (stream) => {
      const clientId = crypto.randomUUID();

      if (verbose) {
        console.log(`[Dashboard] SSE client connected: ${clientId}`);
      }

      // Store client for broadcasting
      clients.set(clientId, {
        id: clientId,
        send: (data: string) => {
          stream.writeSSE({ event: "state-update", data });
        },
        close: () => {
          // Handled by stream end
        },
      });

      // Send initial state
      const state = readStateFile(statePath);
      const content = renderDashboard(state);
      await stream.writeSSE({
        event: "state-update",
        data: content,
      });

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({ event: "heartbeat", data: "ping" });
        } catch {
          // Connection closed
          clearInterval(heartbeat);
        }
      }, 30000);

      // Cleanup on disconnect
      stream.onAbort(() => {
        if (verbose) {
          console.log(`[Dashboard] SSE client disconnected: ${clientId}`);
        }
        clients.delete(clientId);
        clearInterval(heartbeat);
      });

      // Keep the stream open
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
  });

  // Partial endpoint for htmx swaps
  app.get("/partials/issues", (c) => {
    const state = readStateFile(statePath);
    const issues = state ? Object.values(state.issues) : [];
    const sortedIssues = issues.sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    );

    const issueCards = sortedIssues
      .map((issue) => renderIssueCard(issue))
      .join("");

    const emptyState = `
      <article>
        <header>
          <h3>No Issues Tracked</h3>
        </header>
        <p>Run <code>sequant run &lt;issue&gt;</code> to start tracking workflow progress.</p>
      </article>
    `;

    return c.html(`
      ${renderSummary(sortedIssues)}
      <div class="issue-grid" id="issue-list">
        ${issueCards || emptyState}
      </div>
    `);
  });

  return app;
}

/**
 * Broadcast state update to all connected SSE clients
 */
function broadcastStateUpdate(statePath: string): void {
  const state = readStateFile(statePath);
  const content = renderDashboard(state);

  for (const client of clients.values()) {
    try {
      client.send(content);
    } catch {
      // Client disconnected
      clients.delete(client.id);
    }
  }
}

/**
 * Start the dashboard server with file watching
 */
export async function startDashboard(
  options: DashboardOptions = {},
): Promise<void> {
  const port = options.port ?? 3456;
  const statePath = options.statePath ?? STATE_FILE_PATH;
  const openBrowser = options.openBrowser ?? true;
  const verbose = options.verbose ?? false;

  const app = createDashboardServer(options);

  // Start file watcher
  const stateDir = path.dirname(statePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  watcher = chokidar.watch(statePath, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("change", () => {
    if (verbose) {
      console.log("[Dashboard] State file changed, broadcasting update");
    }
    broadcastStateUpdate(statePath);
  });

  watcher.on("add", () => {
    if (verbose) {
      console.log("[Dashboard] State file created, broadcasting update");
    }
    broadcastStateUpdate(statePath);
  });

  // Start server
  console.log(`\n⚗️  Sequant Dashboard starting on http://localhost:${port}\n`);

  serve({
    fetch: app.fetch,
    port,
  });

  if (openBrowser) {
    await open(`http://localhost:${port}`);
  }

  console.log("Press Ctrl+C to stop\n");

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("\n[Dashboard] Shutting down...");
    if (watcher) {
      watcher.close();
    }
    process.exit(0);
  });
}

/**
 * Stop the dashboard (for testing)
 */
export function stopDashboard(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  clients.clear();
}
