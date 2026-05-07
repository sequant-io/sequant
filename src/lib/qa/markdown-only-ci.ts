/**
 * Markdown-only CI relaxation helpers used by the `/qa` verdict algorithm.
 *
 * When a diff touches only documentation/markdown files (no source, no
 * configuration that affects builds), pending CI checks like the build matrix
 * cannot meaningfully fail. `/qa` uses these helpers to detect such diffs and
 * partition pending CI checks into a "relaxed" bucket (informational, does not
 * gate the verdict) and a "gating" bucket (still gates `READY_FOR_MERGE`).
 *
 * Failed CI checks are NOT relaxed — they always gate regardless of diff type.
 */

/**
 * Predicate: does the given changed-file list qualify as a markdown-only diff?
 *
 * A file qualifies only if it ends in `.md` (case-insensitive) AND is not
 * inside `.github/workflows/`. Any non-`.md` file (including `package.json`,
 * `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `tsconfig*.json`, and
 * `*.config.{js,ts,mjs,cjs}`) automatically disqualifies the diff because it
 * does not end in `.md`.
 *
 * @param files - Paths from `git diff --name-only`. Forward slashes; relative to repo root.
 * @returns `true` if every changed file is markdown and none are workflow files.
 */
export function detectMarkdownOnlyDiff(files: string[]): boolean {
  if (files.length === 0) return false;

  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) return false;
    if (file.startsWith(".github/workflows/")) return false;
  }

  return true;
}

/**
 * Result of partitioning pending CI checks against the safe-pattern allowlist.
 */
export interface RelaxedPendingResult {
  /** Pending check names that match a safe pattern — informational only. */
  relaxed: string[];
  /** Pending check names that do NOT match a safe pattern — still gate the verdict. */
  gating: string[];
}

/**
 * Partition a list of pending CI check names into "relaxed" (allowlisted) and
 * "gating" (everything else).
 *
 * Patterns support a single `*` wildcard which matches any sequence of
 * characters (greedy). Special regex characters are otherwise escaped, so
 * patterns like `build (*)` or `Plugin Structure Validation` work as written.
 *
 * @param pendingCheckNames - Names of CI checks currently in a pending state.
 * @param safePatterns - Glob-like patterns for safe-to-ignore checks.
 * @returns Buckets for relaxed and gating checks.
 */
export function filterRelaxablePending(
  pendingCheckNames: string[],
  safePatterns: string[],
): RelaxedPendingResult {
  if (safePatterns.length === 0) {
    return { relaxed: [], gating: [...pendingCheckNames] };
  }

  const matchers = safePatterns.map(globToRegex);
  const relaxed: string[] = [];
  const gating: string[] = [];

  for (const name of pendingCheckNames) {
    if (matchers.some((re) => re.test(name))) {
      relaxed.push(name);
    } else {
      gating.push(name);
    }
  }

  return { relaxed, gating };
}

/**
 * Translate a single-`*`-wildcard glob into an anchored RegExp.
 *
 * `build (*)` → `/^build \(.*\)$/`
 * `Plugin Structure Validation` → `/^Plugin Structure Validation$/`
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const wildcarded = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${wildcarded}$`);
}
