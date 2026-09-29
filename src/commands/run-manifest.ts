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

/**
 * #1209 AC-1: `run`'s manifest-missing pre-flight message. Names the minimal
 * manifest shape and the one-file fix (`init --manifest-only`) rather than
 * sending the user through the full `init` flow for a file that alone is
 * sufficient. Takes `packageVersion` as a parameter (not `getPackageVersion()`
 * internally) purely to keep this module free of the `../lib/manifest.js`
 * import cycle `run.ts` already has.
 */
export function manifestMissingMessage(packageVersion: string): string {
  const minimalManifest = JSON.stringify({
    version: packageVersion,
    stack: "generic",
    installedAt: new Date().toISOString(),
    files: {},
  });
  return (
    `❌ Sequant is not initialized. That file alone is sufficient: ` +
    `${minimalManifest} — write it yourself, or run \`sequant init --manifest-only\`.`
  );
}
