/**
 * Loader for the Ink TUI module that forces React into its production build.
 *
 * `react-reconciler` (pulled in by `ink`) selects its dev-vs-prod bundle from
 * `process.env.NODE_ENV` **at module-evaluation time**. The development bundle
 * emits a `performance.measure()` per component render and never calls
 * `performance.clearMeasures()`. Driven by the TUI's 10 Hz poll over a long
 * `sequant run`, those entries accumulate in Node's global performance buffer
 * until it overflows its ~1,000,000-entry cap and prints
 * `MaxPerformanceEntryBufferExceededWarning` to stderr — a memory leak that
 * also corrupts the dashboard's in-place redraw (the stderr write scrolls the
 * terminal between log-update frames; see #647/#664).
 *
 * The TUI module is the *only* importer of `react`/`ink`/`react-reconciler`,
 * and it is always reached through a dynamic `import()`, so bracketing that one
 * import with `NODE_ENV=production` caches the production reconciler (which has
 * zero `performance.measure` calls). We restore `NODE_ENV` immediately after so
 * spawned child processes (claude phases, `npm install`, build steps) do NOT
 * inherit `NODE_ENV=production` — which would, e.g., make `npm install` skip
 * devDependencies.
 *
 * Only overrides when `NODE_ENV` is unset/empty: an explicit `development` or
 * `test` (the test runner) is respected so dev warnings remain available there.
 */
export async function loadTui(): Promise<typeof import("./index.js")> {
  const prev = process.env.NODE_ENV;
  const override = prev === undefined || prev === "";
  if (override) process.env.NODE_ENV = "production";
  try {
    return await import("./index.js");
  } finally {
    if (override) {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  }
}
