import { describe, it, expect } from "vitest";
import { appendAgentText, joinAgentTexts } from "./agent-text.js";
import { CodexStreamParser } from "./codex.js";
import { OpencodeStreamParser } from "./opencode.js";
import { extractExecSummary } from "../worktree-manager.js";

// The #1309 exec (run b197fad8, PR #1317) ended with exactly these two text
// messages. Joined with "" they read "Now the edits.## Summary", and the PR
// got the placeholder body.
const BEFORE = "Now the edits.";
const SUMMARY =
  "## Summary\n\nI corrected the second-look figure in four docs.";

describe("#1311: agent text messages are joined on line boundaries", () => {
  it("inserts a newline when the previous message ends mid-line", () => {
    expect(joinAgentTexts([BEFORE, SUMMARY])).toBe(`${BEFORE}\n${SUMMARY}`);
  });

  it("adds nothing when the previous message already ends with a newline", () => {
    expect(joinAgentTexts(["line one\n", "line two"])).toBe(
      "line one\nline two",
    );
  });

  it("adds nothing around empty text", () => {
    expect(appendAgentText("", "first")).toBe("first");
    expect(appendAgentText("first", "")).toBe("first");
  });

  it("the motivating #1309 output yields its Summary to the real extractor", () => {
    // Guard on the bug itself: the old "" join loses the summary.
    expect(extractExecSummary([BEFORE, SUMMARY].join(""))).toBeUndefined();
    expect(extractExecSummary(joinAgentTexts([BEFORE, SUMMARY]))).toContain(
      "I corrected the second-look figure",
    );
  });

  it("codex: agent_message items keep a final ## Summary extractable", () => {
    const line = (id: string, text: string) =>
      JSON.stringify({
        type: "item.completed",
        item: { id, type: "agent_message", text },
      });
    const parser = new CodexStreamParser();
    parser.feed(`${line("a", BEFORE)}\n${line("b", SUMMARY)}\n`);
    const { output } = parser.end();

    expect(output).toBe(`${BEFORE}\n${SUMMARY}`);
    expect(extractExecSummary(output)).toContain(
      "I corrected the second-look figure",
    );
  });

  it("opencode: text parts keep a final ## Summary extractable", () => {
    const line = (text: string) =>
      JSON.stringify({ type: "text", sessionID: "s1", part: { text } });
    const parser = new OpencodeStreamParser("exec");
    parser.feed(`${line(BEFORE)}\n${line(SUMMARY)}\n`);
    const { output } = parser.end();

    expect(output).toBe(`${BEFORE}\n${SUMMARY}`);
    expect(extractExecSummary(output)).toContain(
      "I corrected the second-look figure",
    );
  });
});
