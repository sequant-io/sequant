/**
 * #1652 AC-1: the Evidence reach classifier (E-1, P-9's rules).
 */

import { describe, it, expect } from "vitest";
import {
  buildEvidenceReachContext,
  classifyEvidenceReach,
  evidenceCommands,
  needsHumanAcs,
} from "./evidence-reach.js";

describe("classifyEvidenceReach — needs-human (#1652 AC-1)", () => {
  it("marks --env-file as env-file", () => {
    const r = classifyEvidenceReach(
      "`npx tsx --env-file=.env.local scripts/dev/query.ts` → rows",
    );
    expect(r).toEqual({ reach: "needs-human", reasons: ["env-file"] });
  });

  it("marks a .env path as env-file", () => {
    expect(classifyEvidenceReach("`cat .env.production`").reasons).toEqual([
      "env-file",
    ]);
    expect(
      classifyEvidenceReach("`source ../app/.env && node x.js`").reasons,
    ).toEqual(["env-file"]);
  });

  it.each([
    "vercel",
    "supabase",
    "netlify",
    "fly",
    "heroku",
    "wrangler",
    "railway",
    "aws",
    "gcloud",
    "az",
  ])("marks the production CLI %s, bare and through npx", (cli) => {
    expect(classifyEvidenceReach(`\`${cli} status\``)).toEqual({
      reach: "needs-human",
      reasons: ["production-cli"],
    });
    expect(classifyEvidenceReach(`\`npx -y ${cli} status\``).reach).toBe(
      "needs-human",
    );
  });

  it("marks a production CLI after a pipe or an env assignment", () => {
    expect(
      classifyEvidenceReach("`echo y | FOO=1 vercel env ls production`")
        .reasons,
    ).toEqual(["production-cli"]);
  });

  it("marks a non-local URL as live-url", () => {
    expect(
      classifyEvidenceReach("`curl -s https://api.example.com/health`"),
    ).toEqual({ reach: "needs-human", reasons: ["live-url"] });
  });

  it("reports every reason once, in a stable order", () => {
    expect(
      classifyEvidenceReach(
        "`curl https://a.example.com` and `vercel ls` and `curl https://b.example.com --env-file .env`",
      ).reasons,
    ).toEqual(["env-file", "production-cli", "live-url"]);
  });
});

describe("classifyEvidenceReach — worktree (#1652 AC-1)", () => {
  it("leaves npx vitest run as worktree", () => {
    expect(
      classifyEvidenceReach(
        "`npx vitest run src/lib/evidence-reach.test.ts` → `≥ 8 passed, 0 failed`",
      ),
    ).toEqual({ reach: "worktree", reasons: [] });
  });

  it("leaves a localhost URL as worktree", () => {
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1:8080/x",
      "http://0.0.0.0",
      "http://[::1]:3000",
    ]) {
      expect(classifyEvidenceReach(`\`curl ${url}\``).reach).toBe("worktree");
    }
  });

  it("leaves a grep whose pattern contains https:// as worktree", () => {
    expect(
      classifyEvidenceReach("`grep -c 'https://x' f` → `1`").reach,
    ).toBe("worktree");
    expect(
      classifyEvidenceReach(
        "`git grep -nE 'http://a|https://b.example.com' src`",
      ).reach,
    ).toBe("worktree");
  });

  it("leaves prose and process.env as worktree", () => {
    expect(classifyEvidenceReach("human review of vercel output").reach).toBe(
      "worktree",
    );
    expect(
      classifyEvidenceReach("`grep -c process.env.FOO src/a.ts`").reach,
    ).toBe("worktree");
  });
});

describe("needsHumanAcs / buildEvidenceReachContext (#1652)", () => {
  const items = [
    { id: "AC-1", evidence: "`npx vitest run a.test.ts`" },
    {
      id: "AC-2",
      evidence:
        "`npx vitest run b.test.ts` then `npx tsx --env-file=.env.local q.ts`",
    },
    { id: "AC-3" },
  ];

  it("keeps only the needs-human commands, verbatim", () => {
    expect(evidenceCommands(items[1].evidence!)).toHaveLength(2);
    expect(needsHumanAcs(items)).toEqual([
      {
        id: "AC-2",
        reasons: ["env-file"],
        commands: ["npx tsx --env-file=.env.local q.ts"],
      },
    ]);
  });

  it("builds a do-not-run block naming each AC and command, or none", () => {
    const block = buildEvidenceReachContext(needsHumanAcs(items));
    expect(block).toContain("Do not run them");
    expect(block).toContain("`PENDING`");
    expect(block).toContain("- AC-2: `npx tsx --env-file=.env.local q.ts`");
    expect(block).not.toContain("AC-1");
    expect(buildEvidenceReachContext(needsHumanAcs([items[0]]))).toBe(
      undefined,
    );
  });
});
