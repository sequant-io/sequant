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
import type { AnnotatedCheck } from "../../qa/infra-blocked-ci.js";

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

/**
 * A single entry in a PR's `statusCheckRollup`.
 *
 * `gh pr view N --json statusCheckRollup` returns a heterogeneous array of two
 * shapes, discriminated by `__typename`:
 *  - `CheckRun` (GitHub Actions / Checks API): progress in `status`
 *    (QUEUED | IN_PROGRESS | COMPLETED) with the outcome in `conclusion`.
 *  - `StatusContext` (legacy commit statuses): combined state in `state`
 *    (EXPECTED | PENDING | SUCCESS | FAILURE | ERROR).
 * Only the fields the watch loop consumes are typed; unknown fields are ignored.
 */
export interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  /** CheckRun progress. */
  status?: string;
  /** CheckRun outcome. */
  conclusion?: string;
  /** StatusContext combined state. */
  state?: string;
}

/** PR mergeability as reported by `gh pr view --json mergeable`. */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

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
    base?: string,
  ): CreatePRCliResult {
    const args = [
      "pr",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--head",
      head,
    ];
    if (base) {
      args.push("--base", base);
    }
    const result = spawnSync("gh", args, {
      stdio: "pipe",
      cwd,
      timeout: 30000,
    });

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

  // ─── Repo-aware sync helpers (for upstream / utility callers) ──────

  /**
   * Fetch just the title of an issue by number.
   * Used by merge-check and worktree-discovery.
   */
  fetchIssueTitleSync(issueId: string): string | null {
    try {
      const result = spawnSync(
        "gh",
        ["issue", "view", issueId, "--json", "title", "--jq", ".title"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      );
      if (result.status !== 0 || !result.stdout?.trim()) return null;
      return result.stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Fetch an issue's raw body markdown. Used by `sequant ready` (#683) to parse
   * the Non-Goals section for report-only gap classification. Returns null when
   * gh is unavailable, the issue can't be fetched, or the body is empty.
   */
  fetchIssueBodySync(issueId: string): string | null {
    try {
      const result = spawnSync(
        "gh",
        ["issue", "view", issueId, "--json", "body", "--jq", ".body"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      );
      if (result.status !== 0) return null;
      const body = result.stdout ?? "";
      return body.trim() ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Check if the `gh` CLI binary is installed (not auth, just available).
   * Used by upstream/assessment.ts for pre-flight checks.
   */
  checkGhInstalledSync(): boolean {
    try {
      const result = spawnSync("gh", ["--version"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Fetch a single release from a specific repo.
   * If `version` is omitted, fetches the latest release.
   * Used by upstream/assessment.ts.
   */
  fetchReleaseSync(
    repo: string,
    version?: string,
  ): Record<string, unknown> | null {
    try {
      const args = ["release", "view"];
      if (version) args.push(version);
      args.push("--repo", repo, "--json", "tagName,name,body,publishedAt");
      const result = spawnSync("gh", args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      if (result.status !== 0 || !result.stdout) return null;
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * List releases from a specific repo.
   * Used by upstream/assessment.ts.
   */
  listReleasesSync(
    repo: string,
    limit: number = 50,
  ): Array<{ tagName: string; publishedAt: string }> {
    try {
      const result = spawnSync(
        "gh",
        [
          "release",
          "list",
          "--repo",
          repo,
          "--limit",
          String(limit),
          "--json",
          "tagName,publishedAt",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      return JSON.parse(result.stdout) as Array<{
        tagName: string;
        publishedAt: string;
      }>;
    } catch {
      return [];
    }
  }

  /**
   * Search issues in a specific repo by labels and search query.
   * Used by upstream/issues.ts for duplicate detection.
   */
  searchIssuesSync(
    repo: string,
    labels: string[],
    search: string,
    limit: number = 10,
  ): Array<{ number: number; title: string }> {
    try {
      const args = ["issue", "list", "--repo", repo];
      for (const label of labels) {
        args.push("--label", label);
      }
      args.push(
        "--search",
        search,
        "--json",
        "number,title",
        "--limit",
        String(limit),
      );
      const result = spawnSync("gh", args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      if (result.status !== 0 || !result.stdout) return [];
      return JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
      }>;
    } catch {
      return [];
    }
  }

  /**
   * Create an issue in a specific repo using a body file.
   * Used by upstream/issues.ts.
   */
  createIssueWithBodyFileSync(
    repo: string,
    title: string,
    bodyFile: string,
    labels: string[],
  ): { number: number; url: string } | null {
    try {
      const args = [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ];
      for (const label of labels) {
        args.push("--label", label);
      }
      const result = spawnSync("gh", args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });
      if (result.status !== 0 || !result.stdout) {
        if (result.stderr) {
          console.error(`gh issue create failed: ${result.stderr.trim()}`);
        }
        return null;
      }
      const url = result.stdout.trim();
      const numberMatch = url.match(/\/issues\/(\d+)$/);
      const number = numberMatch ? parseInt(numberMatch[1], 10) : 0;
      return { number, url };
    } catch {
      return null;
    }
  }

  /**
   * Add a comment to an issue in a specific repo using a body file.
   * Used by upstream/issues.ts.
   */
  commentOnIssueWithBodyFileSync(
    repo: string,
    issueNumber: number,
    bodyFile: string,
  ): boolean {
    try {
      const result = spawnSync(
        "gh",
        [
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          repo,
          "--body-file",
          bodyFile,
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      return result.status === 0;
    } catch {
      return false;
    }
  }

  // ─── Watch / CI-rollup helpers (for `merge --watch`, #818) ─────────

  /**
   * Fetch a PR's status-check rollup via `statusCheckRollup`.
   *
   * Uses `statusCheckRollup`, NOT the known-broken `--json checks` field
   * (#443 / #818). Returns the raw heterogeneous entries; callers classify
   * terminal-ness with the helpers in `merge-check/watch.ts`. Returns `[]` on
   * any error so a transient `gh` failure degrades to "no checks yet" rather
   * than crashing a poll loop.
   */
  getStatusCheckRollupSync(prNumber: number): RollupEntry[] {
    try {
      const result = spawnSync(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "statusCheckRollup",
          "-q",
          ".statusCheckRollup",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? (parsed as RollupEntry[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch a PR's mergeability state via `--json mergeable`.
   *
   * Right after a push GitHub reports `UNKNOWN` while it recomputes, then
   * settles to `MERGEABLE` or `CONFLICTING`. `merge --watch` treats
   * `CONFLICTING` as a dispatch block: CI never starts against an unmergeable
   * ref. Returns `UNKNOWN` on any error — the safe default that keeps the loop
   * polling rather than falsely reporting a conflict.
   */
  getMergeableStateSync(prNumber: number): MergeableState {
    try {
      const result = spawnSync(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "mergeable",
          "-q",
          ".mergeable",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      );
      if (result.status === 0 && result.stdout) {
        const state = result.stdout.toString().trim().toUpperCase();
        if (
          state === "MERGEABLE" ||
          state === "CONFLICTING" ||
          state === "UNKNOWN"
        ) {
          return state;
        }
      }
    } catch {
      // fall through to UNKNOWN
    }
    return "UNKNOWN";
  }

  /**
   * Get a PR's head commit SHA via `--json headRefOid`.
   *
   * Needed to query the commit's check-run annotations for the billing-lockout
   * signature. Returns `null` on error.
   */
  getPRHeadShaSync(prNumber: number): string | null {
    try {
      const result = spawnSync(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "headRefOid",
          "-q",
          ".headRefOid",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
      );
      if (result.status === 0 && result.stdout) {
        const sha = result.stdout.toString().trim();
        return sha || null;
      }
    } catch {
      // fall through to null
    }
    return null;
  }

  /**
   * Fetch check-run annotations for a commit, shaped for `detectInfraBlockedCi`.
   *
   * Lists the commit's check runs (per_page=100, no pagination needed for the
   * billing-lockout case — every run carries the same annotation, so the first
   * page is representative), then fetches annotations for each run that reports
   * any. Used only when the whole board is failing, to recognise the "job was
   * not started" signature (#820). Degrades to `[]` on any error (404, rate
   * limit, revoked token) so a broken-CI situation never crashes the watch
   * loop — `detectInfraBlockedCi` then reads that as "not infra-blocked".
   */
  getCheckRunAnnotationsSync(headSha: string): AnnotatedCheck[] {
    try {
      const listResult = spawnSync(
        "gh",
        [
          "api",
          `repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100`,
          "-q",
          ".check_runs",
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      if (listResult.status !== 0 || !listResult.stdout) return [];
      const runs = JSON.parse(listResult.stdout);
      if (!Array.isArray(runs)) return [];

      const annotated: AnnotatedCheck[] = [];
      for (const run of runs as Array<{
        id?: number | string;
        name?: string;
        output?: { annotations_count?: number };
      }>) {
        const checkName = typeof run?.name === "string" ? run.name : "unknown";
        const id = run?.id;
        if (typeof id !== "number" && typeof id !== "string") continue;
        // Skip runs that explicitly report zero annotations; keep fetching when
        // the count is unknown, so a missing field never hides the signature.
        const count = run?.output?.annotations_count;
        if (typeof count === "number" && count === 0) continue;

        const annResult = spawnSync(
          "gh",
          ["api", `repos/{owner}/{repo}/check-runs/${id}/annotations`],
          {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 15000,
          },
        );
        if (annResult.status !== 0 || !annResult.stdout) {
          annotated.push({ checkName, annotations: [] });
          continue;
        }
        try {
          const annotations = JSON.parse(annResult.stdout);
          annotated.push({
            checkName,
            annotations: Array.isArray(annotations) ? annotations : [],
          });
        } catch {
          annotated.push({ checkName, annotations: [] });
        }
      }
      return annotated;
    } catch {
      return [];
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
    const result = this.createPRCliSync(
      opts.title,
      opts.body,
      opts.head,
      undefined,
      opts.base,
    );

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
