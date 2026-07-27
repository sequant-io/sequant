/**
 * `sequant assess-render <file>` — render an `AssessResult` JSON payload (#823).
 *
 * Internal surface. The `/assess` skill builds the JSON, calls this, and pastes
 * stdout verbatim. Shipping it as a CLI subcommand rather than a `scripts/`
 * shell-out is what makes the fix reach end users: `skills/spec/SKILL.md:78`
 * establishes that skills may only run `npx tsx` blocks when the sequant source
 * tree is present, so a script would work in this repo and nowhere else. A
 * subcommand ships via `package.json` `bin` + `files: ["dist", ...]` and is
 * present for every sequant install by definition.
 *
 * All output goes to stdout unmodified — no chalk, no boxes, no TTY branching —
 * because the caller pastes it into a chat transcript and a GitHub comment.
 */

import { readFile } from "node:fs/promises";

import { render } from "../lib/assess/renderer.js";
import {
  AssessResultValidationError,
  parseAssessResult,
} from "../lib/assess/types.js";

/**
 * Read, validate, and render an `AssessResult` file.
 *
 * Exits non-zero with a readable stderr message when the file is missing,
 * unreadable, not JSON, or fails schema validation — the skill's Step 6 treats a
 * non-zero exit as its signal to fall back to a hand-drawn dashboard rather than
 * silently emitting nothing.
 */
export async function assessRenderCommand(file: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`assess-render: cannot read ${file}\n  ${reason}`);
    process.exitCode = 1;
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`assess-render: ${file} is not valid JSON\n  ${reason}`);
    process.exitCode = 1;
    return;
  }

  try {
    console.log(render(parseAssessResult(payload)));
  } catch (error) {
    if (error instanceof AssessResultValidationError) {
      console.error(`assess-render: ${file} — ${error.message}`);
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`assess-render: failed to render ${file}\n  ${reason}`);
    }
    process.exitCode = 1;
  }
}
