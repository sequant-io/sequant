/**
 * "Latest attempt" accessors for per-attempt phase lists (#1245).
 *
 * `phaseResults` (in-memory) and the run log's `issues[].phases[]` record one
 * entry per attempt with no iteration index, and a quality-loop iteration
 * re-runs the whole phase list, so a looped run holds
 * `[spec, exec, qa, loop, exec, qa]`. Readers that mean "what the run ended
 * with" take the LAST match; `.find()` returns the first-iteration entry.
 *
 * Reverse scans rather than `findLast`: tsconfig pins `lib: ES2022` and
 * `findLast` is ES2023.
 */

/** The LAST item satisfying `predicate`, or undefined when none does. */
export function latestWhere<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return items[i];
  }
  return undefined;
}

/** The LAST entry recorded for `phase`, or undefined when it never ran. */
export function latestPhaseResult<T extends { phase: string }>(
  items: readonly T[],
  phase: string,
): T | undefined {
  return latestWhere(items, (p) => p.phase === phase);
}
