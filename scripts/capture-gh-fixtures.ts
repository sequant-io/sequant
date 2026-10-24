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
 * Read-only by construction: `assertReadOnly` allows only reading verbs
 * (view, list, status, checks, diff), `--version`, and `api` calls with no
 * method or body flag in any spelling. Write paths get hand-written fixtures
 * marked `"provenance": "hand-written"`; never capture one by running it.
 * Captured output passes through `redact` before it is written, because the
 * fixtures are committed to a public repo.
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
    name: "issue-list-closed-with-body",
    args: [
      "issue",
      "list",
      "--state",
      "closed",
      "--search",
      "closed:>=2026-10-20",
      "--json",
      "number,closedAt,body",
      "--limit",
      "2",
    ],
  },
  {
    name: "pr-list-merged-with-comments",
    args: [
      "pr",
      "list",
      "--state",
      "merged",
      "--search",
      "merged:>=2026-10-20",
      "--json",
      "number,mergedAt,comments",
      "--limit",
      "2",
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

/**
 * `gh <noun> <verb>` verbs that only read. Positive list (#1506 security
 * review): a verb not named here is refused, so a new writing verb cannot
 * slip through the way it could past a list of known writers.
 */
const READ_VERBS = new Set(["view", "list", "status", "checks", "diff"]);

/**
 * `gh api` flags that send a body (and so imply POST) or pick a method, in
 * every spelling cobra accepts: `-X POST`, `-XPOST`, `--method=POST`,
 * `-fkey=v`, `--field=k=v`, `--input=-`.
 */
const API_WRITE_FLAG =
  /^(-X|-f|-F|--method|--field|--raw-field|--input)(=|$)|^-[XfF].+/;

/** Throw unless `args` is a call that only reads. */
export function assertReadOnly(args: string[]): void {
  if (args.length === 1 && args[0] === "--version") return;
  if (args[0] === "api") {
    const flag = args.find((a) => API_WRITE_FLAG.test(a));
    if (flag) {
      throw new Error(
        `refusing to capture a writing gh call (\`api ${flag}\`): hand-write that fixture`,
      );
    }
    if (args[1] === "graphql") {
      throw new Error(
        "refusing to capture a writing gh call (`api graphql`): hand-write that fixture",
      );
    }
    return;
  }
  if (args.length < 2 || !READ_VERBS.has(args[1])) {
    throw new Error(
      `refusing to capture a writing gh call (\`gh ${args.slice(0, 2).join(" ")}\`): hand-write that fixture`,
    );
  }
}

/**
 * Values a captured fixture must never carry (#1506 security review): the
 * fixture is committed to a public repo verbatim. Each pattern is replaced by
 * a fixed placeholder, so a fixture stays deterministic across captures.
 */
const REDACTIONS: [RegExp, string][] = [
  [
    /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g,
    "https://claude.ai/code/<session-redacted>",
  ],
  [/\bcse_[A-Za-z0-9]+/g, "cse_REDACTED"],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1REDACTED"],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-REDACTED"],
  [/\/(Users|home)\/[^/\s"'`\\]+/g, "/$1/<redacted>"],
  [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    "redacted@example.com",
  ],
];

/** Replace every secret-shaped value in captured gh output with a placeholder. */
export function redact(text: string): string {
  return REDACTIONS.reduce((out, [re, to]) => out.replace(re, to), text);
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
    stdout: entry.scrub ? "" : redact(String(result.stdout ?? "")),
    stderr: entry.scrub ? "" : redact(String(result.stderr ?? "")),
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
