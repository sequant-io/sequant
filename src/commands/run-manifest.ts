/**
 * The manifest subset `run` hands to the orchestrator (#932).
 *
 * `packageManager` is forwarded *verbatim* — an undeclared manager stays
 * `undefined` so `resolvePackageManager` consults the lockfile at provisioning
 * time. Substituting any default here (the literal `?? "npm"` this replaced,
 * or an alias that does the same in two steps) short-circuits that detection
 * with a valid `PM_CONFIG` key, which is the bug #932 fixed. Lives in its own
 * module so `run.ts` stays under its #503 200-LOC cap and so the real init
 * path is what `run.manifest-init.test.ts` exercises.
 */
export function manifestForRun(manifest: {
  stack: string;
  packageManager?: string;
}): { stack: string; packageManager: string | undefined } {
  return {
    stack: manifest.stack,
    packageManager: manifest.packageManager,
  };
}
