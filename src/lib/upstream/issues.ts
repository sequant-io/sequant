/**
 * GitHub issue management for upstream assessments
 * Handles issue creation, deduplication, and commenting
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  DuplicateCheckResult,
  Finding,
  IssueParams,
  IssueResult,
} from "./types.js";
import { generateFindingIssue } from "./report.js";

const execAsync = promisify(exec);

/**
 * Check if a similar upstream issue already exists
 */
export async function checkForDuplicate(
  title: string,
  owner: string = "admarble",
  repo: string = "sequant",
): Promise<DuplicateCheckResult> {
  try {
    // Search for existing upstream issues with similar title
    // Extract key terms from title for search
    const searchTerms = extractSearchTerms(title);

    const { stdout } = await execAsync(
      `gh issue list --repo ${owner}/${repo} --label upstream --search "${searchTerms}" --json number,title --limit 10`,
    );

    const issues = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
    }>;

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
function extractSearchTerms(title: string): string {
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
function isSimilarTitle(title1: string, title2: string): boolean {
  const terms1 = new Set(extractSearchTerms(title1).split(" "));
  const terms2 = new Set(extractSearchTerms(title2).split(" "));

  // Calculate Jaccard similarity
  const intersection = new Set([...terms1].filter((x) => terms2.has(x)));
  const union = new Set([...terms1, ...terms2]);

  const similarity = intersection.size / union.size;

  // Consider similar if > 60% overlap
  return similarity > 0.6;
}

/**
 * Create a GitHub issue
 */
export async function createIssue(
  params: IssueParams,
  owner: string = "admarble",
  repo: string = "sequant",
): Promise<IssueResult> {
  const labelsArg = params.labels.map((l) => `--label "${l}"`).join(" ");

  // Use heredoc to avoid shell escaping issues
  const command = `gh issue create --repo ${owner}/${repo} --title "${escapeShell(params.title)}" ${labelsArg} --body "$(cat <<'EOF'
${params.body}
EOF
)"`;

  const { stdout } = await execAsync(command);

  // Parse issue URL from output
  const url = stdout.trim();
  const numberMatch = url.match(/\/issues\/(\d+)$/);
  const number = numberMatch ? parseInt(numberMatch[1], 10) : 0;

  return { number, url };
}

/**
 * Add a comment to an existing issue
 */
export async function addIssueComment(
  issueNumber: number,
  comment: string,
  owner: string = "admarble",
  repo: string = "sequant",
): Promise<void> {
  const command = `gh issue comment ${issueNumber} --repo ${owner}/${repo} --body "$(cat <<'EOF'
${comment}
EOF
)"`;

  await execAsync(command);
}

/**
 * Create or link an issue for a finding
 */
export async function createOrLinkFinding(
  finding: Finding,
  version: string,
  assessmentIssueNumber: number | undefined,
  dryRun: boolean = false,
  owner: string = "admarble",
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
  owner: string = "admarble",
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

/**
 * Escape shell special characters
 */
function escapeShell(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}
