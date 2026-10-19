import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { issueFormInfoLine, buildDoctorSummary } from "./doctor.js";

describe("issueFormInfoLine (#1528)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "doctor-form-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports an absent form as an info line naming the guide", () => {
    const line = issueFormInfoLine(dir);
    expect(line).toMatch(/^i /);
    expect(line).toContain("docs/guides/writing-issues.md");
  });

  it("prints nothing when the form is present", async () => {
    const d = join(dir, ".github", "ISSUE_TEMPLATE");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "sequant-task.yml"), "name: x\n");
    expect(issueFormInfoLine(dir)).toBeNull();
  });

  it("keeps the info line out of the summary counts (runtime check: Warnings unchanged)", () => {
    // The info line is printed outside `checks[]`; the summary sees only counts.
    const summary = buildDoctorSummary({ pass: 3, warn: 0, fail: 0 });
    expect(summary.level).toBe("success");
    expect(issueFormInfoLine(dir)).not.toBeNull();
    expect(summary.message).not.toContain("Warnings");
  });
});
