/**
 * GitHub issue management for upstream assessments
 * Handles issue creation, deduplication, and commenting
 *
 * Security: All gh CLI calls use spawn() with argument arrays to prevent
 * command injection. No shell interpolation is used.
 */

import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubProvider } from "../workflow/platforms/github.js";
import type {
  DuplicateCheckResult,
  Finding,
  IssueParams,
  IssueResult,
} from "./types.js";
import { generateFindingIssue } from "./report.js";

/**
 * Regex pattern for valid GitHub owner/repo names
 * Only alphanumeric, hyphens, underscores, and dots allowed
 */
const REPO_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate owner and repo names to prevent injection
 */
function validateRepoParams(owner: string, repo: string): void {
  if (!REPO_NAME_PATTERN.test(owner)) {
    throw new Error(`Invalid owner name: "${owner}"`);
  }
  if (!REPO_NAME_PATTERN.test(repo)) {
    throw new Error(`Invalid repo name: "${repo}"`);
  }
}

/** Shared GitHubProvider instance for upstream gh CLI calls. */
const ghProvider = new GitHubProvider();

/**
 * Check if a similar upstream issue already exists
 */
export async function checkForDuplicate(
  title: string,
  owner: string = "sequant-io",
  repo: string = "sequant",
): Promise<DuplicateCheckResult> {
  try {
    validateRepoParams(owner, repo);

    // Search for existing upstream issues with similar title
    const searchTerms = extractSearchTerms(title);
    const issues = ghProvider.searchIssuesSync(
      `${owner}/${repo}`,
      ["upstream"],
      searchTerms,
      10,
    );

    // Check for similarity
    for (const issue of issues) {
      if (isSimilarTitle(title, issue.title)) {
        return {
          isDuplicate: true,
          existingIssue: issue.number,
          existingTitle: issue.title,
        };
      }
    }

    return { isDuplicate: false };
  } catch (error) {
    // If search fails, assume no duplicate
    console.error("Error checking for duplicates:", error);
    return { isDuplicate: false };
  }
}

/**
 * Extract search terms from a title
 * Removes common words and version info
 */
export function extractSearchTerms(title: string): string {
  const stopWords = [
    "the",
    "a",
    "an",
    "from",
    "to",
    "in",
    "for",
    "of",
    "on",
    "with",
    "claude",
    "code",
  ];

  // Remove version patterns like v2.1.29
  let cleaned = title.replace(/v?\d+\.\d+\.\d+/g, "");

  // Remove prefixes
  cleaned = cleaned.replace(
    /^(BREAKING|Deprecated|New tool|Hook change|feat|fix|chore):?\s*/i,
    "",
  );

  // Split into words and filter
  const words = cleaned
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.includes(w));

  // Take first 5 meaningful words
  return words.slice(0, 5).join(" ");
}

/**
 * Check if two titles are similar enough to be duplicates
 */
export function isSimilarTitle(title1: string, title2: string): boolean {
  const terms1 = new Set(
    extractSearchTerms(title1)
      .split(" ")
      .filter((t) => t.length > 0),
  );
  const terms2 = new Set(
    extractSearchTerms(title2)
      .split(" ")
      .filter((t) => t.length > 0),
  );

  // Calculate Jaccard similarity
  const intersection = new Set([...terms1].filter((x) => terms2.has(x)));
  const union = new Set([...terms1, ...terms2]);

  // Handle edge case where both are empty
  if (union.size === 0) return false;

  const similarity = intersection.size / union.size;

  // Consider similar if > 60% overlap
  return similarity > 0.6;
}

/**
 * Create a GitHub issue using a temporary file for the body
 * This avoids any shell escaping issues with complex markdown content
 */
export async function createIssue(
  params: IssueParams,
  owner: string = "sequant-io",
  repo: string = "sequant",
): Promise<IssueResult> {
  validateRepoParams(owner, repo);

  // Write body to a temp file to avoid any escaping issues
  const tempFile = join(tmpdir(), `gh-issue-body-${Date.now()}.md`);

  try {
    await writeFile(tempFile, params.body, "utf-8");

    const result = ghProvider.createIssueWithBodyFileSync(
      `${owner}/${repo}`,
      params.title,
      tempFile,
      params.labels,
    );

    if (!result) {
      throw new Error("Failed to create issue");
    }

    return result;
  } finally {
    // Clean up temp file
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Add a comment to an existing issue
 */
export async function addIssueComment(
  issueNumber: number,
  comment: string,
  owner: string = "sequant-io",
  repo: string = "sequant",
): Promise<void> {
  validateRepoParams(owner, repo);

  // Validate issue number
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }

  // Write comment to a temp file to avoid escaping issues
  const tempFile = join(tmpdir(), `gh-comment-${Date.now()}.md`);

  try {
    await writeFile(tempFile, comment, "utf-8");

    const success = ghProvider.commentOnIssueWithBodyFileSync(
      `${owner}/${repo}`,
      issueNumber,
      tempFile,
    );

    if (!success) {
      throw new Error(`Failed to comment on issue #${issueNumber}`);
    }
  } finally {
    // Clean up temp file
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create or link an issue for a finding
 */
export async function createOrLinkFinding(
  finding: Finding,
  version: string,
  assessmentIssueNumber: number | undefined,
  dryRun: boolean = false,
  owner: string = "sequant-io",
  repo: string = "sequant",
): Promise<Finding> {
  // Generate issue content
  const issueContent = generateFindingIssue(
    finding,
    version,
    assessmentIssueNumber,
  );

  // Check for duplicate
  const duplicate = await checkForDuplicate(issueContent.title, owner, repo);

  if (duplicate.isDuplicate && duplicate.existingIssue) {
    // Link to existing issue
    if (!dryRun) {
      await addIssueComment(
        duplicate.existingIssue,
        `Also relevant in Claude Code ${version} assessment${assessmentIssueNumber ? ` (#${assessmentIssueNumber})` : ""}.`,
        owner,
        repo,
      );
    }

    return {
      ...finding,
      existingIssue: duplicate.existingIssue,
    };
  }

  // Create new issue
  if (!dryRun) {
    const result = await createIssue(issueContent, owner, repo);
    return {
      ...finding,
      issueNumber: result.number,
    };
  }

  return finding;
}

/**
 * Create the assessment summary issue
 */
export async function createAssessmentIssue(
  title: string,
  body: string,
  dryRun: boolean = false,
  owner: string = "sequant-io",
  repo: string = "sequant",
): Promise<number | undefined> {
  if (dryRun) {
    return undefined;
  }

  const result = await createIssue(
    {
      title,
      body,
      labels: ["upstream", "assessment"],
    },
    owner,
    repo,
  );

  return result.number;
}
