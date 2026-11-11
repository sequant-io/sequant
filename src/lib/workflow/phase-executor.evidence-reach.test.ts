/**
 * #1652 AC-2 (E-2): the qa prompt carries the needs-human ACs in the one
 * sentinel block `getPhasePrompt` appends, and an issue with none gets no
 * reach block.
 */

import { describe, it, expect } from "vitest";
import {
  getPhasePrompt,
  PROMPT_CONTEXT_SENTINEL,
} from "./phase-executor.js";
import { withEvidenceReachContext } from "./batch-executor.js";
import { needsHumanAcs } from "../evidence-reach.js";
import type { ExecutionConfig } from "./types.js";

const COMMAND = "npx tsx --env-file=.env.local scripts/dev/query.ts --limit 5";
const OPEN = `<!-- ${PROMPT_CONTEXT_SENTINEL} -->`;

const base = { phases: ["qa"] } as unknown as ExecutionConfig;

async function qaPrompt(
  items: Array<{ id: string; evidence?: string }>,
  config: ExecutionConfig = base,
): Promise<string> {
  const dispatched = withEvidenceReachContext(
    config,
    "qa",
    needsHumanAcs(items),
  );
  return getPhasePrompt("qa", 1652, undefined, dispatched.promptContext);
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
      { ...base, promptContext: "## Prior context" },
    );
    expect(count(prompt, OPEN)).toBe(1);
    expect(prompt).toContain("## Prior context");
    expect(prompt).toContain("- AC-3: `vercel env ls production`");
  });

  it("adds no block to a non-qa phase", () => {
    const items = needsHumanAcs([
      { id: "AC-3", evidence: "`vercel env ls production`" },
    ]);
    expect(withEvidenceReachContext(base, "exec", items)).toBe(base);
  });
});
