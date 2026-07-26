/**
 * Dead-surface guard for RunOptions (#810).
 *
 * `reuseWorktrees` was declared in `RunOptions` with a behavior-promising doc
 * comment ("Reuse existing worktrees instead of creating new ones"), but had no
 * CLI flag and no consumer anywhere in `src/`, `bin/`, or `scripts/`. It was
 * removed in #810 rather than implemented: with no flag exposing it, no user
 * could pass it, so there was no behavior to preserve — only a comment
 * asserting an effect the codebase never delivered.
 *
 * These tests are greppable guards, not behavior tests. They exist because this
 * defect class has now recurred twice (#795's `--qa-gate`, #810's
 * `reuseWorktrees`), and because the *opposite* mistake — deleting a flag that
 * is inert on purpose — is just as costly. `experimentalTui` is the standing
 * example of deliberate inertness, so a future sweep needs a signal at the
 * declaration site telling it apart from genuine dead surface.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const typesPath = join(dirname(fileURLToPath(import.meta.url)), "types.ts");
const typesSource = readFileSync(typesPath, "utf8");

/**
 * Slice out the `RunOptions` interface body so assertions cannot accidentally
 * match an unrelated declaration elsewhere in the file.
 */
function runOptionsBody(): string {
  const start = typesSource.indexOf("interface RunOptions");
  expect(start, "RunOptions interface not found in types.ts").toBeGreaterThan(
    -1,
  );

  // Walk braces from the interface's opening `{` to its matching close.
  const open = typesSource.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < typesSource.length; i++) {
    if (typesSource[i] === "{") depth++;
    else if (typesSource[i] === "}") {
      depth--;
      if (depth === 0) return typesSource.slice(open, i + 1);
    }
  }
  throw new Error("Unbalanced braces while scanning RunOptions");
}

describe("RunOptions dead-surface guard (#810)", () => {
  it("does not declare reuseWorktrees", () => {
    // Guards against silent reintroduction. If worktree reuse is genuinely
    // wanted later, it must arrive with a CLI flag and a runtime consumer --
    // re-adding a bare field puts the same misleading comment back.
    //
    // Anchored to a line-start field declaration, NOT a bare `\breuseWorktrees\b`
    // substring. The first draft used the substring form and failed immediately
    // on the doc comment below that names the removed field in prose. A guard
    // that trips on any mention of the thing it guards cannot survive its own
    // rationale being written down.
    expect(runOptionsBody()).not.toMatch(/^\s*reuseWorktrees\??\s*:/m);
  });

  it("marks experimentalTui as intentionally inert so sweeps do not re-flag it", () => {
    // The marker must sit in experimentalTui's own doc comment, not merely
    // somewhere in the file -- a sweeper reads the declaration site.
    const body = runOptionsBody();
    const decl = body.indexOf("experimentalTui?: boolean;");
    expect(decl, "experimentalTui declaration not found").toBeGreaterThan(-1);

    const commentStart = body.lastIndexOf("/**", decl);
    const docComment = body.slice(commentStart, decl);

    expect(docComment).toMatch(/INTENTIONALLY INERT/);
    expect(docComment).toMatch(/#810/);
  });
});
