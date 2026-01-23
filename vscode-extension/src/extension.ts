/**
 * Sequant Explorer VS Code Extension
 *
 * Provides a premium tree view of tracked issues and their workflow phases.
 * Features status grouping, acceptance criteria display, time tracking,
 * inline errors, PR integration, and smart actions.
 *
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
  | "verify"
  | "qa"
  | "loop"
  | "merger";

type PhaseStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

type IssueStatus =
  | "not_started"
  | "in_progress"
  | "waiting_for_qa_gate"
  | "ready_for_merge"
  | "merged"
  | "blocked"
  | "abandoned";

type ACStatus = "pending" | "met" | "not_met" | "blocked";

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

interface AcceptanceCriterion {
  id: string;
  description: string;
  verificationMethod: string;
  status: ACStatus;
  verifiedAt?: string;
  notes?: string;
}

interface AcceptanceCriteria {
  items: AcceptanceCriterion[];
  extractedAt: string;
  summary: {
    total: number;
    met: number;
    notMet: number;
    pending: number;
    blocked: number;
  };
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
  acceptanceCriteria?: AcceptanceCriteria;
  lastActivity: string;
  createdAt: string;
}

interface WorkflowState {
  version: number;
  lastUpdated: string;
  issues: Record<string, IssueState>;
}

/**
 * Tree item types for contextValue and distinction
 */
type TreeItemType =
  | "overview"
  | "statusGroup"
  | "issue"
  | "acContainer"
  | "acItem"
  | "progressContainer"
  | "phase"
  | "linksContainer"
  | "link"
  | "warning"
  | "smartAction";

/**
 * Status groups for issue grouping
 */
type StatusGroup =
  | "in_progress"
  | "ready_to_merge"
  | "blocked"
  | "recently_merged";

const STATUS_GROUP_ORDER: StatusGroup[] = [
  "in_progress",
  "ready_to_merge",
  "blocked",
  "recently_merged",
];

const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  in_progress: "⚡ IN PROGRESS",
  ready_to_merge: "✅ READY TO MERGE",
  blocked: "🔴 BLOCKED",
  recently_merged: "📦 RECENTLY MERGED",
};

const STATUS_GROUP_ICONS: Record<StatusGroup, vscode.ThemeIcon> = {
  in_progress: new vscode.ThemeIcon(
    "sync~spin",
    new vscode.ThemeColor("charts.blue"),
  ),
  ready_to_merge: new vscode.ThemeIcon(
    "check",
    new vscode.ThemeColor("charts.green"),
  ),
  blocked: new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red")),
  recently_merged: new vscode.ThemeIcon(
    "git-merge",
    new vscode.ThemeColor("charts.green"),
  ),
};

/**
 * Tree item representing various elements in the tree
 */
class SequantTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    public readonly issue?: IssueState,
    public readonly phase?: Phase,
    public readonly phaseState?: PhaseState,
    public readonly statusGroup?: StatusGroup,
    public readonly acItem?: AcceptanceCriterion,
    public readonly linkUrl?: string,
  ) {
    super(label, collapsibleState);
    this.contextValue = itemType;
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

    // Root level: show overview + status groups
    if (!element) {
      return Promise.resolve(this.getRootItems());
    }

    // Overview item: no children
    if (element.itemType === "overview") {
      return Promise.resolve([]);
    }

    // Status group: show issues in that group
    if (element.itemType === "statusGroup" && element.statusGroup) {
      return Promise.resolve(this.getIssuesForGroup(element.statusGroup));
    }

    // Issue level: show AC, Progress, Links, Warnings
    if (element.itemType === "issue" && element.issue) {
      return Promise.resolve(this.getIssueChildren(element.issue));
    }

    // AC Container: show individual AC items
    if (
      element.itemType === "acContainer" &&
      element.issue?.acceptanceCriteria
    ) {
      return Promise.resolve(this.getACItems(element.issue.acceptanceCriteria));
    }

    // Progress Container: show phase items
    if (element.itemType === "progressContainer" && element.issue) {
      return Promise.resolve(this.getPhaseItems(element.issue));
    }

    // Links Container: show links
    if (element.itemType === "linksContainer" && element.issue) {
      return Promise.resolve(this.getLinkItems(element.issue));
    }

    return Promise.resolve([]);
  }

  /**
   * Get root level items (overview + status groups)
   */
  private getRootItems(): SequantTreeItem[] {
    const items: SequantTreeItem[] = [];

    // Add overview summary
    items.push(this.createOverviewItem());

    // Add status groups (only if they have issues)
    for (const group of STATUS_GROUP_ORDER) {
      const groupIssues = this.getIssuesForStatusGroup(group);
      if (groupIssues.length > 0) {
        items.push(this.createStatusGroupItem(group, groupIssues.length));
      }
    }

    return items;
  }

  /**
   * Create overview summary item
   */
  private createOverviewItem(): SequantTreeItem {
    if (!this.state) {
      const item = new SequantTreeItem(
        "📊 No issues tracked",
        vscode.TreeItemCollapsibleState.None,
        "overview",
      );
      return item;
    }

    const issues = Object.values(this.state.issues);
    const inProgress = issues.filter(
      (i) => i.status === "in_progress" || i.status === "waiting_for_qa_gate",
    ).length;
    const readyToMerge = issues.filter(
      (i) => i.status === "ready_for_merge",
    ).length;

    let description = `${issues.length} issue${issues.length !== 1 ? "s" : ""}`;
    if (inProgress > 0) {
      description += ` · ${inProgress} in progress`;
    }
    if (readyToMerge > 0) {
      description += ` · ${readyToMerge} ready to merge`;
    }

    const item = new SequantTreeItem(
      `📊 Overview: ${description}`,
      vscode.TreeItemCollapsibleState.None,
      "overview",
    );
    item.iconPath = new vscode.ThemeIcon("dashboard");
    return item;
  }

  /**
   * Create status group item
   */
  private createStatusGroupItem(
    group: StatusGroup,
    count: number,
  ): SequantTreeItem {
    const item = new SequantTreeItem(
      STATUS_GROUP_LABELS[group],
      vscode.TreeItemCollapsibleState.Expanded,
      "statusGroup",
      undefined,
      undefined,
      undefined,
      group,
    );
    item.iconPath = STATUS_GROUP_ICONS[group];
    item.description = `(${count})`;
    return item;
  }

  /**
   * Get issues filtered by status group
   */
  private getIssuesForStatusGroup(group: StatusGroup): IssueState[] {
    if (!this.state) return [];

    const issues = Object.values(this.state.issues);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    switch (group) {
      case "in_progress":
        return issues.filter(
          (i) =>
            i.status === "in_progress" ||
            i.status === "waiting_for_qa_gate" ||
            i.status === "not_started",
        );
      case "ready_to_merge":
        return issues.filter((i) => i.status === "ready_for_merge");
      case "blocked":
        return issues.filter((i) => i.status === "blocked");
      case "recently_merged":
        return issues.filter(
          (i) =>
            i.status === "merged" && new Date(i.lastActivity) >= sevenDaysAgo,
        );
      default:
        return [];
    }
  }

  /**
   * Get issues for a status group as tree items
   */
  private getIssuesForGroup(group: StatusGroup): SequantTreeItem[] {
    const issues = this.getIssuesForStatusGroup(group);

    // Sort by last activity
    issues.sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    );

    return issues.map((issue) => this.createIssueItem(issue));
  }

  /**
   * Create an issue tree item
   */
  private createIssueItem(issue: IssueState): SequantTreeItem {
    const currentPhaseLabel = issue.currentPhase
      ? `[${issue.currentPhase}]`
      : "";
    const totalDuration = this.getTotalIssueDuration(issue);

    const item = new SequantTreeItem(
      `#${issue.number}: ${issue.title} ${currentPhaseLabel}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "issue",
      issue,
    );

    // Set icon based on status
    item.iconPath = this.getIssueStatusIcon(issue);

    // Set description with duration and PR
    let description = totalDuration;
    if (issue.pr) {
      description += ` · PR #${issue.pr.number}`;
    }
    item.description = description;

    // Set tooltip with details
    item.tooltip = this.createIssueTooltip(issue);

    return item;
  }

  /**
   * Get children for an issue (AC, Progress, Links, Warnings)
   */
  private getIssueChildren(issue: IssueState): SequantTreeItem[] {
    const children: SequantTreeItem[] = [];

    // Acceptance Criteria container
    if (issue.acceptanceCriteria && issue.acceptanceCriteria.items.length > 0) {
      const ac = issue.acceptanceCriteria;
      const acItem = new SequantTreeItem(
        `📋 Acceptance Criteria (${ac.summary.met}/${ac.summary.total} met)`,
        vscode.TreeItemCollapsibleState.Collapsed,
        "acContainer",
        issue,
      );
      acItem.iconPath = new vscode.ThemeIcon("checklist");
      children.push(acItem);
    }

    // Progress container (phases)
    const progressItem = new SequantTreeItem(
      "📍 Progress",
      vscode.TreeItemCollapsibleState.Collapsed,
      "progressContainer",
      issue,
    );
    progressItem.iconPath = new vscode.ThemeIcon("list-ordered");
    children.push(progressItem);

    // Links container
    const linksItem = new SequantTreeItem(
      "🔗 Links",
      vscode.TreeItemCollapsibleState.Collapsed,
      "linksContainer",
      issue,
    );
    linksItem.iconPath = new vscode.ThemeIcon("link");
    children.push(linksItem);

    // Warnings for long-running phases
    const warnings = this.getIssueWarnings(issue);
    for (const warning of warnings) {
      children.push(warning);
    }

    // Smart action suggestion
    const smartAction = this.getSmartAction(issue);
    if (smartAction) {
      children.push(smartAction);
    }

    return children;
  }

  /**
   * Get AC items for an issue
   */
  private getACItems(ac: AcceptanceCriteria): SequantTreeItem[] {
    return ac.items.map((criterion) => {
      const statusIcon = this.getACStatusIcon(criterion.status);
      const truncatedDesc =
        criterion.description.length > 50
          ? criterion.description.substring(0, 47) + "..."
          : criterion.description;

      const item = new SequantTreeItem(
        `${statusIcon} ${criterion.id}: ${truncatedDesc}`,
        vscode.TreeItemCollapsibleState.None,
        "acItem",
        undefined,
        undefined,
        undefined,
        undefined,
        criterion,
      );

      item.tooltip = new vscode.MarkdownString();
      item.tooltip.appendMarkdown(
        `**${criterion.id}**: ${criterion.description}\n\n`,
      );
      item.tooltip.appendMarkdown(`**Status:** ${criterion.status}\n\n`);
      item.tooltip.appendMarkdown(
        `**Verification:** ${criterion.verificationMethod}`,
      );
      if (criterion.notes) {
        item.tooltip.appendMarkdown(`\n\n**Notes:** ${criterion.notes}`);
      }

      return item;
    });
  }

  /**
   * Get relevant phases to display for an issue.
   * Filters out pending phases except for the next one to reduce visual clutter.
   *
   * Shows:
   * - Completed phases
   * - In-progress phases
   * - Failed phases
   * - Skipped phases
   * - Next pending phase (only one, and only for active issues)
   */
  private getRelevantPhases(issue: IssueState): Phase[] {
    const allPhases: Phase[] = [
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

    // For merged/abandoned issues, only show non-pending phases
    const isFinalState =
      issue.status === "merged" || issue.status === "abandoned";

    // First pass: collect all non-pending phases and find the last one's index
    const relevantPhases: Phase[] = [];
    let lastNonPendingIndex = -1;

    for (let i = 0; i < allPhases.length; i++) {
      const phase = allPhases[i];
      const phaseState = issue.phases[phase] as PhaseState | undefined;
      const status = phaseState?.status ?? "pending";

      if (
        status === "completed" ||
        status === "in_progress" ||
        status === "failed" ||
        status === "skipped"
      ) {
        // Always include non-pending phases
        relevantPhases.push(phase);
        lastNonPendingIndex = i;
      }
    }

    // Second pass: add the first pending phase AFTER the last non-pending phase
    // (only for active issues, not merged/abandoned)
    if (!isFinalState) {
      for (let i = lastNonPendingIndex + 1; i < allPhases.length; i++) {
        const phase = allPhases[i];
        const phaseState = issue.phases[phase] as PhaseState | undefined;
        const status = phaseState?.status ?? "pending";

        if (status === "pending") {
          relevantPhases.push(phase);
          break; // Only add one pending phase
        }
      }
    }

    return relevantPhases;
  }

  /**
   * Get phase items for an issue
   */
  private getPhaseItems(issue: IssueState): SequantTreeItem[] {
    const phases = this.getRelevantPhases(issue);

    return phases.map((phase) => {
      const phaseState = issue.phases[phase] as PhaseState | undefined;
      const status = phaseState?.status ?? "pending";
      const duration = this.getPhaseDuration(phaseState);
      const errorPreview = phaseState?.error
        ? ` — "${this.truncateError(phaseState.error)}"`
        : "";

      const statusIcon = this.getPhaseStatusIcon(status);
      const item = new SequantTreeItem(
        `${statusIcon} ${this.formatPhaseName(phase)}${errorPreview}`,
        vscode.TreeItemCollapsibleState.None,
        "phase",
        issue,
        phase,
        phaseState,
      );

      // Set description with duration
      if (duration) {
        item.description = duration;
      }

      // Set tooltip
      if (phaseState) {
        item.tooltip = this.createPhaseTooltip(phase, phaseState);
      }

      return item;
    });
  }

  /**
   * Get link items for an issue
   */
  private getLinkItems(issue: IssueState): SequantTreeItem[] {
    const links: SequantTreeItem[] = [];

    // Worktree link
    if (issue.worktree) {
      const worktreeItem = new SequantTreeItem(
        "→ Open Worktree",
        vscode.TreeItemCollapsibleState.None,
        "link",
        issue,
        undefined,
        undefined,
        undefined,
        undefined,
        issue.worktree,
      );
      worktreeItem.iconPath = new vscode.ThemeIcon("folder-opened");
      worktreeItem.command = {
        command: "sequant.openWorktree",
        title: "Open Worktree",
        arguments: [worktreeItem],
      };
      links.push(worktreeItem);
    }

    // GitHub issue link
    const githubItem = new SequantTreeItem(
      "→ View on GitHub",
      vscode.TreeItemCollapsibleState.None,
      "link",
      issue,
    );
    githubItem.iconPath = new vscode.ThemeIcon("github");
    githubItem.command = {
      command: "sequant.openInBrowser",
      title: "Open on GitHub",
      arguments: [githubItem],
    };
    links.push(githubItem);

    // PR link if available
    if (issue.pr) {
      const prItem = new SequantTreeItem(
        `→ View PR #${issue.pr.number}`,
        vscode.TreeItemCollapsibleState.None,
        "link",
        issue,
        undefined,
        undefined,
        undefined,
        undefined,
        issue.pr.url,
      );
      prItem.iconPath = new vscode.ThemeIcon("git-pull-request");
      prItem.command = {
        command: "sequant.openPR",
        title: "Open PR",
        arguments: [prItem],
      };
      links.push(prItem);
    }

    // Branch link if available
    if (issue.branch) {
      const branchItem = new SequantTreeItem(
        `→ Branch: ${issue.branch}`,
        vscode.TreeItemCollapsibleState.None,
        "link",
        issue,
      );
      branchItem.iconPath = new vscode.ThemeIcon("git-branch");
      branchItem.command = {
        command: "sequant.copyBranch",
        title: "Copy Branch Name",
        arguments: [branchItem],
      };
      links.push(branchItem);
    }

    return links;
  }

  /**
   * Get warnings for an issue (e.g., long-running phases)
   */
  private getIssueWarnings(issue: IssueState): SequantTreeItem[] {
    const warnings: SequantTreeItem[] = [];
    const ONE_HOUR = 60 * 60 * 1000;

    // Check for long-running current phase
    if (issue.currentPhase) {
      const phaseState = issue.phases[issue.currentPhase];
      if (phaseState?.status === "in_progress" && phaseState.startedAt) {
        const duration = Date.now() - new Date(phaseState.startedAt).getTime();
        if (duration > ONE_HOUR) {
          const warningItem = new SequantTreeItem(
            `⚠️ Long-running phase (${this.formatDuration(duration)})`,
            vscode.TreeItemCollapsibleState.None,
            "warning",
            issue,
          );
          warningItem.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("charts.yellow"),
          );
          warnings.push(warningItem);
        }
      }
    }

    return warnings;
  }

  /**
   * Get smart action suggestion for an issue
   */
  private getSmartAction(issue: IssueState): SequantTreeItem | null {
    let actionLabel: string | null = null;
    let command: string | undefined;

    // Determine smart action based on status and state
    if (issue.status === "ready_for_merge" && issue.pr) {
      actionLabel = "💡 Action: Merge PR";
      command = "sequant.openPR";
    } else if (issue.status === "blocked") {
      const failedPhase = Object.entries(issue.phases).find(
        ([, ps]) => ps.status === "failed",
      );
      if (failedPhase) {
        actionLabel = `💡 Action: Fix ${this.formatPhaseName(failedPhase[0] as Phase)} issues`;
      } else {
        actionLabel = "💡 Action: Resolve blockers";
      }
    } else if (issue.status === "in_progress") {
      // Check which phase is next
      if (!issue.phases["spec"] || issue.phases["spec"].status === "pending") {
        actionLabel = "💡 Action: Run /spec";
      } else if (
        issue.phases["spec"]?.status === "completed" &&
        (!issue.phases["exec"] || issue.phases["exec"].status === "pending")
      ) {
        actionLabel = "💡 Action: Run /exec";
      } else if (
        issue.phases["exec"]?.status === "completed" &&
        (!issue.phases["qa"] || issue.phases["qa"].status === "pending")
      ) {
        actionLabel = "💡 Action: Run /qa";
      }
    }

    if (!actionLabel) return null;

    const item = new SequantTreeItem(
      actionLabel,
      vscode.TreeItemCollapsibleState.None,
      "smartAction",
      issue,
    );
    item.iconPath = new vscode.ThemeIcon("lightbulb");

    if (command) {
      item.command = {
        command,
        title: actionLabel,
        arguments: [item],
      };
    }

    return item;
  }

  /**
   * Get icon for issue status
   */
  private getIssueStatusIcon(issue: IssueState): vscode.ThemeIcon {
    switch (issue.status) {
      case "in_progress":
      case "waiting_for_qa_gate":
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
          new vscode.ThemeColor("charts.red"),
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
   * Get status icon character for phases
   */
  private getPhaseStatusIcon(status: PhaseStatus): string {
    switch (status) {
      case "in_progress":
        return "●";
      case "completed":
        return "✓";
      case "failed":
        return "✗";
      case "skipped":
        return "◌";
      default:
        return "○";
    }
  }

  /**
   * Get status icon for AC
   */
  private getACStatusIcon(status: ACStatus): string {
    switch (status) {
      case "met":
        return "✓";
      case "not_met":
        return "✗";
      case "blocked":
        return "⊘";
      default:
        return "○";
    }
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
      verify: "Verify",
      qa: "QA",
      loop: "Quality Loop",
      merger: "Merger",
    };
    return names[phase];
  }

  /**
   * Get phase duration as formatted string
   */
  private getPhaseDuration(phaseState?: PhaseState): string | null {
    if (!phaseState?.startedAt) return null;

    const start = new Date(phaseState.startedAt).getTime();
    const end = phaseState.completedAt
      ? new Date(phaseState.completedAt).getTime()
      : Date.now();

    return this.formatDuration(end - start);
  }

  /**
   * Get total issue duration
   */
  private getTotalIssueDuration(issue: IssueState): string {
    const created = new Date(issue.createdAt).getTime();
    const lastActivity = new Date(issue.lastActivity).getTime();
    return this.formatDuration(lastActivity - created);
  }

  /**
   * Format duration in ms to human readable
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  }

  /**
   * Truncate error message for inline display
   */
  private truncateError(error: string): string {
    const maxLength = 40;
    if (error.length <= maxLength) return error;
    return error.substring(0, maxLength - 3) + "...";
  }

  /**
   * Create tooltip for issue
   */
  private createIssueTooltip(issue: IssueState): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**#${issue.number}**: ${issue.title}\n\n`);
    tooltip.appendMarkdown(
      `**Status:** ${issue.status.replace(/_/g, " ")}\n\n`,
    );

    if (issue.currentPhase) {
      tooltip.appendMarkdown(
        `**Current Phase:** ${this.formatPhaseName(issue.currentPhase)}\n\n`,
      );
    }
    if (issue.worktree) {
      tooltip.appendMarkdown(`**Worktree:** \`${issue.worktree}\`\n\n`);
    }
    if (issue.branch) {
      tooltip.appendMarkdown(`**Branch:** \`${issue.branch}\`\n\n`);
    }
    if (issue.pr) {
      tooltip.appendMarkdown(
        `**PR:** [#${issue.pr.number}](${issue.pr.url})\n\n`,
      );
    }
    if (issue.acceptanceCriteria) {
      const ac = issue.acceptanceCriteria.summary;
      tooltip.appendMarkdown(`**AC Progress:** ${ac.met}/${ac.total} met\n\n`);
    }
    tooltip.appendMarkdown(
      `**Last Activity:** ${this.getRelativeTime(issue.lastActivity)}`,
    );

    return tooltip;
  }

  /**
   * Create tooltip for phase
   */
  private createPhaseTooltip(
    phase: Phase,
    phaseState: PhaseState,
  ): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${this.formatPhaseName(phase)}**\n\n`);
    tooltip.appendMarkdown(
      `**Status:** ${phaseState.status.replace(/_/g, " ")}\n\n`,
    );

    if (phaseState.startedAt) {
      tooltip.appendMarkdown(
        `**Started:** ${this.getRelativeTime(phaseState.startedAt)}\n\n`,
      );
    }
    if (phaseState.completedAt) {
      tooltip.appendMarkdown(
        `**Completed:** ${this.getRelativeTime(phaseState.completedAt)}\n\n`,
      );
    }
    if (phaseState.iteration !== undefined) {
      tooltip.appendMarkdown(`**Iteration:** ${phaseState.iteration}\n\n`);
    }
    if (phaseState.error) {
      tooltip.appendMarkdown(`**Error:** ${phaseState.error}`);
    }

    return tooltip;
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
      "sequant.openWorktreeNewWindow",
      async (item: SequantTreeItem) => {
        const issue = treeDataProvider.getIssue(item);
        if (issue?.worktree) {
          const worktreeUri = vscode.Uri.file(issue.worktree);
          await vscode.commands.executeCommand(
            "vscode.openFolder",
            worktreeUri,
            true,
          );
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sequant.openPR",
      async (item: SequantTreeItem) => {
        const issue = treeDataProvider.getIssue(item);
        if (issue?.pr?.url) {
          await vscode.env.openExternal(vscode.Uri.parse(issue.pr.url));
        } else if (item.linkUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(item.linkUrl));
        } else {
          vscode.window.showWarningMessage("No PR found for this issue");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sequant.copyBranch",
      async (item: SequantTreeItem) => {
        const issue = treeDataProvider.getIssue(item);
        if (issue?.branch) {
          await vscode.env.clipboard.writeText(issue.branch);
          vscode.window.showInformationMessage(
            `Copied branch: ${issue.branch}`,
          );
        } else {
          vscode.window.showWarningMessage("No branch found for this issue");
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
