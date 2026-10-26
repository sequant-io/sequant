/**
 * GitHubProvider — PlatformProvider implementation wrapping the `gh` CLI.
 *
 * Owns all `gh` CLI calls for the orchestration layer. Skills continue
 * to call `gh` directly for v1 (see Non-Goals in #368).
 *
 * Sync methods are provided for callers that are currently synchronous
 * (phase-detection, pr-status, system, doctor, worktree-manager).
 * Async interface methods delegate to the sync implementations.
 *
 * Every call goes through one {@link GhRunner} (#1506): the default spawns
 * the real binary, and `FakeGitHubProvider` replays captured output.
 */

import { spawnSync } from "child_process";
import type {
  PlatformProvider,
  Issue,
  CreatePROptions,
  PRInfo,
  PRStatus,
  Comment,
} from "./platform-provider.js";
import type { AnnotatedCheck } from "../../qa/infra-blocked-ci.js";
import { noteSuppressed } from "../suppressed.js";

/**
 * Wall-clock bound for `gh auth status` (#1099, following #1075's precedent).
 *
 * This probe reaches the network, so it gets the longer of the two #1075
 * bounds: a stalled request must not hang every caller (`doctor`, upstream
 * assessment) with no way out but Ctrl-C, but a legitimately slow check over
 * a poor link must not be misreported as unauthenticated too eagerly.
 */
const AUTH_PROBE_TIMEOUT_MS = 10_000;

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

/** A closed issue with its body (#1520 AC-1). */
export interface ClosedIssueWithBody {
  number: number;
  closedAt: string;
  body: string;
}

/** A merged PR with its comments (#1520 AC-6). */
export interface MergedPRWithComments {
  number: number;
  mergedAt: string;
  comments: {
    author: { login: string } | null;
    body: string;
    createdAt: string;
  }[];
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

/** Per-call options a {@link GhRunner} honours. */
export interface GhRunOptions {
  timeout?: number;
  cwd?: string;
  /** Written to gh's stdin. */
  input?: string;
}

/** What one `gh` invocation produced, as a {@link GhRunner} reports it. */
export interface GhRunResult {
  /** Exit code; `null` when gh was killed or never spawned. */
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  /** Set when the spawn itself failed (ENOENT, ETIMEDOUT). */
  error?: Error;
}

/**
 * The one seam every `gh` call goes through (#1506). The default runs the real
 * binary; tests pass a runner that replays captured output
 * (`FakeGitHubProvider`), so no test fakes gh through `child_process`.
 */
export type GhRunner = (args: string[], opts: GhRunOptions) => GhRunResult;

/** The only place in `src/` that spawns `gh`. */
function spawnGh(args: string[], opts: GhRunOptions): GhRunResult {
  const result = spawnSync("gh", args, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: opts.timeout,
    cwd: opts.cwd,
    input: opts.input,
    // #1520: issue and PR lists with bodies run past the 1 MB default.
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * A `gh` call that did not exit 0: a non-zero exit, a timeout or a failed
 * spawn (#1312, #1506). The message carries gh's stderr; `stderr` and
 * `exitCode` let a caller classify the failure (e.g. #1257's not-found)
 * without parsing the message.
 */
export class GhCommandError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(args: string[], result: GhRunResult) {
    const stderr = result.stderr.trim();
    const cause = result.error
      ? result.error.message
      : result.signal
        ? `killed by ${result.signal}`
        : `exit ${result.status}`;
    super(
      `gh ${args.slice(0, 2).join(" ")} failed (${cause})${stderr ? `: ${stderr}` : ""}`,
    );
    this.name = "GhCommandError";
    this.args = args;
    this.exitCode = result.status;
    this.signal = result.signal;
    this.stderr = stderr;
  }
}

/** An open PR on origin and the paths it changes (#1454). */
export interface OpenPRFiles {
  number: number;
  headRefName: string;
  files: string[];
}

/** PR mergeability as reported by `gh pr view --json mergeable`. */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export class GitHubProvider implements PlatformProvider {
  name = "github";

  protected readonly run: GhRunner;

  constructor(opts: { run?: GhRunner } = {}) {
    this.run = opts.run ?? spawnGh;
  }

  /**
   * Run `gh` and throw {@link GhCommandError} unless it exited 0 (#1312).
   * Returns gh's stdout.
   */
  private runOrThrow(args: string[], timeout = 15000): string {
    const result = this.run(args, { timeout });
    if (result.error || result.signal || result.status !== 0) {
      throw new GhCommandError(args, result);
    }
    return result.stdout;
  }

  // ─── Sync helpers (for synchronous callers) ────────────────────────

  /**
   * Fetch issue comment bodies as a string array.
   * Used by phase-detection.ts for phase marker parsing.
   */
  fetchIssueCommentBodiesSync(issueId: string): string[] {
    try {
      const result = this.run(
        [
          "issue",
          "view",
          issueId,
          "--json",
          "comments",
          "--jq",
          "[.comments[].body]",
        ],
        { timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      return JSON.parse(result.stdout) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Fetch issue comments with their creation time (ISO-8601), oldest first.
   * Used by the spec output guard (#1193) to accept only a marker posted
   * during the phase. Returns `[]` on any failure, like
   * {@link fetchIssueCommentBodiesSync}.
   */
  fetchIssueCommentsSync(
    issueId: string,
  ): { body: string; createdAt: string }[] {
    try {
      const result = this.run(
        [
          "issue",
          "view",
          issueId,
          "--json",
          "comments",
          "--jq",
          "[.comments[] | {body, createdAt}]",
        ],
        { timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      return JSON.parse(result.stdout) as { body: string; createdAt: string }[];
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
      return (
        this.run(["auth", "status"], { timeout: AUTH_PROBE_TIMEOUT_MS })
          .status === 0
      );
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
      const result = this.run(
        ["pr", "view", String(prNumber), "--json", "state", "-q", ".state"],
        { timeout: 10000 },
      );

      if (result.status === 0 && result.stdout) {
        const state = result.stdout.toString().trim().toUpperCase();
        if (state === "MERGED") return "MERGED";
        if (state === "CLOSED") return "CLOSED";
        if (state === "OPEN") return "OPEN";
      }
    } catch (err) {
      // gh not available or error
      noteSuppressed(
        "platform",
        err,
        "github:GitHubProvider.getPRMergeStatusSync",
      );
    }

    return null;
  }

  /**
   * List recently closed issues.
   * Used by doctor.ts for closed-issue verification.
   */
  listClosedIssuesSync(limit: number = 100): ClosedIssueRaw[] {
    try {
      const result = this.run(
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
        { timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      return JSON.parse(result.stdout) as ClosedIssueRaw[];
    } catch {
      return [];
    }
  }

  /**
   * Issues closed on or after `since` (YYYY-MM-DD), with bodies (#1520 AC-1).
   * Throws on failure: the attribution-rate script must not report a rate
   * over an empty list it could not read.
   */
  listClosedIssuesWithBodySync(
    since: string,
    limit: number = 1000,
  ): ClosedIssueWithBody[] {
    const stdout = this.runOrThrow(
      [
        "issue",
        "list",
        "--state",
        "closed",
        "--search",
        `closed:>=${since}`,
        "--json",
        "number,closedAt,body",
        "--limit",
        String(limit),
      ],
      60000,
    );
    return JSON.parse(stdout) as ClosedIssueWithBody[];
  }

  /**
   * PRs merged on or after `since` (YYYY-MM-DD), with comments (#1520 AC-6).
   * Throws on failure, like {@link listClosedIssuesWithBodySync}.
   */
  listMergedPRsWithCommentsSync(
    since: string,
    limit: number = 1000,
  ): MergedPRWithComments[] {
    const stdout = this.runOrThrow(
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--search",
        `merged:>=${since}`,
        "--json",
        "number,mergedAt,comments",
        "--limit",
        String(limit),
      ],
      60000,
    );
    return JSON.parse(stdout) as MergedPRWithComments[];
  }

  /**
   * View a PR by branch name, returning number and URL.
   * Used by worktree-manager.ts to check for existing PRs.
   */
  viewPRByBranchSync(
    branch: string,
    cwd?: string,
  ): { number: number; url: string; body?: string } | null {
    const result = this.run(
      ["pr", "view", branch, "--json", "number,url,body"],
      { timeout: 15000, cwd },
    );

    if (result.status === 0 && result.stdout) {
      try {
        const info = JSON.parse(result.stdout.toString());
        if (info.number && info.url) {
          return {
            number: info.number,
            url: info.url,
            ...(typeof info.body === "string" ? { body: info.body } : {}),
          };
        }
      } catch (err) {
        // JSON parse failed
        noteSuppressed(
          "platform",
          err,
          "github:GitHubProvider.viewPRByBranchSync",
        );
      }
    }

    return null;
  }

  /**
   * Get the head branch name for a PR by number.
   * Used by the pre-tool hook (templates/hooks/pre-tool.sh) for pre-merge worktree cleanup.
   */
  getPRHeadBranchSync(prNumber: number): string | null {
    const result = this.run(
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "headRefName",
        "--jq",
        ".headRefName",
      ],
      { timeout: 10000 },
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
    const result = this.run(args, { timeout: 30000, cwd });

    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
      exitCode: result.status,
    };
  }

  /**
   * Update an existing PR's title, body and/or base (#1247).
   *
   * Goes through `gh api -X PATCH` with the fields as a JSON document on
   * stdin, not `gh pr edit`, which fails on the projectCards GraphQL
   * deprecation. `{owner}/{repo}` is resolved by gh from `cwd`'s remote.
   * Used by worktree-manager.ts when a PR already exists for the branch.
   */
  updatePRSync(
    prNumber: number,
    fields: { title?: string; body?: string; base?: string },
    cwd?: string,
  ): { success: boolean; error?: string } {
    const payload: Record<string, string> = {};
    if (fields.title !== undefined) payload.title = fields.title;
    if (fields.body !== undefined) payload.body = fields.body;
    if (fields.base !== undefined) payload.base = fields.base;
    if (Object.keys(payload).length === 0) return { success: true };
    const result = this.run(
      [
        "api",
        "-X",
        "PATCH",
        `repos/{owner}/{repo}/pulls/${prNumber}`,
        "--input",
        "-",
      ],
      { timeout: 30000, cwd, input: JSON.stringify(payload) },
    );
    if (result.status === 0) return { success: true };
    return {
      success: false,
      error: result.stderr?.toString().trim() || "Unknown error",
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
      const repoResult = this.run(["repo", "view", "--json", "owner,name"], {
        timeout: 10000,
      });

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

      const result = this.run(
        ["api", "graphql", "-f", `query=${filledQuery}`],
        { timeout: 15000 },
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
      const result = this.run(
        ["issue", "view", issueId, "--json", "title", "--jq", ".title"],
        { timeout: 10000 },
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
      const result = this.run(
        ["issue", "view", issueId, "--json", "body", "--jq", ".body"],
        { timeout: 10000 },
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
      const result = this.run(["--version"], { timeout: 5000 });
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
      const result = this.run(args, { timeout: 15000 });
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
      const result = this.run(
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
        { timeout: 15000 },
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
   * Used by upstream/issues.ts for duplicate detection. Returns `[]` when the
   * search fails; use {@link searchIssuesOrNullSync} to tell the two apart.
   */
  searchIssuesSync(
    repo: string,
    labels: string[],
    search: string,
    limit: number = 10,
  ): Array<{ number: number; title: string }> {
    return this.searchIssuesOrNullSync(repo, labels, search, limit) ?? [];
  }

  /**
   * Like {@link searchIssuesSync}, but returns null when the search fails
   * (gh error, rate limit), so a caller can refuse to act on "no match" it
   * could not actually establish (#1179).
   */
  searchIssuesOrNullSync(
    repo: string,
    labels: string[],
    search: string,
    limit: number = 10,
  ): Array<{ number: number; title: string }> | null {
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
      const result = this.run(args, { timeout: 15000 });
      if (result.status !== 0 || !result.stdout) return null;
      return JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
      }>;
    } catch {
      return null;
    }
  }

  /**
   * List label names defined in a repo. Returns null when the listing fails,
   * so callers can tell "no labels" from "could not check".
   */
  listLabelsSync(repo: string): string[] | null {
    try {
      const result = this.run(
        ["label", "list", "--repo", repo, "--json", "name", "--limit", "200"],
        { timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return null;
      return (JSON.parse(result.stdout) as Array<{ name: string }>).map(
        (l) => l.name,
      );
    } catch {
      return null;
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
      const result = this.run(args, { timeout: 30000 });
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
      const result = this.run(
        [
          "issue",
          "comment",
          String(issueNumber),
          "--repo",
          repo,
          "--body-file",
          bodyFile,
        ],
        { timeout: 15000 },
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
      const result = this.run(
        [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "statusCheckRollup",
          "-q",
          ".statusCheckRollup",
        ],
        { timeout: 15000 },
      );
      if (result.status !== 0 || !result.stdout) return [];
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? (parsed as RollupEntry[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * List open PRs on origin with their changed file paths (#1454).
   *
   * Throws when `gh` is missing, unauthenticated, exits non-zero or returns
   * unparseable output. An empty array means "no open PRs", so a failure must
   * not collapse to `[]`: callers report it as a skipped check. `gh` returns
   * at most 100 files per PR, so a larger PR is under-reported.
   */
  listOpenPRFilesSync(limit: number = 100): OpenPRFiles[] {
    const stdout = this.runOrThrow([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,headRefName,files",
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("gh pr list returned output that is not JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("gh pr list returned output that is not a JSON array");
    }
    return parsed.map((pr: Record<string, unknown>) => ({
      number: Number(pr.number),
      headRefName: String(pr.headRefName ?? ""),
      files: Array.isArray(pr.files)
        ? (pr.files as Array<{ path?: unknown }>)
            .map((f) => f?.path)
            .filter((p): p is string => typeof p === "string")
        : [],
    }));
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
      const result = this.run(
        [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "mergeable",
          "-q",
          ".mergeable",
        ],
        { timeout: 10000 },
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
    } catch (err) {
      // fall through to UNKNOWN
      noteSuppressed(
        "platform",
        err,
        "github:GitHubProvider.getMergeableStateSync",
      );
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
      const result = this.run(
        [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "headRefOid",
          "-q",
          ".headRefOid",
        ],
        { timeout: 10000 },
      );
      if (result.status === 0 && result.stdout) {
        const sha = result.stdout.toString().trim();
        return sha || null;
      }
    } catch (err) {
      // fall through to null
      noteSuppressed("platform", err, "github:GitHubProvider.getPRHeadShaSync");
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
      const listResult = this.run(
        [
          "api",
          `repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100`,
          "-q",
          ".check_runs",
        ],
        { timeout: 15000 },
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

        const annResult = this.run(
          ["api", `repos/{owner}/{repo}/check-runs/${id}/annotations`],
          { timeout: 15000 },
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

  /**
   * Fetch an issue for a synchronous caller (`parseDependencies`, #1506).
   * Throws {@link GhCommandError} when gh fails, so the caller can read its
   * stderr.
   */
  fetchIssueSync(id: string): Issue {
    const stdout = this.runOrThrow([
      "issue",
      "view",
      id,
      "--json",
      "number,title,body,labels,state",
    ]);
    if (!stdout.trim()) {
      throw new Error(`Failed to fetch issue ${id}: gh printed nothing`);
    }
    const data = JSON.parse(stdout);
    return {
      id: String(data.number),
      number: data.number,
      title: data.title,
      body: data.body,
      labels: (data.labels ?? []).map((l: { name: string }) => l.name),
      state: data.state.toLowerCase() as "open" | "closed",
    };
  }

  async fetchIssue(id: string): Promise<Issue> {
    return this.fetchIssueSync(id);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    this.runOrThrow(["issue", "comment", issueId, "--body", body]);
  }

  async addLabel(issueId: string, label: string): Promise<void> {
    this.runOrThrow(["issue", "edit", issueId, "--add-label", label]);
  }

  async removeLabel(issueId: string, label: string): Promise<void> {
    this.runOrThrow(["issue", "edit", issueId, "--remove-label", label]);
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
    this.runOrThrow(["pr", "comment", prId, "--body", body]);
  }

  async checkAuth(): Promise<boolean> {
    return this.checkAuthSync();
  }

  async getIssueComments(issueId: string): Promise<Comment[]> {
    // #1315: rejects on failure like every other async method, instead of
    // resolving [] — an empty list is indistinguishable from "no comments".
    const stdout = this.runOrThrow([
      "issue",
      "view",
      issueId,
      "--json",
      "comments",
      "--jq",
      "[.comments[] | {body: .body, createdAt: .createdAt}]",
    ]);
    return JSON.parse(stdout) as Comment[];
  }
}
