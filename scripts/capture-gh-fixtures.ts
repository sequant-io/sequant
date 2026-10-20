#!/usr/bin/env npx tsx
/**
 * Capture `gh` fixtures for FakeGitHubProvider (#1506).
 *
 * Runs the real `gh` for each read-only call below against the public
 * sequant-io/sequant repo and writes what it printed to
 * `src/lib/workflow/platforms/__fixtures__/gh/<name>.json`, stamped with the
 * command, the capture time and the exit code. Tests replay these through
 * the provider's runner seam instead of faking gh through `child_process`.
 *
 * Read-only by construction: `assertReadOnly` refuses any argv that would
 * write (comment, create, edit, merge, an `api` call with a method or a
 * body). Write paths get hand-written fixtures marked
 * `"provenance": "hand-written"`; never capture one by running it.
 *
 * Usage:
 *   npx tsx scripts/capture-gh-fixtures.ts            # every fixture below
 *   npx tsx scripts/capture-gh-fixtures.ts issue-view # only the named ones
 */

import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

import { GH_FIXTURE_DIR } from "../src/lib/workflow/platforms/gh-fixtures.js";

const REPO = "sequant-io/sequant";
/** A closed issue with comments, and the merged PR that closed it. */
const ISSUE = "1475";
const PR = "1563";
const PR_HEAD_BRANCH =
  "feature/1475-refactor-workflow-locks-worktreestatus-tri-state-r";
/** No PR has ever had this head branch. */
const MISSING_BRANCH = "feature/0-no-such-branch";
const PR_HEAD_SHA = "80e63c3f1bf6c38b8b5c734432bffb1ed06e4cfe";
/** No issue or PR has this number, so gh exits 1 with its not-found error. */
const MISSING_ISSUE = "999999";

interface Capture {
  name: string;
  /** The argv the provider sends; what the fake matches calls against. */
  args: string[];
  /** The argv actually run, when it differs (an explicit repo). */
  run?: string[];
  /** Drop stdout and stderr; keep only the exit code. */
  scrub?: boolean;
}

const ISSUE_VIEW_FULL = ["--json", "number,title,body,labels,state"];

export const CAPTURES: Capture[] = [
  { name: "issue-view", args: ["issue", "view", ISSUE, ...ISSUE_VIEW_FULL] },
  {
    name: "issue-view-not-found",
    args: ["issue", "view", MISSING_ISSUE, ...ISSUE_VIEW_FULL],
  },
  {
    name: "issue-comments",
    args: [
      "issue",
      "view",
      ISSUE,
      "--json",
      "comments",
      "--jq",
      "[.comments[] | {body: .body, createdAt: .createdAt}]",
    ],
  },
  {
    name: "issue-comment-bodies",
    args: [
      "issue",
      "view",
      ISSUE,
      "--json",
      "comments",
      "--jq",
      "[.comments[].body]",
    ],
  },
  {
    name: "issue-view-title",
    args: ["issue", "view", ISSUE, "--json", "title", "--jq", ".title"],
  },
  {
    name: "issue-view-body",
    args: ["issue", "view", ISSUE, "--json", "body", "--jq", ".body"],
  },
  {
    name: "issue-list-closed",
    args: [
      "issue",
      "list",
      "--state",
      "closed",
      "--json",
      "number,title,closedAt,labels",
      "--limit",
      "3",
    ],
  },
  {
    name: "pr-view-state",
    args: ["pr", "view", PR, "--json", "state", "-q", ".state"],
  },
  {
    name: "pr-view-head-branch",
    args: ["pr", "view", PR, "--json", "headRefName", "--jq", ".headRefName"],
  },
  {
    name: "pr-view-head-sha",
    args: ["pr", "view", PR, "--json", "headRefOid", "-q", ".headRefOid"],
  },
  {
    name: "pr-view-mergeable",
    args: ["pr", "view", PR, "--json", "mergeable", "-q", ".mergeable"],
  },
  {
    name: "pr-view-status-check-rollup",
    args: [
      "pr",
      "view",
      PR,
      "--json",
      "statusCheckRollup",
      "-q",
      ".statusCheckRollup",
    ],
  },
  {
    name: "pr-view-by-branch",
    args: ["pr", "view", PR_HEAD_BRANCH, "--json", "number,url,body"],
  },
  {
    name: "pr-view-by-branch-none",
    args: ["pr", "view", MISSING_BRANCH, "--json", "number,url,body"],
  },
  {
    name: "pr-list-open-files",
    args: [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,headRefName,files",
    ],
  },
  {
    name: "release-list",
    args: [
      "release",
      "list",
      "--repo",
      REPO,
      "--limit",
      "3",
      "--json",
      "tagName,publishedAt",
    ],
  },
  {
    name: "release-view-latest",
    args: [
      "release",
      "view",
      "--repo",
      REPO,
      "--json",
      "tagName,name,body,publishedAt",
    ],
  },
  {
    name: "label-list",
    args: ["label", "list", "--repo", REPO, "--json", "name", "--limit", "200"],
  },
  {
    name: "issue-search",
    args: [
      "issue",
      "list",
      "--repo",
      REPO,
      "--label",
      "planned",
      "--search",
      "PlatformProvider",
      "--json",
      "number,title",
      "--limit",
      "5",
    ],
  },
  {
    name: "check-runs",
    args: [
      "api",
      `repos/{owner}/{repo}/commits/${PR_HEAD_SHA}/check-runs?per_page=100`,
      "-q",
      ".check_runs",
    ],
    run: [
      "api",
      `repos/${REPO}/commits/${PR_HEAD_SHA}/check-runs?per_page=100`,
      "-q",
      ".check_runs",
    ],
  },
  { name: "gh-version", args: ["--version"], run: ["--version"] },
  // Auth output names the account and token scopes: keep the exit code only.
  {
    name: "auth-status",
    args: ["auth", "status"],
    run: ["auth", "status"],
    scrub: true,
  },
];

/** `gh <noun> <verb>` pairs that change something on GitHub. */
const WRITE_VERBS = new Set([
  "comment",
  "create",
  "edit",
  "merge",
  "close",
  "reopen",
  "delete",
  "lock",
  "unlock",
  "transfer",
  "ready",
  "review",
  "upload",
  "pin",
  "unpin",
  "develop",
]);

/** `gh api` flags that send a body (and so imply POST) or pick a method. */
const API_WRITE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
]);

/** Throw unless `args` is a call that only reads. */
export function assertReadOnly(args: string[]): void {
  if (args[0] === "api") {
    const flag = args.find(
      (a) =>
        API_WRITE_FLAGS.has(a) || /^--(method|field|raw-field|input)=/.test(a),
    );
    if (flag) {
      throw new Error(
        `refusing to capture a writing gh call (\`api ${flag}\`): hand-write that fixture`,
      );
    }
    return;
  }
  if (args.length >= 2 && WRITE_VERBS.has(args[1])) {
    throw new Error(
      `refusing to capture a writing gh call (\`gh ${args[0]} ${args[1]}\`): hand-write that fixture`,
    );
  }
}

function argvFor(capture: Capture): string[] {
  if (capture.run) return capture.run;
  return capture.args.includes("--repo")
    ? capture.args
    : [...capture.args, "--repo", REPO];
}

/** Run real `gh` for one capture and write its fixture into `dir`. */
export function capture(entry: Capture, dir: string = GH_FIXTURE_DIR): void {
  const argv = argvFor(entry);
  assertReadOnly(argv);
  const result = spawnSync("gh", argv, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 30000,
  });
  if (result.error || result.status === null) {
    throw new Error(
      `gh ${argv.join(" ")} could not run: ${result.error?.message ?? `killed by ${result.signal}`}`,
    );
  }
  const fixture = {
    command: `gh ${argv.join(" ")}`,
    args: entry.args,
    capturedAt: new Date().toISOString(),
    exitCode: result.status,
    stdout: entry.scrub ? "" : String(result.stdout ?? ""),
    stderr: entry.scrub ? "" : String(result.stderr ?? ""),
    provenance: "captured",
    ...(entry.scrub ? { note: "stdout and stderr scrubbed" } : {}),
  };
  const path = join(dir, `${entry.name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`${entry.name}: exit ${result.status} -> ${path}`);
}

function main(only: string[]): void {
  const selected = only.length
    ? CAPTURES.filter((c) => only.includes(c.name))
    : CAPTURES;
  const unknown = only.filter((n) => !CAPTURES.some((c) => c.name === n));
  if (unknown.length) {
    console.error(`unknown capture(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  for (const entry of selected) capture(entry);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
