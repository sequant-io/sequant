// Tests for relay state schema (#383):
// AC-24 (optional relay field on IssueState; legacy state still validates),
// AC-D4 (archive meta.json schema).

import { describe, it, expect } from "vitest";
import {
  IssueStateSchema,
  RelayStateSchema,
} from "../src/lib/workflow/state-schema.js";
import { RelayArchiveMetaSchema } from "../src/lib/relay/types.js";

function legacyIssueState(): Record<string, unknown> {
  return {
    number: 383,
    title: "Some legacy issue",
    status: "in_progress",
    currentPhase: "exec",
    iteration: 0,
    phases: {},
    lastActivity: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

describe("Relay State Schema", () => {
  describe("AC-24: IssueState.relay is optional", () => {
    it("parses an IssueState without a relay field", () => {
      const parsed = IssueStateSchema.parse(legacyIssueState());
      expect(parsed.relay).toBeUndefined();
    });

    it("parses an IssueState with a complete relay field", () => {
      const withRelay = {
        ...legacyIssueState(),
        relay: {
          enabled: true,
          pid: 1234,
          startedAt: "2026-05-13T12:00:00Z",
          messageCount: 0,
        },
      };
      const parsed = IssueStateSchema.parse(withRelay);
      expect(parsed.relay?.enabled).toBe(true);
      expect(parsed.relay?.pid).toBe(1234);
      expect(parsed.relay?.messageCount).toBe(0);
    });

    it("rejects relay.pid that is not a positive integer", () => {
      expect(() =>
        RelayStateSchema.parse({
          enabled: true,
          pid: 0,
          startedAt: "2026-05-13T12:00:00Z",
          messageCount: 0,
        }),
      ).toThrow();
      expect(() =>
        RelayStateSchema.parse({
          enabled: true,
          pid: -5,
          startedAt: "2026-05-13T12:00:00Z",
          messageCount: 0,
        }),
      ).toThrow();
    });

    it("rejects relay.startedAt that is not ISO 8601", () => {
      expect(() =>
        RelayStateSchema.parse({
          enabled: true,
          pid: 1234,
          startedAt: "yesterday",
          messageCount: 0,
        }),
      ).toThrow();
    });

    it("rejects negative relay.messageCount", () => {
      expect(() =>
        RelayStateSchema.parse({
          enabled: true,
          pid: 1234,
          startedAt: "2026-05-13T12:00:00Z",
          messageCount: -1,
        }),
      ).toThrow();
    });
  });

  describe("AC-D4: Archive meta.json schema", () => {
    it("parses a well-formed meta object", () => {
      const meta = {
        issue: 383,
        phase: "exec",
        startedAt: "2026-05-13T10:00:00Z",
        endedAt: "2026-05-13T10:30:00Z",
        messageCount: 3,
      };
      const parsed = RelayArchiveMetaSchema.parse(meta);
      expect(parsed.issue).toBe(383);
      expect(parsed.phase).toBe("exec");
      expect(parsed.messageCount).toBe(3);
    });

    it("rejects meta with non-positive issue", () => {
      expect(() =>
        RelayArchiveMetaSchema.parse({
          issue: 0,
          phase: "exec",
          startedAt: "2026-05-13T10:00:00Z",
          endedAt: "2026-05-13T10:30:00Z",
          messageCount: 0,
        }),
      ).toThrow();
    });

    it("rejects meta with non-ISO timestamps", () => {
      expect(() =>
        RelayArchiveMetaSchema.parse({
          issue: 383,
          phase: "exec",
          startedAt: "today",
          endedAt: "later",
          messageCount: 0,
        }),
      ).toThrow();
    });
  });
});
