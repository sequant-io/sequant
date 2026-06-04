// Issue #711 — AC-2: `.claude/.local/hooks/` is NOT an auto-discovered execution
// location. Claude Code only fires hooks registered in a settings `hooks` block;
// sequant itself never scans or executes anything under `.local/hooks/`. The
// docs (docs/guides/customization.md "Customizing Hooks") tell users to register
// the script in `.claude/settings.local.json` precisely because dropping a file
// in `.local/hooks/` alone runs nothing.
//
// This test makes that claim code-backed rather than asserted: it greps the
// whole `src/` tree and fails if any code path references `.local/hooks` for
// discovery/execution. The only sanctioned `.local/` references are the
// update-safety skip (templates.ts) and the cosmetic status check (status.ts) —
// neither of which executes a hook.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test files — they legitimately mention the path in prose.
      out.push(...walk(full));
    } else if (
      /\.ts$/.test(entry.name) &&
      !/\.test\.ts$/.test(entry.name) &&
      !/\.spec\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("AC-2: no .local/hooks/ auto-discovery in sequant", () => {
  it("no source file references `.local/hooks` for execution", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const content = fs.readFileSync(file, "utf8");
      // Any literal reference to a `.local/hooks` path in non-test source would
      // imply sequant tries to read/run hooks from there.
      if (/\.local[/\\]hooks/.test(content)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(
      offenders,
      `Unexpected .local/hooks reference(s) in src/: ${offenders.join(", ")}. ` +
        `Hooks must be registered via settings, not auto-discovered from .local/hooks/.`,
    ).toEqual([]);
  });
});
