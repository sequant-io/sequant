/**
 * GitHubProvider — PlatformProvider implementation wrapping the `gh` CLI.
 *
 * Owns all `gh` CLI calls for the orchestration layer. Skills continue
 * to call `gh` directly for v1 (see Non-Goals in #368).
 *
 * Sync methods are provided for callers that are currently synchronous
 * (phase-detection, pr-status, system, doctor, worktree-manager).
 * Async interface methods delegate to the sync implementations.
 */

import { execSync } from "child_process";
import { spawnSync } from "child_process";
import type {
  PlatformProvider,
  Issue,
  CreatePROptions,
  PRInfo,
  PRStatus,
  Comment,
} from "./platform-provider.js";

/**
 * PR merge status values (matches the casing returned by `gh pr view`).
 */
export type PRMergeStatus = "MERGED" | "CLOSED" | "OPEN" | null;

/**
 * Closed issue shape returned by `gh issue list --state closed`.
 */
export interface ClosedIssueRaw {
  number: number;
  title: string;
  closedAt: string;
  labels: { name: string }[];
}

/**
 * Result of a raw `gh pr create` CLI call.
 */
export interface CreatePRCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class GitHubProvider implements PlatformProvider {
  name = "github";

  // ─── Sync helpers (for synchronous callers) ────────────────────────

  /**
   * Fetch issue comment bodies as a string array.
   * Used by phase-detection.ts for phase marker parsing.
   */
  fetchIssueCommentBodiesSync(issueId: string): string[] {
    try {
      const output = execSync(
        `gh issue view ${issueId} --json comments --jq '[.comments[].body]'`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return JSON.parse(output) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Check if `gh` CLI is authenticated.
   * Used by system.ts and doctor.ts.
   */
  checkAuthSync(): boolean {
    try {
      execSync("gh auth status", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get PR merge status by PR number.
   * Used by pr-status.ts and state-cleanup.ts.
   */
  getPRMergeStatusSync(prNumber: number): PRMergeStatus {
    try {
      const result = spawnSync(
        "gh",
        ["pr", "view", String(prNumber), "--json", "state", "-q", ".state"],
        { stdio: "pipe", timeout: 10000 },
      );

      if (result.status === 0 && result.stdout) {
        const state = result.stdout.toString().trim().toUpperCase();
        if (state === "MERGED") return "MERGED";
        if (state === "CLOSED") return "CLOSED";
        if (state === "OPEN") return "OPEN";
      }
    } catch {
      // gh not available or error
    }

    return null;
  }

  /**
   * List recently closed issues.
   * Used by doctor.ts for closed-issue verification.
   */
  listClosedIssuesSync(limit: number = 100): ClosedIssueRaw[] {
    try {
      const output = execSync(
        `gh issue list --state closed --json number,title,closedAt,labels --limit ${limit}`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return JSON.parse(output) as ClosedIssueRaw[];
    } catch {
      return [];
    }
  }

  /**
   * View a PR by branch name, returning number and URL.
   * Used by worktree-manager.ts to check for existing PRs.
   */
  viewPRByBranchSync(
    branch: string,
    cwd?: string,
  ): { number: number; url: string } | null {
    const result = spawnSync(
      "gh",
      ["pr", "view", branch, "--json", "number,url"],
      { stdio: "pipe", cwd, timeout: 15000 },
    );

    if (result.status === 0 && result.stdout) {
      try {
        const info = JSON.parse(result.stdout.toString());
        if (info.number && info.url) {
          return { number: info.number, url: info.url };
        }
      } catch {
        // JSON parse failed
      }
    }

    return null;
  }

  /**
   * Create a PR via `gh pr create` CLI, returning raw result.
   * Used by worktree-manager.ts which needs access to stdout for URL extraction.
   */
  createPRCliSync(
    title: string,
    body: string,
    head: string,
    cwd?: string,
  ): CreatePRCliResult {
    const result = spawnSync(
      "gh",
      ["pr", "create", "--title", title, "--body", body, "--head", head],
      { stdio: "pipe", cwd, timeout: 30000 },
    );

    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
      exitCode: result.status,
    };
  }

  // ─── Async interface methods (PlatformProvider) ────────────────────

  async fetchIssue(id: string): Promise<Issue> {
    const output = execSync(
      `gh issue view ${id} --json number,title,body,labels,state`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const data = JSON.parse(output);
    return {
      id: String(data.number),
      number: data.number,
      title: data.title,
      body: data.body,
      labels: (data.labels ?? []).map((l: { name: string }) => l.name),
      state: data.state.toLowerCase() as "open" | "closed",
    };
  }

  async postComment(issueId: string, body: string): Promise<void> {
    spawnSync("gh", ["issue", "comment", issueId, "--body", body], {
      stdio: "pipe",
      timeout: 15000,
    });
  }

  async addLabel(issueId: string, label: string): Promise<void> {
    spawnSync("gh", ["issue", "edit", issueId, "--add-label", label], {
      stdio: "pipe",
      timeout: 15000,
    });
  }

  async removeLabel(issueId: string, label: string): Promise<void> {
    spawnSync("gh", ["issue", "edit", issueId, "--remove-label", label], {
      stdio: "pipe",
      timeout: 15000,
    });
  }

  async createPR(opts: CreatePROptions): Promise<PRInfo> {
    const result = this.createPRCliSync(opts.title, opts.body, opts.head);

    if (result.exitCode !== 0) {
      const error = result.stderr.trim() || "Unknown error";
      throw new Error(`gh pr create failed: ${error}`);
    }

    const urlMatch = result.stdout
      .trim()
      .match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);

    if (urlMatch) {
      return {
        number: parseInt(urlMatch[1], 10),
        url: urlMatch[0],
      };
    }

    throw new Error(
      `PR created but could not extract URL from output: ${result.stdout.trim()}`,
    );
  }

  async getPRStatus(prId: string): Promise<PRStatus> {
    const status = this.getPRMergeStatusSync(parseInt(prId, 10));
    if (status) {
      return { state: status.toLowerCase() as PRStatus["state"] };
    }
    throw new Error(`Could not determine PR status for ${prId}`);
  }

  async postPRComment(prId: string, body: string): Promise<void> {
    spawnSync("gh", ["pr", "comment", prId, "--body", body], {
      stdio: "pipe",
      timeout: 15000,
    });
  }

  async checkAuth(): Promise<boolean> {
    return this.checkAuthSync();
  }

  async getIssueComments(issueId: string): Promise<Comment[]> {
    try {
      const output = execSync(
        `gh issue view ${issueId} --json comments --jq '[.comments[] | {body: .body, createdAt: .createdAt}]'`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const data = JSON.parse(output) as Array<{
        body: string;
        createdAt: string;
      }>;
      return data;
    } catch {
      return [];
    }
  }
}
