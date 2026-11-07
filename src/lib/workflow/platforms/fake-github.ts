/**
 * FakeGitHubProvider — the real {@link GitHubProvider} with a runner that
 * replays captured `gh` output (#1506).
 *
 * Only the runner is fake. Parsing, error handling and the error class are
 * the production code's, so a fixture with `exitCode: 1` throws the same
 * `GhCommandError` a failing `gh` does, and a sync helper returns what it
 * would return for that output.
 */

import { GitHubProvider } from "./github.js";
import { fixtureRunner, type GhCall, type GhFixture } from "./gh-fixtures.js";

export class FakeGitHubProvider extends GitHubProvider {
  /** Every gh call made, in order. */
  readonly calls: GhCall[];

  constructor(...fixtures: GhFixture[]) {
    const calls: GhCall[] = [];
    super({ run: fixtureRunner(fixtures, calls) });
    this.calls = calls;
  }
}
