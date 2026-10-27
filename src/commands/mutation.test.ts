/**
 * `sequant mutation begin | check` (#1604) against a real git repository in a
 * temp dir. Vitest itself is replaced by a fake runner whose verdict reads the
 * tree on disk, so a test "fails" exactly when the mutation is in place and
 * the restore is observable to the second run.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  beginMutation,
  checkMutation,
  testNamePattern,
  type VitestRunner,
  type VitestTestState,
} from "./mutation.js";
import {
  mutationPatchPath,
  mutationStatePath,
  readMutationState,
} from "../lib/workflow/mutation-state.js";

const ISSUE = 1604;
const TEST_FILE = "src/gate.test.ts";
const GATE_NAME = "gate > guard is present";
const OTHER_NAME = "gate > guard is present twice";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function status(root: string): string {
  return git(root, "status", "--porcelain", "--untracked-files=all");
}

/** A repo that ignores `.sequant/`, as `sequant init` sets one up. */
function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sequant-mutation-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sequant/\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/gate.ts"), "export const GUARD = true;\n");
  writeFileSync(join(root, TEST_FILE), "// stands in for the gate test\n");
  writeFileSync(join(root, "src/fixture.bin"), Buffer.from([0, 1, 2, 255, 0]));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

/** A runner whose test state is `verdict(root)`, judged on each run. */
function fakeRunner(
  verdict: (root: string) => VitestTestState,
  names: string[] = [GATE_NAME],
) {
  const calls = { list: 0, run: 0 };
  const runner: VitestRunner = {
    list(_root, _file, pattern) {
      calls.list++;
      const re = new RegExp(pattern);
      return names.filter((n) => re.test(n));
    },
    run(root) {
      calls.run++;
      const testState = verdict(root);
      return { exit: testState === "passed" ? 0 : 1, testState, output: "" };
    },
  };
  return { runner, calls };
}

/** The gate test passes while `src/gate.ts` still declares the guard. */
const guardPresent = (root: string): VitestTestState => {
  const file = join(root, "src/gate.ts");
  return existsSync(file) && readFileSync(file, "utf8").includes("GUARD")
    ? "passed"
    : "failed";
};

function check(root: string, runner: VitestRunner, name = GATE_NAME) {
  return checkMutation({
    cwd: root,
    issue: ISSUE,
    ac: "AC-2",
    test: TEST_FILE,
    name,
    mutation: "deleted the GUARD export",
    runner,
  });
}

let root: string;

beforeEach(() => {
  root = makeRepo();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("mutation begin", () => {
  it("refuses a dirty tree with exit 2 and writes no receipt", () => {
    writeFileSync(join(root, "src/gate.ts"), "export const GUARD = false;\n");

    const outcome = beginMutation({ cwd: root, issue: ISSUE });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("commit first");
    expect(existsSync(mutationStatePath(root, ISSUE))).toBe(false);
  });

  it("records HEAD and the start time on a clean tree", () => {
    const outcome = beginMutation({
      cwd: root,
      issue: ISSUE,
      now: () => new Date("2026-10-26T12:00:00Z"),
    });

    expect(outcome.exitCode).toBe(0);
    expect(readMutationState(root, ISSUE)).toEqual({
      issue: ISSUE,
      sha: git(root, "rev-parse", "HEAD"),
      startedAt: "2026-10-26T12:00:00.000Z",
      records: [],
    });
  });

  it("does not count its own receipt as a change in a repo that does not ignore .sequant/", () => {
    git(root, "rm", "-q", ".gitignore");
    git(root, "commit", "-q", "-m", "no ignore");

    expect(beginMutation({ cwd: root, issue: ISSUE }).exitCode).toBe(0);
    expect(status(root)).toBe(`?? .sequant/mutations/${ISSUE}.json`);
    expect(beginMutation({ cwd: root, issue: ISSUE }).exitCode).toBe(0);
  });

  it("keeps earlier records when begin runs again after a commit", () => {
    beginMutation({ cwd: root, issue: ISSUE });
    writeFileSync(join(root, "src/gate.ts"), "export const X = 1;\n");
    expect(check(root, fakeRunner(guardPresent).runner).exitCode).toBe(0);
    writeFileSync(join(root, "README.md"), "new\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "more");

    expect(beginMutation({ cwd: root, issue: ISSUE }).exitCode).toBe(0);

    const state = readMutationState(root, ISSUE);
    expect(state?.sha).toBe(git(root, "rev-parse", "HEAD"));
    expect(state?.records).toHaveLength(1);
  });
});

describe("mutation check restores the tree", () => {
  beforeEach(() => {
    expect(beginMutation({ cwd: root, issue: ISSUE }).exitCode).toBe(0);
  });

  it("refuses with exit 2 and records nothing when the test passes under the mutation", () => {
    writeFileSync(
      join(root, "src/gate.ts"),
      "export const GUARD = true; // reworded\n",
    );
    const { runner, calls } = fakeRunner(guardPresent);

    const outcome = check(root, runner);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("passes under the mutation");
    expect(calls.run).toBe(1);
    expect(readMutationState(root, ISSUE)?.records).toEqual([]);
    expect(status(root)).toBe("");
    expect(readFileSync(join(root, "src/gate.ts"), "utf8")).toBe(
      "export const GUARD = true;\n",
    );
    // The patch stays for the human.
    expect(existsSync(mutationPatchPath(root, ISSUE))).toBe(true);
  });

  it("records one result when the test fails under the mutation and passes after the restore", () => {
    writeFileSync(join(root, "src/gate.ts"), "export const X = 1;\n");
    const { runner, calls } = fakeRunner(guardPresent);

    const outcome = check(root, runner);

    expect(outcome.exitCode).toBe(0);
    expect(calls.run).toBe(2);
    const records = readMutationState(root, ISSUE)?.records ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ac: "AC-2",
      test: TEST_FILE,
      name: GATE_NAME,
      mutation: "deleted the GUARD export",
      sha: git(root, "rev-parse", "HEAD"),
    });
    expect(records[0].mutatedExit).not.toBe(0);
    expect(records[0].restoredExit).toBe(0);
    expect(status(root)).toBe("");
    expect(existsSync(mutationPatchPath(root, ISSUE))).toBe(false);
  });

  it("refuses with exit 2 and names the broken test when it fails both ways", () => {
    writeFileSync(join(root, "src/gate.ts"), "export const X = 1;\n");
    const { runner, calls } = fakeRunner(() => "failed");

    const outcome = check(root, runner);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain(GATE_NAME);
    expect(outcome.message).toContain("fails without the mutation too");
    expect(calls.run).toBe(2);
    expect(readMutationState(root, ISSUE)?.records).toEqual([]);
    expect(status(root)).toBe("");
  });

  it("restores a deleted file byte-for-byte and removes an added one", () => {
    const binBefore = readFileSync(join(root, "src/fixture.bin"));
    const gateBefore = readFileSync(join(root, "src/gate.ts"));
    unlinkSync(join(root, "src/gate.ts"));
    unlinkSync(join(root, "src/fixture.bin"));
    writeFileSync(join(root, "src/added.ts"), "export const NEW = 1;\n");
    const { runner } = fakeRunner(guardPresent);

    const outcome = check(root, runner);

    expect(outcome.exitCode).toBe(0);
    expect(status(root)).toBe("");
    expect(readFileSync(join(root, "src/gate.ts")).equals(gateBefore)).toBe(
      true,
    );
    expect(readFileSync(join(root, "src/fixture.bin")).equals(binBefore)).toBe(
      true,
    );
    expect(existsSync(join(root, "src/added.ts"))).toBe(false);
  });

  it("refuses a test that did not run under the mutation, and still restores", () => {
    writeFileSync(join(root, "src/gate.ts"), "export const X = 1;\n");
    const { runner } = fakeRunner((r) =>
      guardPresent(r) === "passed" ? "passed" : "missing",
    );

    const outcome = check(root, runner);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("did not run under the mutation");
    expect(status(root)).toBe("");
  });

  it("refuses an empty mutation", () => {
    const { runner, calls } = fakeRunner(guardPresent);

    const outcome = check(root, runner);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("no change");
    expect(calls.run).toBe(0);
  });
});

describe("mutation check after a commit mid-mutation", () => {
  it("refuses with exit 2, leaves the receipt and the tree untouched, and runs nothing", () => {
    expect(beginMutation({ cwd: root, issue: ISSUE }).exitCode).toBe(0);
    writeFileSync(join(root, "src/gate.ts"), "export const X = 1;\n");
    git(root, "commit", "-q", "-am", "oops, committed the mutation");
    writeFileSync(join(root, "src/extra.ts"), "uncommitted\n");
    const receiptBefore = readFileSync(mutationStatePath(root, ISSUE));
    const { runner, calls } = fakeRunner(guardPresent);

    const outcome = check(root, runner);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("HEAD moved since `begin`");
    expect(calls).toEqual({ list: 0, run: 0 });
    expect(
      readFileSync(mutationStatePath(root, ISSUE)).equals(receiptBefore),
    ).toBe(true);
    expect(status(root)).toBe("?? src/extra.ts");
  });
});

describe("mutation check with an ambiguous name", () => {
  beforeEach(() => {
    expect(beginMutation({ cwd: root, issue: ISSUE }).exitCode).toBe(0);
    writeFileSync(join(root, "src/gate.ts"), "export const X = 1;\n");
  });

  it("refuses with exit 2 naming both when two tests match, before any run", () => {
    const { runner, calls } = fakeRunner(guardPresent, [
      "gate > guard is present",
      "other > gate > guard is present",
    ]);

    const outcome = check(root, runner, "gate > guard is present");

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("matches 2 tests");
    expect(outcome.message).toContain("  gate > guard is present");
    expect(outcome.message).toContain("  other > gate > guard is present");
    expect(calls.run).toBe(0);
    // Nothing staged or restored: the agent's mutation is still in place.
    expect(status(root)).toBe("M src/gate.ts");
  });

  it("refuses with exit 2 when no test matches, before any run", () => {
    const { runner, calls } = fakeRunner(guardPresent, [OTHER_NAME]);

    const outcome = check(root, runner, "gate > no such test");

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("No test");
    expect(calls.run).toBe(0);
  });

  it("anchors the name at its end, so a name that prefixes another resolves to one", () => {
    const { runner } = fakeRunner(guardPresent, [GATE_NAME, OTHER_NAME]);

    expect(check(root, runner, GATE_NAME).exitCode).toBe(0);
  });
});

describe("testNamePattern", () => {
  it("escapes regex metacharacters so a literal name matches itself", () => {
    const name = "state (#848) > [x] a.b * c? > {1}";
    const re = new RegExp(testNamePattern(name));

    expect(re.test(name)).toBe(true);
    expect(re.test("state (#848) > [x] aXb * c? > {1}")).toBe(false);
  });
});
