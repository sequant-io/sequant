/**
 * Captured `gh` output, replayed through the provider's runner seam (#1506).
 *
 * Each fixture under `__fixtures__/gh/` was produced by
 * `scripts/capture-gh-fixtures.ts` running the real `gh`, or is hand-written
 * for a write path the script must never run. A test that needs a variant
 * (another issue number, a closed state) derives it from a captured fixture
 * with {@link deriveGhFixture}, so the output shape stays the one gh prints.
 *
 * This module does not import `github.ts`: a test can `vi.mock` the provider
 * module and still load fixtures from here.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import type { GhRunner, GhRunOptions, GhRunResult } from "./github.js";

export const GH_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "gh",
);

export const GH_CAPTURE_SCRIPT = "scripts/capture-gh-fixtures.ts";

/** An argv token in a fixture that matches any single token in the call. */
export const ANY_ARG = "<*>";

export interface GhFixture {
  /** File stem under `__fixtures__/gh/`. */
  name: string;
  /** The command line that produced the output. */
  command: string;
  /** The argv the provider sends; what a call is matched against. */
  args: string[];
  capturedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  provenance: "captured" | "hand-written" | "derived";
  signal?: NodeJS.Signals;
  /** A failed spawn (ENOENT, ETIMEDOUT): the runner reports it as `error`. */
  error?: { message: string; code: string };
  /** The fixture this one was derived from. */
  derivedFrom?: string;
}

/** A `gh` call no fixture matches. Capture one rather than inventing output. */
export class GhFixtureMissingError extends Error {
  constructor(args: string[]) {
    super(
      `No gh fixture matches \`gh ${args.join(" ")}\`. Capture one with ` +
        `\`npx tsx ${GH_CAPTURE_SCRIPT}\`, or derive one from a captured ` +
        `fixture with deriveGhFixture().`,
    );
    this.name = "GhFixtureMissingError";
  }
}

export function loadGhFixture(name: string): GhFixture {
  const raw = JSON.parse(
    readFileSync(join(GH_FIXTURE_DIR, `${name}.json`), "utf-8"),
  ) as Omit<GhFixture, "name">;
  return { ...raw, name };
}

/**
 * A variant of a fixture. `json` rewrites the parsed stdout, so the variant
 * keeps the captured shape; every other field replaces the base's.
 */
export function deriveGhFixture(
  base: GhFixture,
  changes: Partial<
    Pick<
      GhFixture,
      "args" | "exitCode" | "stdout" | "stderr" | "signal" | "error"
    >
  > & {
    json?: (data: unknown) => unknown;
  },
): GhFixture {
  const { json, ...rest } = changes;
  const stdout = json
    ? JSON.stringify(json(JSON.parse(base.stdout)))
    : base.stdout;
  return {
    ...base,
    stdout,
    ...rest,
    provenance: "derived",
    derivedFrom: base.name,
  };
}

function matches(pattern: string[], args: string[]): boolean {
  return (
    pattern.length === args.length &&
    pattern.every((token, i) => token === ANY_ARG || token === args[i])
  );
}

/** One call a fixture runner answered. */
export interface GhCall {
  args: string[];
  opts: GhRunOptions;
}

/**
 * A {@link GhRunner} that answers from fixtures. The last matching fixture
 * wins, so a test can layer a variant over a default. Every call is pushed
 * onto `calls`; an unmatched one throws {@link GhFixtureMissingError}.
 */
export function fixtureRunner(
  fixtures: GhFixture[],
  calls: GhCall[] = [],
): GhRunner {
  return (args, opts): GhRunResult => {
    calls.push({ args, opts });
    const fixture = [...fixtures].reverse().find((f) => matches(f.args, args));
    if (!fixture) throw new GhFixtureMissingError(args);
    return {
      status: fixture.exitCode,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
      signal: fixture.signal ?? null,
      ...(fixture.error
        ? {
            error: Object.assign(new Error(fixture.error.message), {
              code: fixture.error.code,
            }),
          }
        : {}),
    };
  };
}
