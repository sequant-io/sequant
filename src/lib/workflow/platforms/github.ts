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

import { execSync, spawnSync } from "child_process";
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

/**
 * Info returned for an issue in a batch query.
 */
export interface BatchIssueInfo {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
}

/**
 * Info returned for a PR in a batch query.
 */
export interface BatchPRInfo {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
}

/**
 * Result of a batch GitHub query.
 */
export interface BatchGitHubResult {
  issues: Record<number, BatchIssueInfo>;
  pullRequests: Record<number, BatchPRInfo>;
  error?: string;
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
      const result = spawnSync(
        "gh",
        [
          "issue",
          "view",
          issueId,
          "--json",
          "comments",
          "--jq",
          "[.comments[].body]",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      return JSON.parse(result.stdout) as string[];
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
      const result = spawnSync(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "closed",
          "--json",
          "number,title,closedAt,labels",
          "--limit",
          String(limit),
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      return JSON.parse(result.stdout) as ClosedIssueRaw[];
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
   * Get the head branch name for a PR by number.
   * Used by hooks/pre-tool.sh for pre-merge worktree cleanup.
   */
  getPRHeadBranchSync(prNumber: number): string | null {
    const result = spawnSync(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "headRefName",
        "--jq",
        ".headRefName",
      ],
      { stdio: "pipe", timeout: 10000 },
    );

    if (result.status === 0 && result.stdout) {
      const branch = result.stdout.toString().trim();
      return branch || null;
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

  /**
   * Batch fetch issue and PR status in a single GraphQL call.
   * Returns a map keyed by issue/PR number.
   */
  batchFetchIssueAndPRStatus(
    issueNumbers: number[],
    prNumbers: number[],
  ): BatchGitHubResult {
    if (issueNumbers.length === 0 && prNumbers.length === 0) {
      return { issues: {}, pullRequests: {}, error: undefined };
    }

    try {
      // Build GraphQL query with aliases for each issue and PR
      const issueFields = issueNumbers
        .map((n) => `issue_${n}: issue(number: ${n}) { number title state }`)
        .join("\n    ");
      const prFields = prNumbers
        .map((n) => `pr_${n}: pullRequest(number: ${n}) { number state }`)
        .join("\n    ");

      const query = `query {
  repository(owner: "{owner}", name: "{repo}") {
    ${issueFields}
    ${prFields}
  }
}`;

      // Get repo owner/name
      const repoResult = spawnSync(
        "gh",
        ["repo", "view", "--json", "owner,name"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      );

      if (repoResult.status !== 0 || !repoResult.stdout) {
        return {
          issues: {},
          pullRequests: {},
          error: "Failed to determine repository",
        };
      }

      const repo = JSON.parse(repoResult.stdout) as {
        owner: { login: string };
        name: string;
      };
      const filledQuery = query
        .replace("{owner}", repo.owner.login)
        .replace("{repo}", repo.name);

      const result = spawnSync(
        "gh",
        ["api", "graphql", "-f", `query=${filledQuery}`],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );

      if (result.status !== 0 || !result.stdout) {
        const stderr = result.stderr?.trim() ?? "Unknown error";
        return { issues: {}, pullRequests: {}, error: stderr };
      }

      const data = JSON.parse(result.stdout) as {
        data?: {
          repository?: Record<
            string,
            { number: number; title?: string; state: string }
          >;
        };
        errors?: Array<{ message: string }>;
      };

      const issues: Record<number, BatchIssueInfo> = {};
      const pullRequests: Record<number, BatchPRInfo> = {};

      const repoData = data.data?.repository ?? {};

      for (const [key, value] of Object.entries(repoData)) {
        if (!value) continue;
        if (key.startsWith("issue_")) {
          issues[value.number] = {
            number: value.number,
            title: value.title ?? "",
            state: value.state as "OPEN" | "CLOSED",
          };
        } else if (key.startsWith("pr_")) {
          pullRequests[value.number] = {
            number: value.number,
            state: value.state as "OPEN" | "MERGED" | "CLOSED",
          };
        }
      }

      return { issues, pullRequests, error: undefined };
    } catch (err) {
      return {
        issues: {},
        pullRequests: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── Async interface methods (PlatformProvider) ────────────────────

  async fetchIssue(id: string): Promise<Issue> {
    const result = spawnSync(
      "gh",
      ["issue", "view", id, "--json", "number,title,body,labels,state"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
    );
    if (result.status !== 0 || !result.stdout) {
      throw new Error(`Failed to fetch issue ${id}`);
    }
    const data = JSON.parse(result.stdout);
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
      const result = spawnSync(
        "gh",
        [
          "issue",
          "view",
          issueId,
          "--json",
          "comments",
          "--jq",
          "[.comments[] | {body: .body, createdAt: .createdAt}]",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      const data = JSON.parse(result.stdout) as Array<{
        body: string;
        createdAt: string;
      }>;
      return data;
    } catch {
      return [];
    }
  }
}
