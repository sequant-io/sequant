import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeIssueFormIfAbsent, ISSUE_FORM_TEMPLATE } from "./init.js";
import { getTemplateContent } from "../lib/templates.js";

describe("writeIssueFormIfAbsent (#1528)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "issue-form-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the form byte-equal to the template when the directory is absent", async () => {
    const result = await writeIssueFormIfAbsent(dir);
    const written = await readFile(
      join(dir, ".github", "ISSUE_TEMPLATE", "sequant-task.yml"),
      "utf-8",
    );
    expect(written).toBe(await getTemplateContent(ISSUE_FORM_TEMPLATE));
    expect(result.written).toBe(true);
    expect(result.line).toBe(
      "Wrote .github/ISSUE_TEMPLATE/sequant-task.yml (issue form with an Acceptance Criteria field)",
    );
    expect(result.line).not.toContain("\n");
  });

  it("writes nothing and prints a one-line note when the directory exists", async () => {
    const tplDir = join(dir, ".github", "ISSUE_TEMPLATE");
    await mkdir(tplDir, { recursive: true });
    await writeFile(join(tplDir, "bug.md"), "mine");
    const result = await writeIssueFormIfAbsent(dir);
    expect(result.written).toBe(false);
    expect(existsSync(join(tplDir, "sequant-task.yml"))).toBe(false);
    expect(await readFile(join(tplDir, "bug.md"), "utf-8")).toBe("mine");
    expect(result.line).toBe(
      "Issue form skipped: .github/ISSUE_TEMPLATE/ already exists (left untouched)",
    );
  });

  it("does not overwrite when called twice (second call is the existing-directory case)", async () => {
    await writeIssueFormIfAbsent(dir);
    const formPath = join(dir, ".github", "ISSUE_TEMPLATE", "sequant-task.yml");
    await writeFile(formPath, "edited");
    const second = await writeIssueFormIfAbsent(dir);
    expect(second.written).toBe(false);
    expect(await readFile(formPath, "utf-8")).toBe("edited");
  });
});
