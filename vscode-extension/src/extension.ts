/**
 * Sequant Workflow VS Code Extension
 *
 * Provides a sidebar tree view showing all tracked issues
 * and their workflow phase status with live updates.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Types for state.json (simplified from main sequant types)
 */
interface PhaseState {
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface IssueState {
  number: number;
  title: string;
  status:
    | "not_started"
    | "in_progress"
    | "ready_for_merge"
    | "merged"
    | "blocked"
    | "abandoned";
  worktree?: string;
  branch?: string;
  currentPhase?: string;
  phases: Record<string, PhaseState>;
  pr?: { number: number; url: string };
  lastActivity: string;
}

interface WorkflowState {
  version: number;
  lastUpdated: string;
  issues: Record<string, IssueState>;
}

const WORKFLOW_PHASES = ["spec", "exec", "testgen", "test", "qa"] as const;

/**
 * Tree item representing an issue or phase
 */
class IssueTreeItem extends vscode.TreeItem {
  constructor(
    public readonly issue: IssueState,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(`#${issue.number} ${issue.title}`, collapsibleState);

    this.contextValue = "issue";
    this.description = this.getStatusLabel(issue.status);
    this.tooltip = this.buildTooltip();
    this.iconPath = this.getStatusIcon();
  }

  private getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      not_started: "Not Started",
      in_progress: "In Progress",
      ready_for_merge: "Ready for Merge",
      merged: "Merged",
      blocked: "Blocked",
      abandoned: "Abandoned",
    };
    return labels[status] ?? status;
  }

  private buildTooltip(): string {
    const lines = [
      `Issue #${this.issue.number}: ${this.issue.title}`,
      `Status: ${this.getStatusLabel(this.issue.status)}`,
      "",
      "Phases:",
    ];

    for (const phase of WORKFLOW_PHASES) {
      const phaseState = this.issue.phases[phase];
      const status = phaseState?.status ?? "pending";
      const icon = this.getPhaseIcon(status);
      lines.push(`  ${icon} ${phase}: ${status}`);
    }

    if (this.issue.worktree) {
      lines.push("", `Worktree: ${this.issue.worktree}`);
    }

    if (this.issue.pr) {
      lines.push(`PR: #${this.issue.pr.number}`);
    }

    return lines.join("\n");
  }

  private getPhaseIcon(status: string): string {
    switch (status) {
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

  private getStatusIcon(): vscode.ThemeIcon {
    switch (this.issue.status) {
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
          new vscode.ThemeColor("charts.purple"),
        );
      case "blocked":
        return new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("charts.orange"),
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
}

/**
 * Tree item representing a phase within an issue
 */
class PhaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly phase: string,
    public readonly phaseState: PhaseState | undefined,
  ) {
    super(phase, vscode.TreeItemCollapsibleState.None);

    const status = phaseState?.status ?? "pending";
    this.description = status;
    this.iconPath = this.getPhaseIcon(status);
    this.tooltip = this.buildTooltip();
  }

  private getPhaseIcon(status: string): vscode.ThemeIcon {
    switch (status) {
      case "completed":
        return new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green"),
        );
      case "in_progress":
        return new vscode.ThemeIcon(
          "sync~spin",
          new vscode.ThemeColor("charts.blue"),
        );
      case "failed":
        return new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("charts.red"),
        );
      case "skipped":
        return new vscode.ThemeIcon(
          "debug-step-over",
          new vscode.ThemeColor("charts.gray"),
        );
      default:
        return new vscode.ThemeIcon("circle-outline");
    }
  }

  private buildTooltip(): string {
    if (!this.phaseState) {
      return `${this.phase}: pending`;
    }

    const lines = [`${this.phase}: ${this.phaseState.status}`];

    if (this.phaseState.startedAt) {
      lines.push(
        `Started: ${new Date(this.phaseState.startedAt).toLocaleString()}`,
      );
    }

    if (this.phaseState.completedAt) {
      lines.push(
        `Completed: ${new Date(this.phaseState.completedAt).toLocaleString()}`,
      );
    }

    if (this.phaseState.error) {
      lines.push(`Error: ${this.phaseState.error}`);
    }

    return lines.join("\n");
  }
}

/**
 * Data provider for the issues tree view
 */
class IssuesProvider implements vscode.TreeDataProvider<
  IssueTreeItem | PhaseTreeItem
> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    IssueTreeItem | PhaseTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: WorkflowState | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(private workspaceRoot: string | undefined) {
    if (workspaceRoot) {
      this.setupWatcher();
    }
  }

  private setupWatcher(): void {
    const statePath = path.join(this.workspaceRoot!, ".sequant", "state.json");
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot!,
      ".sequant/state.json",
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidDelete(() => this.refresh());
  }

  refresh(): void {
    this.state = null; // Clear cache
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(
    element: IssueTreeItem | PhaseTreeItem,
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(
    element?: IssueTreeItem | PhaseTreeItem,
  ): vscode.ProviderResult<(IssueTreeItem | PhaseTreeItem)[]> {
    if (!this.workspaceRoot) {
      return [];
    }

    // Top level: show issues
    if (!element) {
      return this.getIssues();
    }

    // Under an issue: show phases
    if (element instanceof IssueTreeItem) {
      return this.getPhases(element.issue);
    }

    return [];
  }

  private getState(): WorkflowState | null {
    if (this.state) {
      return this.state;
    }

    const statePath = path.join(this.workspaceRoot!, ".sequant", "state.json");

    try {
      if (!fs.existsSync(statePath)) {
        return null;
      }

      const content = fs.readFileSync(statePath, "utf-8");
      this.state = JSON.parse(content) as WorkflowState;
      return this.state;
    } catch {
      return null;
    }
  }

  private getIssues(): IssueTreeItem[] {
    const state = this.getState();
    if (!state) {
      return [];
    }

    const issues = Object.values(state.issues);

    // Sort by last activity (most recent first)
    issues.sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    );

    return issues.map(
      (issue) =>
        new IssueTreeItem(issue, vscode.TreeItemCollapsibleState.Collapsed),
    );
  }

  private getPhases(issue: IssueState): PhaseTreeItem[] {
    return WORKFLOW_PHASES.map(
      (phase) => new PhaseTreeItem(phase, issue.phases[phase]),
    );
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const provider = new IssuesProvider(workspaceRoot);

  // Register tree view
  const treeView = vscode.window.createTreeView("sequantIssues", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Register commands
  const refreshCommand = vscode.commands.registerCommand(
    "sequant.refresh",
    () => provider.refresh(),
  );

  const openWorktreeCommand = vscode.commands.registerCommand(
    "sequant.openWorktree",
    (item: IssueTreeItem) => {
      if (item.issue.worktree) {
        const uri = vscode.Uri.file(item.issue.worktree);
        vscode.commands.executeCommand("vscode.openFolder", uri, {
          forceNewWindow: true,
        });
      } else {
        vscode.window.showWarningMessage(
          `No worktree found for issue #${item.issue.number}`,
        );
      }
    },
  );

  const openGitHubCommand = vscode.commands.registerCommand(
    "sequant.openGitHub",
    async (item: IssueTreeItem) => {
      // Try to get repo info from git
      if (workspaceRoot) {
        try {
          const gitConfigPath = path.join(workspaceRoot, ".git", "config");
          if (fs.existsSync(gitConfigPath)) {
            const gitConfig = fs.readFileSync(gitConfigPath, "utf-8");
            const match = gitConfig.match(
              /url\s*=\s*.*github\.com[:/]([^/]+\/[^/\s.]+)/,
            );
            if (match) {
              const repo = match[1].replace(/\.git$/, "");
              const url = `https://github.com/${repo}/issues/${item.issue.number}`;
              vscode.env.openExternal(vscode.Uri.parse(url));
              return;
            }
          }
        } catch {
          // Fall through to error message
        }
      }
      vscode.window.showErrorMessage("Could not determine GitHub repository");
    },
  );

  context.subscriptions.push(
    treeView,
    provider,
    refreshCommand,
    openWorktreeCommand,
    openGitHubCommand,
  );

  // Show welcome message
  vscode.window.showInformationMessage("Sequant Workflow extension activated");
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // Cleanup handled by disposables
}
