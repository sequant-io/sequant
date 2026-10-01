import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// A workflow triggered by issue_comment runs for anyone who can comment —
// on a public repo, that is everyone. Every Sequant job such a workflow
// starts has write permissions and the owner's API key, so its `if:` must
// restrict the comment author to people with write access.

const ROOT = join(__dirname, "..");
const EXAMPLES_DIR = join(ROOT, "sequant-action", "examples");
const DOC = join(ROOT, "docs", "features", "github-actions-integration.md");

type Workflow = {
  on?: Record<string, unknown>;
  jobs?: Record<string, { if?: string }>;
};

function ungatedJobs(workflow: Workflow): string[] {
  if (!workflow.on || !("issue_comment" in workflow.on)) return [];
  return Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => {
      const cond = job.if ?? "";
      return !(
        cond.includes("github.event.comment.author_association") &&
        cond.includes('"OWNER"') &&
        cond.includes('"COLLABORATOR"') &&
        !cond.includes('"CONTRIBUTOR"') &&
        !cond.includes('"NONE"')
      );
    })
    .map(([name]) => name);
}

/** The yaml fence inside the "### Option C: Comment trigger" section only. */
function optionCWorkflow(): Workflow {
  const doc = readFileSync(DOC, "utf8");
  const start = doc.indexOf("### Option C: Comment trigger");
  expect(start).toBeGreaterThan(-1);
  const end = doc.indexOf("\n### ", start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const fence = section.match(/```yaml\n([\s\S]*?)```/);
  expect(fence).not.toBeNull();
  return parse(fence![1]) as Workflow;
}

describe("comment-triggered workflows gate on the commenter's access", () => {
  it("every shipped example with an issue_comment trigger is gated", () => {
    const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".yml"));
    const commentTriggered = files.filter((f) => {
      const wf = parse(readFileSync(join(EXAMPLES_DIR, f), "utf8")) as Workflow;
      return wf.on !== undefined && "issue_comment" in wf.on;
    });
    expect(commentTriggered).toContain("comment-trigger.yml");
    for (const f of commentTriggered) {
      const wf = parse(readFileSync(join(EXAMPLES_DIR, f), "utf8")) as Workflow;
      expect(ungatedJobs(wf), f).toEqual([]);
    }
  });

  it("the documented Option C workflow is gated", () => {
    expect(ungatedJobs(optionCWorkflow())).toEqual([]);
  });
});
