/**
 * #1652 AC-2 (E-2): the qa prompt carries the needs-human ACs in the one
 * sentinel block `getPhasePrompt` appends, and an issue with none gets no
 * reach block. Every other phase's prompt is covered at the dispatch seam in
 * `evidence-reach-dispatch.test.ts` (#1688).
 */

import { describe, it, expect } from "vitest";
import { getPhasePrompt, PROMPT_CONTEXT_SENTINEL } from "./phase-executor.js";
import {
  joinEvidenceReachContext,
  needsHumanAcs,
} from "../evidence-reach.js";

const COMMAND = "npx tsx --env-file=.env.local scripts/dev/query.ts --limit 5";
const OPEN = `<!-- ${PROMPT_CONTEXT_SENTINEL} -->`;

async function qaPrompt(
  items: Array<{ id: string; evidence?: string }>,
  promptContext?: string,
): Promise<string> {
  const joined = joinEvidenceReachContext(
    promptContext,
    "qa",
    needsHumanAcs(items),
  );
  return getPhasePrompt("qa", 1652, undefined, joined);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("qa prompt evidence reach block (#1652 AC-2)", () => {
  it("names the one needs-human AC and its command verbatim in exactly one sentinel block", async () => {
    const prompt = await qaPrompt([
      { id: "AC-1", evidence: "`npx vitest run a.test.ts` → `3 passed`" },
      { id: "AC-2", evidence: `\`${COMMAND}\` → rows` },
    ]);

    expect(count(prompt, OPEN)).toBe(1);
    const block = prompt.slice(prompt.indexOf(OPEN));
    expect(block).toContain(`- AC-2: \`${COMMAND}\``);
    expect(block).toContain("Do not run them");
    expect(block).not.toContain("AC-1");
  });

  it("gives an issue with no needs-human AC no reach block", async () => {
    const prompt = await qaPrompt([
      { id: "AC-1", evidence: "`npx vitest run a.test.ts`" },
      { id: "AC-2", evidence: "`curl http://localhost:3000`" },
    ]);
    expect(prompt).not.toContain(OPEN);
    expect(prompt).not.toContain("needs a person");
  });

  it("joins an existing context into the same single block", async () => {
    const prompt = await qaPrompt(
      [{ id: "AC-3", evidence: "`vercel env ls production`" }],
      "## Prior context",
    );
    expect(count(prompt, OPEN)).toBe(1);
    expect(prompt).toContain("## Prior context");
    expect(prompt).toContain("- AC-3: `vercel env ls production`");
  });

});
