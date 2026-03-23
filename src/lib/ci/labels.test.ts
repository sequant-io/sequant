import { describe, it, expect } from "vitest";
import {
  getFailureLabels,
  getStartLabels,
  getStartRemoveLabels,
  getSuccessLabels,
  labelCommands,
} from "./labels.js";

describe("getStartLabels", () => {
  it("returns sequant:solving", () => {
    expect(getStartLabels()).toEqual(["sequant:solving"]);
  });
});

describe("getStartRemoveLabels", () => {
  it("removes trigger label and stale outcome labels", () => {
    const labels = getStartRemoveLabels("sequant:solve");
    expect(labels).toContain("sequant:solve");
    expect(labels).toContain("sequant:done");
    expect(labels).toContain("sequant:failed");
  });

  it("still removes outcome labels without trigger label", () => {
    const labels = getStartRemoveLabels();
    expect(labels).toContain("sequant:done");
    expect(labels).toContain("sequant:failed");
    expect(labels).not.toContain("sequant:solve");
  });

  it("ignores non-trigger labels", () => {
    const labels = getStartRemoveLabels("bug");
    expect(labels).not.toContain("bug");
  });
});

describe("getSuccessLabels", () => {
  it("adds done and removes solving", () => {
    const { add, remove } = getSuccessLabels();
    expect(add).toEqual(["sequant:done"]);
    expect(remove).toEqual(["sequant:solving"]);
  });
});

describe("getFailureLabels", () => {
  it("adds failed and removes solving", () => {
    const { add, remove } = getFailureLabels();
    expect(add).toEqual(["sequant:failed"]);
    expect(remove).toEqual(["sequant:solving"]);
  });
});

describe("labelCommands", () => {
  it("generates start commands with trigger label", () => {
    const cmds = labelCommands(42, "start", "sequant:solve");
    expect(cmds).toContainEqual(
      expect.stringContaining('--add-label "sequant:solving"'),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining('--remove-label "sequant:solve"'),
    );
  });

  it("generates success commands", () => {
    const cmds = labelCommands(42, "success");
    expect(cmds).toContainEqual(
      expect.stringContaining('--add-label "sequant:done"'),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining('--remove-label "sequant:solving"'),
    );
  });

  it("generates failure commands", () => {
    const cmds = labelCommands(42, "failure");
    expect(cmds).toContainEqual(
      expect.stringContaining('--add-label "sequant:failed"'),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining('--remove-label "sequant:solving"'),
    );
  });

  it("includes correct issue number in commands", () => {
    const cmds = labelCommands(123, "start");
    for (const cmd of cmds) {
      expect(cmd).toContain("123");
    }
  });

  it("includes || true for remove commands to handle missing labels", () => {
    const cmds = labelCommands(42, "start", "sequant:solve");
    const removeCmds = cmds.filter((c) => c.includes("--remove-label"));
    for (const cmd of removeCmds) {
      expect(cmd).toContain("|| true");
    }
  });
});
