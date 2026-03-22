/**
 * PlatformProvider interface — decouples workflow orchestration from
 * platform operations (issue fetching, PR creation, comments, labels).
 *
 * GitHub is the default implementation; alternatives can be added by
 * implementing this interface without touching orchestration logic.
 */

/**
 * Normalized issue representation.
 */
export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

/**
 * Options for creating a pull request.
 */
export interface CreatePROptions {
  title: string;
  body: string;
  head: string;
  base: string;
}

/**
 * Information about a created pull request.
 */
export interface PRInfo {
  number: number;
  url: string;
}

/**
 * Status of a pull request.
 */
export interface PRStatus {
  state: "open" | "closed" | "merged";
}

/**
 * A comment on an issue or pull request.
 */
export interface Comment {
  body: string;
  createdAt: string;
}

/**
 * Interface that all platform backends must implement.
 */
export interface PlatformProvider {
  /** Platform name for logging/display */
  name: string;

  /** Issue operations */
  fetchIssue(id: string): Promise<Issue>;
  postComment(issueId: string, body: string): Promise<void>;
  addLabel(issueId: string, label: string): Promise<void>;
  removeLabel(issueId: string, label: string): Promise<void>;

  /** PR operations */
  createPR(opts: CreatePROptions): Promise<PRInfo>;
  getPRStatus(prId: string): Promise<PRStatus>;
  postPRComment(prId: string, body: string): Promise<void>;

  /** Auth and health */
  checkAuth(): Promise<boolean>;

  /** Phase marker operations */
  getIssueComments(issueId: string): Promise<Comment[]>;
}
