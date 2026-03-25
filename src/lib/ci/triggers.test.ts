import { describe, it, expect } from "vitest";
import { detectTrigger } from "./triggers.js";
import type { GitHubContext } from "./types.js";

describe("detectTrigger", () => {
  describe("workflow_dispatch", () => {
    it("returns default phases for workflow_dispatch", () => {
      const context: GitHubContext = {
        eventName: "workflow_dispatch",
        payload: {},
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("workflow_dispatch");
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.issue).toBeNull();
    });
  });

  describe("label triggers", () => {
    it("detects sequant:assess label as full workflow", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: {
          action: "labeled",
          issue: { number: 42 },
          label: { name: "sequant:assess" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("label");
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.issue).toBe(42);
      expect(result.label).toBe("sequant:assess");
    });

    it("detects sequant:solve label as full workflow (backward compat)", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: {
          action: "labeled",
          issue: { number: 42 },
          label: { name: "sequant:solve" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("label");
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.issue).toBe(42);
      expect(result.label).toBe("sequant:solve");
    });

    it("detects sequant:spec-only label", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: {
          action: "labeled",
          issue: { number: 10 },
          label: { name: "sequant:spec-only" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("label");
      expect(result.phases).toEqual(["spec"]);
      expect(result.issue).toBe(10);
    });

    it("detects sequant:exec label", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: {
          action: "labeled",
          issue: { number: 5 },
          label: { name: "sequant:exec" },
        },
      };
      const result = detectTrigger(context);
      expect(result.phases).toEqual(["exec"]);
    });

    it("detects sequant:qa label", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: {
          action: "labeled",
          issue: { number: 5 },
          label: { name: "sequant:qa" },
        },
      };
      const result = detectTrigger(context);
      expect(result.phases).toEqual(["qa"]);
    });

    it("returns unknown for non-sequant labels", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: {
          action: "labeled",
          issue: { number: 42 },
          label: { name: "bug" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
      expect(result.phases).toEqual([]);
    });

    it("returns unknown for non-labeled action", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: {
          action: "opened",
          issue: { number: 42 },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
    });

    it("handles missing label in payload", () => {
      const context: GitHubContext = {
        eventName: "issues",
        payload: { action: "labeled" },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
    });
  });

  describe("comment triggers", () => {
    it("detects @sequant run command", () => {
      const context: GitHubContext = {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 99 },
          comment: { body: "@sequant run spec,exec,qa" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("comment");
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.issue).toBe(99);
    });

    it("detects single phase in comment", () => {
      const context: GitHubContext = {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 7 },
          comment: { body: "@sequant run spec" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("comment");
      expect(result.phases).toEqual(["spec"]);
    });

    it("filters invalid phases from comment", () => {
      const context: GitHubContext = {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 7 },
          comment: { body: "@sequant run spec,invalid,qa" },
        },
      };
      const result = detectTrigger(context);
      expect(result.phases).toEqual(["spec", "qa"]);
    });

    it("returns unknown for all-invalid phases", () => {
      const context: GitHubContext = {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 7 },
          comment: { body: "@sequant run bogus,fake" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
    });

    it("ignores non-sequant comments", () => {
      const context: GitHubContext = {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 7 },
          comment: { body: "Looks good to me!" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
    });

    it("ignores edited comments (only created)", () => {
      const context: GitHubContext = {
        eventName: "issue_comment",
        payload: {
          action: "edited",
          issue: { number: 7 },
          comment: { body: "@sequant run spec" },
        },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
    });

    it("handles missing comment body", () => {
      const context: GitHubContext = {
        eventName: "issue_comment",
        payload: { action: "created", issue: { number: 7 } },
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
    });
  });

  describe("unknown events", () => {
    it("returns unknown for push events", () => {
      const context: GitHubContext = {
        eventName: "push",
        payload: {},
      };
      const result = detectTrigger(context);
      expect(result.trigger).toBe("unknown");
      expect(result.phases).toEqual([]);
      expect(result.issue).toBeNull();
    });
  });
});
