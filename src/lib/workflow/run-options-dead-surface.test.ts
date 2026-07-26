// @tautology-skip: this file asserts invariants about the *source text* of
// types.ts, so it calls no production function by design -- there is no runtime
// API for "does this interface still declare X". The detector reads that shape
// as asserting on a local value, which is the right default and the wrong call
// here. Claiming the exemption obliges proving the guard actually bites, so
// both assertions were mutation-tested: nine edits to types.ts (plain,
// `readonly`, quoted-key, spaced-`?`, same-line, and comment-truncated
// reintroductions; marker and doc-comment removals) were run against the real
// suite and eight failed as intended. The ninth is an equivalent mutant --
// dropping `(#810)` from one sentence, which the comment still cites in the
// next. Re-run that before trusting this pragma if the file changes shape.
//
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
 * `types.ts` with every comment removed.
 *
 * The reintroduction check has to tell a *declaration* from a *mention*, and
 * the only thing that reliably separates those is whether the text is code or
 * a comment. Earlier drafts tried to encode that as a line-anchored pattern,
 * which managed to be both too strict and too loose: it still missed
 * `readonly x?: b`, `"x"?: b`, `x ?: b`, and a field sharing a line with its
 * predecessor -- all valid TypeScript -- while remaining one prose sentence
 * away from a false positive. Deleting the comments removes the ambiguity at
 * its source, which is what lets the declaration pattern stay permissive
 * without ever matching prose.
 *
 * Deliberately a function, not a module-level const: the repo's tautology
 * detector reads an `it()` block that calls nothing as asserting on a local
 * value, and flagged the check below when this was a const. The complaint was
 * fair about the shape even though the check does real work, and this also
 * makes both tests read the same way -- each opens by calling the extractor it
 * depends on.
 */
function runOptionsCode(): string {
  return typesSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

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
      if (depth === 0) {
        // The interface's real closing brace sits at column 0; every brace
        // inside the body is indented. A stray `}` in a doc comment would
        // close the walk early and hand back a truncated body, which callers
        // would then scan clean without ever knowing they saw a fragment.
        // Refuse the slice rather than return a partial one.
        if (i > 0 && typesSource[i - 1] !== "\n") {
          throw new Error(
            "RunOptions brace-walk stopped at an indented `}` (likely a stray " +
              "brace in a doc comment) — refusing a possibly truncated body.",
          );
        }
        return typesSource.slice(open, i + 1);
      }
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
    // Three deliberate choices, each one a hole a previous draft fell into:
    //
    // 1. Matched against comment-stripped code, not raw source. The first
    //    draft searched for a bare `\breuseWorktrees\b` substring and failed
    //    immediately -- on the doc comment below, which names the removed
    //    field in prose. A guard that trips on any mention of the thing it
    //    guards cannot survive its own rationale being written down.
    //
    // 2. Scanned across the WHOLE file, not the `runOptionsBody()` slice. That
    //    slice can be truncated by a stray `}` in a doc comment, and a field
    //    declared past the truncation point then reads as absent -- a silently
    //    passing guard, the exact defect class #810 exists to remove. A
    //    `reuseWorktrees` declaration anywhere in this file is a regression
    //    regardless of which interface holds it.
    //
    // 3. Permissive about the shape of the declaration. Anchoring to
    //    `^\s*name` looked precise but silently missed four valid TypeScript
    //    spellings -- `readonly reuseWorktrees?:`, `"reuseWorktrees"?:`,
    //    `reuseWorktrees ?:`, and a field sharing a line with its predecessor.
    //    Precision in the wrong dimension is just a blind spot with a tidy
    //    regex. Comment-stripping (choice 1) is what makes this safe: with no
    //    prose left to match, the pattern can afford to be generous.
    expect(runOptionsCode()).not.toMatch(/\breuseWorktrees\b["']?\s*\??\s*:/);
  });

  it("marks experimentalTui as intentionally inert so sweeps do not re-flag it", () => {
    // The marker must sit in experimentalTui's OWN doc comment, not merely
    // somewhere in the file -- a sweeper reads the declaration site, so that
    // is where the answer has to be.
    const body = runOptionsBody();

    // Located by pattern rather than the exact string `experimentalTui?:
    // boolean;`. An exact match would quietly stop finding the declaration if
    // the type were widened to `boolean | undefined`, a `readonly` added, or
    // prettier rewrapped the line -- and "declaration not found" would then be
    // indistinguishable from "marker absent" to anyone reading the failure.
    const declMatch = /\bexperimentalTui\b["']?\s*\??\s*:/.exec(body);
    expect(declMatch, "experimentalTui declaration not found").not.toBeNull();
    const decl = declMatch!.index;

    const commentStart = body.lastIndexOf("/**", decl);
    expect(
      commentStart,
      "experimentalTui has no preceding doc comment at all",
    ).toBeGreaterThan(-1);

    // Guard against borrowing a *neighbour's* comment: if experimentalTui's own
    // doc block were deleted, `lastIndexOf` would happily return the previous
    // field's block and scan that instead. Nothing but whitespace may sit
    // between the comment's `*/` and the declaration.
    const between = body.slice(body.indexOf("*/", commentStart) + 2, decl);
    expect(
      between.trim(),
      "the nearest doc comment belongs to a different field",
    ).toBe("");

    const docComment = body.slice(commentStart, decl);
    expect(docComment).toMatch(/INTENTIONALLY INERT/);
    expect(docComment).toMatch(/#810/);
  });
});
