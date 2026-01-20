/**
 * Sequant Explorer VS Code Extension
 *
 * Provides a tree view of tracked issues and their workflow phases.
 * Watches .sequant/state.json for changes and updates the view.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/** Workflow phases */
type Phase =
  | "spec"
  | "security-review"
  | "exec"
  | "testgen"
  | "test"
  | "qa"
  | "loop";
type PhaseStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";
type IssueStatus =
  | "not_started"
  | "in_progress"
  | "ready_for_merge"
  | "merged"
  | "blocked"
  | "abandoned";

interface PhaseState {
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  iteration?: number;
}

interface PRInfo {
  number: number;
  url: string;
}

interface IssueState {
  number: number;
  title: string;
  status: IssueStatus;
  worktree?: string;
  branch?: string;
  currentPhase?: Phase;
  phases: Record<string, PhaseState>;
  pr?: PRInfo;
  lastActivity: string;
  createdAt: string;
}

interface WorkflowState {
  version: number;
  lastUpdated: string;
  issues: Record<string, IssueState>;
}

/**
 * Tree item representing an issue or phase
 */
class SequantTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly issue?: IssueState,
    public readonly phase?: Phase,
    public readonly phaseState?: PhaseState,
  ) {
    super(label, collapsibleState);
    this.contextValue = issue && !phase ? "issue" : "phase";
  }
}

/**
 * Tree data provider for the Sequant Explorer view
 */
class SequantTreeDataProvider implements vscode.TreeDataProvider<SequantTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SequantTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: WorkflowState | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(private workspaceRoot: string) {
    this.loadState();
    this.setupWatcher();
  }

  /**
   * Load state from .sequant/state.json
   */
  private loadState(): void {
    const statePath = path.join(this.workspaceRoot, ".sequant", "state.json");
    try {
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, "utf-8");
        this.state = JSON.parse(content) as WorkflowState;
      } else {
        this.state = null;
      }
    } catch {
      this.state = null;
    }
  }

  /**
   * Set up file watcher for state changes
   */
  private setupWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      ".sequant/state.json",
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange(() => {
      this.loadState();
      this._onDidChangeTreeData.fire();
    });

    this.watcher.onDidCreate(() => {
      this.loadState();
      this._onDidChangeTreeData.fire();
    });

    this.watcher.onDidDelete(() => {
      this.state = null;
      this._onDidChangeTreeData.fire();
    });
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this.loadState();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.watcher?.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: SequantTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for a tree element
   */
  getChildren(element?: SequantTreeItem): Thenable<SequantTreeItem[]> {
    if (!this.state) {
      return Promise.resolve([]);
    }

    // Root level: show issues
    if (!element) {
      return Promise.resolve(this.getIssueItems());
    }

    // Issue level: show phases
    if (element.issue && !element.phase) {
      return Promise.resolve(this.getPhaseItems(element.issue));
    }

    return Promise.resolve([]);
  }

  /**
   * Get issue tree items
   */
  private getIssueItems(): SequantTreeItem[] {
    if (!this.state) {
      return [];
    }

    const issues = Object.values(this.state.issues);

    // Sort by status priority, then by last activity
    const statusOrder: IssueStatus[] = [
      "in_progress",
      "ready_for_merge",
      "blocked",
      "not_started",
      "merged",
      "abandoned",
    ];

    issues.sort((a, b) => {
      const orderA = statusOrder.indexOf(a.status);
      const orderB = statusOrder.indexOf(b.status);
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    return issues.map((issue) => {
      const item = new SequantTreeItem(
        `#${issue.number}: ${issue.title}`,
        vscode.TreeItemCollapsibleState.Collapsed,
        issue,
      );

      // Set icon based on status
      item.iconPath = this.getStatusIcon(issue.status);

      // Set description with status
      item.description = this.formatStatus(issue.status);

      // Set tooltip with more details
      item.tooltip = new vscode.MarkdownString();
      item.tooltip.appendMarkdown(`**#${issue.number}**: ${issue.title}\n\n`);
      item.tooltip.appendMarkdown(
        `**Status:** ${this.formatStatus(issue.status)}\n\n`,
      );
      if (issue.currentPhase) {
        item.tooltip.appendMarkdown(
          `**Current Phase:** ${issue.currentPhase}\n\n`,
        );
      }
      if (issue.worktree) {
        item.tooltip.appendMarkdown(`**Worktree:** \`${issue.worktree}\`\n\n`);
      }
      if (issue.pr) {
        item.tooltip.appendMarkdown(
          `**PR:** [#${issue.pr.number}](${issue.pr.url})\n\n`,
        );
      }
      item.tooltip.appendMarkdown(
        `**Last Activity:** ${this.getRelativeTime(issue.lastActivity)}`,
      );

      return item;
    });
  }

  /**
   * Get phase tree items for an issue
   */
  private getPhaseItems(issue: IssueState): SequantTreeItem[] {
    const phases: Phase[] = [
      "spec",
      "security-review",
      "exec",
      "testgen",
      "test",
      "qa",
      "loop",
    ];

    return phases.map((phase) => {
      const phaseState = issue.phases[phase] as PhaseState | undefined;
      const status = phaseState?.status ?? "pending";

      const item = new SequantTreeItem(
        this.formatPhaseName(phase),
        vscode.TreeItemCollapsibleState.None,
        issue,
        phase,
        phaseState,
      );

      // Set icon based on phase status
      item.iconPath = this.getPhaseIcon(status);

      // Set description
      item.description = this.formatPhaseStatus(status);

      // Set tooltip
      if (phaseState) {
        item.tooltip = new vscode.MarkdownString();
        item.tooltip.appendMarkdown(`**${this.formatPhaseName(phase)}**\n\n`);
        item.tooltip.appendMarkdown(
          `**Status:** ${this.formatPhaseStatus(status)}\n\n`,
        );
        if (phaseState.startedAt) {
          item.tooltip.appendMarkdown(
            `**Started:** ${this.getRelativeTime(phaseState.startedAt)}\n\n`,
          );
        }
        if (phaseState.completedAt) {
          item.tooltip.appendMarkdown(
            `**Completed:** ${this.getRelativeTime(phaseState.completedAt)}\n\n`,
          );
        }
        if (phaseState.error) {
          item.tooltip.appendMarkdown(`**Error:** ${phaseState.error}`);
        }
      }

      return item;
    });
  }

  /**
   * Get icon for issue status
   */
  private getStatusIcon(status: IssueStatus): vscode.ThemeIcon {
    switch (status) {
      case "in_progress":
        return new vscode.ThemeIcon(
          "sync~spin",
          new vscode.ThemeColor("charts.blue"),
        );
      case "ready_for_merge":
        return new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green"),
        );
      case "merged":
        return new vscode.ThemeIcon(
          "git-merge",
          new vscode.ThemeColor("charts.green"),
        );
      case "blocked":
        return new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("charts.yellow"),
        );
      case "abandoned":
        return new vscode.ThemeIcon(
          "close",
          new vscode.ThemeColor("charts.red"),
        );
      default:
        return new vscode.ThemeIcon("circle-outline");
    }
  }

  /**
   * Get icon for phase status
   */
  private getPhaseIcon(status: PhaseStatus): vscode.ThemeIcon {
    switch (status) {
      case "in_progress":
        return new vscode.ThemeIcon(
          "loading~spin",
          new vscode.ThemeColor("charts.blue"),
        );
      case "completed":
        return new vscode.ThemeIcon(
          "pass-filled",
          new vscode.ThemeColor("charts.green"),
        );
      case "failed":
        return new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("charts.red"),
        );
      case "skipped":
        return new vscode.ThemeIcon("dash");
      default:
        return new vscode.ThemeIcon("circle-outline");
    }
  }

  /**
   * Format status for display
   */
  private formatStatus(status: IssueStatus): string {
    return status.replace(/_/g, " ");
  }

  /**
   * Format phase status for display
   */
  private formatPhaseStatus(status: PhaseStatus): string {
    return status.replace(/_/g, " ");
  }

  /**
   * Format phase name for display
   */
  private formatPhaseName(phase: Phase): string {
    const names: Record<Phase, string> = {
      spec: "Spec",
      "security-review": "Security Review",
      exec: "Execute",
      testgen: "Test Generation",
      test: "Test",
      qa: "QA",
      loop: "Quality Loop",
    };
    return names[phase];
  }

  /**
   * Get relative time string
   */
  private getRelativeTime(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) {
      return "just now";
    }
    if (diffMin < 60) {
      return `${diffMin}m ago`;
    }
    if (diffHour < 24) {
      return `${diffHour}h ago`;
    }
    if (diffDay < 7) {
      return `${diffDay}d ago`;
    }
    return date.toLocaleDateString();
  }

  /**
   * Get the issue at a tree item
   */
  getIssue(item: SequantTreeItem): IssueState | undefined {
    return item.issue;
  }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspaceRoot) {
    return;
  }

  // Create tree data provider
  const treeDataProvider = new SequantTreeDataProvider(workspaceRoot);

  // Register tree view
  const treeView = vscode.window.createTreeView("sequantIssues", {
    treeDataProvider,
    showCollapseAll: true,
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("sequant.refresh", () => {
      treeDataProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sequant.openWorktree",
      (item: SequantTreeItem) => {
        const issue = treeDataProvider.getIssue(item);
        if (issue?.worktree) {
          const terminal = vscode.window.createTerminal({
            name: `Issue #${issue.number}`,
            cwd: issue.worktree,
          });
          terminal.show();
        } else {
          vscode.window.showWarningMessage("No worktree found for this issue");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sequant.openInBrowser",
      async (item: SequantTreeItem) => {
        const issue = treeDataProvider.getIssue(item);
        if (issue) {
          // Try to get the repository URL from git
          const gitExtension = vscode.extensions.getExtension("vscode.git");
          if (gitExtension) {
            const git = gitExtension.exports.getAPI(1);
            const repo = git.repositories[0];
            if (repo) {
              const remotes = repo.state.remotes;
              const origin = remotes.find(
                (r: { name: string }) => r.name === "origin",
              );
              if (origin?.fetchUrl) {
                // Parse GitHub URL from remote
                const match = origin.fetchUrl.match(
                  /github\.com[:/](.+?)(?:\.git)?$/,
                );
                if (match) {
                  const url = `https://github.com/${match[1]}/issues/${issue.number}`;
                  await vscode.env.openExternal(vscode.Uri.parse(url));
                  return;
                }
              }
            }
          }
          vscode.window.showWarningMessage(
            "Could not determine GitHub URL for this issue",
          );
        }
      },
    ),
  );

  // Clean up
  context.subscriptions.push(treeView);
  context.subscriptions.push({
    dispose: () => treeDataProvider.dispose(),
  });
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // Cleanup handled by disposables
}
