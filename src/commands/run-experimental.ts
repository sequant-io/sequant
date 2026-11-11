/** #1651: fixed "experimental" warnings for --chain and multi-issue runs (W-1). */

// Counts are fixed text from sequant's own metrics (P-7): never recomputed.
export const CHAIN_EXPERIMENTAL_WARNING =
  "⚠ --chain is experimental: 3 of 9 recorded --chain runs succeeded (sequant's own runs to 2026-10-28; 2 of 7 in #604). Single-issue runs: 301 of 366.";

export const MULTI_ISSUE_EXPERIMENTAL_WARNING =
  "⚠ Multi-issue runs are experimental: 41 of 87 recorded multi-issue runs succeeded, against 301 of 366 single-issue runs (sequant's own runs, 2026-01-21 to 2026-10-28).";

/** Print the warnings once per run to stderr, chain line first (W-1, W-2). */
export function emitExperimentalWarnings(
  issues: string[],
  options: { chain?: boolean },
  batches: number[][] | null = null,
): void {
  const count = batches ? batches.flat().length : issues.length;
  if (options.chain) console.error(CHAIN_EXPERIMENTAL_WARNING);
  if (count > 1) console.error(MULTI_ISSUE_EXPERIMENTAL_WARNING);
}
