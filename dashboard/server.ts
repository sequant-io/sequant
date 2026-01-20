/**
 * Sequant Dashboard Server
 *
 * A lightweight web dashboard for visualizing workflow state using:
 * - Hono: Fast, lightweight web framework
 * - htmx: HTML-first interactivity
 * - Pico CSS: Classless styling
 * - SSE: Server-sent events for live updates
 *
 * @example
 * ```typescript
 * import { startDashboard } from './server';
 * await startDashboard({ port: 3456, open: true });
 * ```
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { watch } from "chokidar";
import { StateManager } from "../src/lib/workflow/state-manager.js";
import type {
  IssueState,
  IssueStatus,
  Phase,
  PhaseStatus,
} from "../src/lib/workflow/state-schema.js";
import { STATE_FILE_PATH } from "../src/lib/workflow/state-schema.js";
import * as fs from "fs";

export interface DashboardOptions {
  /** Port to run the server on (default: 3456) */
  port?: number;
  /** Whether to open browser automatically (default: true) */
  open?: boolean;
  /** Custom state file path */
  statePath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/** SSE client callback type */
type SSECallback = (html: string) => void;

/** Connected SSE clients */
const clients: Set<SSECallback> = new Set();

/**
 * Escape HTML entities to prevent XSS
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
 * Get CSS class for issue status
 */
function getStatusClass(status: IssueStatus): string {
  switch (status) {
    case "in_progress":
      return "primary";
    case "waiting_for_qa_gate":
      return "warning";
    case "ready_for_merge":
      return "success";
    case "blocked":
      return "warning";
    case "merged":
      return "success";
    case "abandoned":
      return "error";
    default:
      return "secondary";
  }
}

/**
 * Get phase indicator HTML
 */
function getPhaseIndicator(
  phaseState: { status: PhaseStatus } | undefined,
): string {
  if (!phaseState) {
    return '<span class="phase-dot pending" title="Pending">○</span>';
  }

  switch (phaseState.status) {
    case "pending":
      return '<span class="phase-dot pending" title="Pending">○</span>';
    case "in_progress":
      return '<span class="phase-dot in-progress" title="In Progress">◐</span>';
    case "completed":
      return '<span class="phase-dot completed" title="Completed">●</span>';
    case "failed":
      return '<span class="phase-dot failed" title="Failed">✗</span>';
    case "skipped":
      return '<span class="phase-dot skipped" title="Skipped">-</span>';
    default:
      return '<span class="phase-dot" title="Unknown">?</span>';
  }
}

/**
 * Format relative time
 */
function getRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

/**
 * Render a single issue card as HTML
 */
function renderIssueCard(issue: IssueState): string {
  const phases: Phase[] = [
    "spec",
    "security-review",
    "exec",
    "testgen",
    "test",
    "verify",
    "qa",
    "loop",
    "merger",
  ];
  const phaseLabels: Record<Phase, string> = {
    spec: "Spec",
    "security-review": "Sec",
    exec: "Exec",
    testgen: "TGen",
    test: "Test",
    verify: "Ver",
    qa: "QA",
    loop: "Loop",
    merger: "Merge",
  };

  const phaseIndicators = phases
    .map((p) => {
      const indicator = getPhaseIndicator(
        issue.phases[p] as { status: PhaseStatus } | undefined,
      );
      return `<span class="phase-item" title="${phaseLabels[p]}">${indicator}<span class="phase-label">${phaseLabels[p]}</span></span>`;
    })
    .join("");

  const statusClass = getStatusClass(issue.status);
  const statusText = issue.status.replace(/_/g, " ");
  const title = escapeHtml(
    issue.title.length > 50 ? issue.title.slice(0, 50) + "..." : issue.title,
  );
  const relativeTime = getRelativeTime(issue.lastActivity);

  let prInfo = "";
  if (issue.pr) {
    prInfo = `<a href="${escapeHtml(issue.pr.url)}" target="_blank" class="pr-link">PR #${issue.pr.number}</a>`;
  }

  let worktreeInfo = "";
  if (issue.worktree) {
    const shortPath =
      issue.worktree.length > 40
        ? "..." + issue.worktree.slice(-37)
        : issue.worktree;
    worktreeInfo = `<span class="worktree" title="${escapeHtml(issue.worktree)}">${escapeHtml(shortPath)}</span>`;
  }

  return `
    <article class="issue-card" data-issue="${issue.number}" data-status="${issue.status}">
      <header>
        <h3>#${issue.number}: ${title}</h3>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </header>
      <div class="phases">
        ${phaseIndicators}
      </div>
      <footer>
        <div class="meta">
          ${prInfo}
          ${worktreeInfo}
        </div>
        <small class="last-activity">${relativeTime}</small>
      </footer>
    </article>
  `;
}

/**
 * Render the issues list partial
 */
function renderIssuesList(issues: IssueState[]): string {
  if (issues.length === 0) {
    return `
      <div class="empty-state">
        <p>No issues being tracked.</p>
        <p><small>Run <code>sequant run &lt;issue&gt;</code> to start tracking.</small></p>
      </div>
    `;
  }

  // Group by status
  const byStatus: Record<IssueStatus, IssueState[]> = {
    in_progress: [],
    waiting_for_qa_gate: [],
    ready_for_merge: [],
    blocked: [],
    not_started: [],
    merged: [],
    abandoned: [],
  };

  for (const issue of issues) {
    byStatus[issue.status].push(issue);
  }

  // Sort each group by last activity
  for (const status of Object.keys(byStatus) as IssueStatus[]) {
    byStatus[status].sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    );
  }

  // Render in priority order
  const statusOrder: IssueStatus[] = [
    "in_progress",
    "waiting_for_qa_gate",
    "ready_for_merge",
    "blocked",
    "not_started",
    "merged",
    "abandoned",
  ];

  let html = '<div class="issues-grid">';
  for (const status of statusOrder) {
    for (const issue of byStatus[status]) {
      html += renderIssueCard(issue);
    }
  }
  html += "</div>";

  // Summary stats
  const total = issues.length;
  const inProgress = byStatus.in_progress.length;
  const qaGate = byStatus.waiting_for_qa_gate.length;
  const ready = byStatus.ready_for_merge.length;
  const blocked = byStatus.blocked.length;

  html += `
    <div class="summary">
      <span>Total: ${total}</span>
      ${inProgress > 0 ? `<span class="stat primary">In Progress: ${inProgress}</span>` : ""}
      ${qaGate > 0 ? `<span class="stat warning">QA Gate: ${qaGate}</span>` : ""}
      ${ready > 0 ? `<span class="stat success">Ready: ${ready}</span>` : ""}
      ${blocked > 0 ? `<span class="stat warning">Blocked: ${blocked}</span>` : ""}
    </div>
  `;

  return html;
}

/**
 * Render the main page HTML
 */
function renderMainPage(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sequant Dashboard</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  <script src="https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js"></script>
  <script src="https://unpkg.com/htmx.org@1.9.12/dist/ext/sse.js"></script>
  <style>
    :root {
      --pico-font-size: 15px;
    }

    body {
      padding: 1rem 2rem;
    }

    header.page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--pico-muted-border-color);
    }

    header.page-header h1 {
      margin: 0;
      font-size: 1.5rem;
    }

    .connection-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--pico-muted-color);
    }

    .connection-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--pico-del-color);
    }

    .connection-dot.connected {
      background: var(--pico-ins-color);
    }

    .issues-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 1rem;
    }

    .issue-card {
      margin: 0;
      padding: 1rem;
    }

    .issue-card header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      padding: 0;
      border: none;
    }

    .issue-card header h3 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
    }

    .status-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      white-space: nowrap;
      text-transform: capitalize;
    }

    .status-badge.primary { background: var(--pico-primary-background); color: var(--pico-primary-inverse); }
    .status-badge.success { background: var(--pico-ins-color); color: var(--pico-background-color); }
    .status-badge.warning { background: var(--pico-mark-background-color); color: var(--pico-color); }
    .status-badge.error { background: var(--pico-del-color); color: white; }
    .status-badge.secondary { background: var(--pico-secondary-background); color: var(--pico-secondary-inverse); }

    .phases {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
    }

    .phase-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      font-size: 0.875rem;
    }

    .phase-dot {
      font-size: 1rem;
    }

    .phase-dot.pending { color: var(--pico-muted-color); }
    .phase-dot.in-progress { color: var(--pico-primary); }
    .phase-dot.completed { color: var(--pico-ins-color); }
    .phase-dot.failed { color: var(--pico-del-color); }
    .phase-dot.skipped { color: var(--pico-muted-color); }

    .phase-label {
      font-size: 0.625rem;
      color: var(--pico-muted-color);
      text-transform: uppercase;
    }

    .issue-card footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0;
      border: none;
      background: none;
      font-size: 0.75rem;
    }

    .issue-card footer .meta {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .pr-link {
      color: var(--pico-primary);
    }

    .worktree {
      color: var(--pico-muted-color);
      font-family: var(--pico-font-family-monospace);
      font-size: 0.6875rem;
    }

    .last-activity {
      color: var(--pico-muted-color);
    }

    .summary {
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--pico-muted-border-color);
      display: flex;
      gap: 1.5rem;
      font-size: 0.875rem;
    }

    .summary .stat.primary { color: var(--pico-primary); }
    .summary .stat.success { color: var(--pico-ins-color); }
    .summary .stat.warning { color: var(--pico-mark-color); }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--pico-muted-color);
    }

    .empty-state code {
      font-size: 0.875rem;
    }

    #issues-container {
      min-height: 200px;
    }

    .htmx-settling .issue-card {
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <header class="page-header">
    <h1>Sequant Dashboard</h1>
    <div class="connection-status">
      <span class="connection-dot" id="connection-dot"></span>
      <span id="connection-text">Connecting...</span>
    </div>
  </header>

  <main
    id="issues-container"
    hx-ext="sse"
    sse-connect="/events"
    sse-swap="issues-update"
    hx-swap="innerHTML"
  >
    <div class="empty-state">
      <p>Loading...</p>
    </div>
  </main>

  <script>
    // SSE connection status
    document.body.addEventListener('htmx:sseOpen', function() {
      document.getElementById('connection-dot').classList.add('connected');
      document.getElementById('connection-text').textContent = 'Live';
    });

    document.body.addEventListener('htmx:sseError', function() {
      document.getElementById('connection-dot').classList.remove('connected');
      document.getElementById('connection-text').textContent = 'Disconnected';
    });

    document.body.addEventListener('htmx:sseClose', function() {
      document.getElementById('connection-dot').classList.remove('connected');
      document.getElementById('connection-text').textContent = 'Disconnected';
    });

    // Initial load
    htmx.ajax('GET', '/issues', '#issues-container');
  </script>
</body>
</html>`;
}

/**
 * Create the Hono app
 */
export function createApp(stateManager: StateManager): Hono {
  const app = new Hono();

  // Main page
  app.get("/", (c) => {
    return c.html(renderMainPage());
  });

  // Issues list partial (for htmx)
  app.get("/issues", async (c) => {
    try {
      const allIssues = await stateManager.getAllIssueStates();
      const issues = Object.values(allIssues);
      return c.html(renderIssuesList(issues));
    } catch (error) {
      return c.html(
        `<div class="empty-state"><p>Error loading state: ${escapeHtml(String(error))}</p></div>`,
      );
    }
  });

  // SSE endpoint for live updates
  app.get("/events", async (c) => {
    return streamSSE(c, async (stream) => {
      let isActive = true;
      let messageId = 0;

      // Callback to receive broadcast updates
      const onUpdate = (html: string) => {
        if (isActive) {
          stream
            .writeSSE({
              data: html.replace(/\n/g, ""),
              event: "issues-update",
              id: String(messageId++),
            })
            .catch(() => {
              isActive = false;
            });
        }
      };

      // Register client
      clients.add(onUpdate);

      // Handle client disconnect
      stream.onAbort(() => {
        isActive = false;
        clients.delete(onUpdate);
      });

      // Send initial data
      try {
        const allIssues = await stateManager.getAllIssueStates();
        const issues = Object.values(allIssues);
        const html = renderIssuesList(issues);
        await stream.writeSSE({
          data: html.replace(/\n/g, ""),
          event: "issues-update",
          id: String(messageId++),
        });
      } catch {
        // Ignore initial load errors
      }

      // Keep connection alive with heartbeat
      while (isActive) {
        await stream.sleep(30000);
      }

      // Cleanup
      clients.delete(onUpdate);
    });
  });

  // Health check
  app.get("/health", (c) => {
    return c.json({ status: "ok", clients: clients.size });
  });

  return app;
}

/**
 * Broadcast update to all connected SSE clients
 */
async function broadcastUpdate(stateManager: StateManager): Promise<void> {
  if (clients.size === 0) return;

  try {
    // Clear cache to get fresh state
    stateManager.clearCache();
    const allIssues = await stateManager.getAllIssueStates();
    const issues = Object.values(allIssues);
    const html = renderIssuesList(issues);

    // Notify all connected clients
    for (const callback of clients) {
      try {
        callback(html);
      } catch {
        // Client callback failed, will be cleaned up on disconnect
      }
    }
  } catch {
    // Ignore broadcast errors
  }
}

/**
 * Start the dashboard server
 */
export async function startDashboard(
  options: DashboardOptions = {},
): Promise<{ close: () => void }> {
  const port = options.port ?? 3456;
  const shouldOpen = options.open ?? true;
  const statePath = options.statePath ?? STATE_FILE_PATH;
  const verbose = options.verbose ?? false;

  const stateManager = new StateManager({ statePath, verbose });
  const app = createApp(stateManager);

  // Set up file watcher for state changes
  let watcher: ReturnType<typeof watch> | null = null;

  // Ensure parent directory exists for watching
  const stateDir = statePath.includes("/")
    ? statePath.slice(0, statePath.lastIndexOf("/"))
    : ".sequant";

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  watcher = watch(statePath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on("change", () => {
    if (verbose) {
      console.log("📊 State file changed, broadcasting update...");
    }
    broadcastUpdate(stateManager);
  });

  watcher.on("add", () => {
    if (verbose) {
      console.log("📊 State file created, broadcasting update...");
    }
    broadcastUpdate(stateManager);
  });

  // Start server
  const server = serve({
    fetch: app.fetch,
    port,
  });

  const url = `http://localhost:${port}`;
  console.log(`\n🚀 Sequant Dashboard running at ${url}\n`);

  // Open browser
  if (shouldOpen) {
    const openModule = await import("open");
    await openModule.default(url);
  }

  return {
    close: () => {
      if (watcher) {
        watcher.close();
      }
      server.close();
      console.log("\n👋 Dashboard server stopped\n");
    },
  };
}

// CLI entry point when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const port = args.includes("--port")
    ? parseInt(args[args.indexOf("--port") + 1], 10)
    : 3456;
  const noOpen = args.includes("--no-open");
  const verbose = args.includes("--verbose");

  startDashboard({ port, open: !noOpen, verbose }).catch((error) => {
    console.error("Failed to start dashboard:", error);
    process.exit(1);
  });
}
