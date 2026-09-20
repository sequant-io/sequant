/**
 * Unit tests for the pure parts of `scripts/hook-corpus.ts` (#1094).
 * Nothing here spawns bash or builds a repo — that is the integration suite's job.
 */
import { describe, expect, it } from "vitest";
import {
  extractHookLogCommands,
  extractTranscriptCommands,
  formatDiff,
  normalizeCandidate,
  parseCorpus,
  redactCommand,
  serializeCase,
  type CorpusCase,
  isCommandFragment,
  isRuleMismatch,
} from "./hook-corpus.ts";

const FAKE_GHP = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("hook-corpus redaction", () => {
  it("redacts a ghp_ token", () => {
    const out = redactCommand(
      `GH_TOKEN=${FAKE_GHP} gh api /user && echo ${FAKE_GHP}`,
    );
    expect(out).not.toContain(FAKE_GHP);
    expect(out).toContain("<redacted>");
  });

  it("redacts an Authorization header value", () => {
    const out = redactCommand(
      `curl -H "Authorization: Bearer abcdef123456SECRETVALUE" https://example.com`,
    );
    expect(out).not.toContain("SECRETVALUE");
    expect(out).toContain("Authorization: <redacted>");
  });

  it("redacts emails and the home directory of a public repo", () => {
    const out = redactCommand(
      "git log --author=someone@example.com /Users/alice/proj",
    );
    expect(out).not.toContain("someone@example.com");
    expect(out).not.toContain("alice");
  });

  it("normalizeCandidate redacts and drops over-long commands", () => {
    expect(normalizeCandidate(`echo ${FAKE_GHP}`)).not.toContain(FAKE_GHP);
    expect(normalizeCandidate("x".repeat(2001))).toBeNull();
    expect(normalizeCandidate("")).toBeNull();
  });
});

describe("hook-corpus serialization", () => {
  const c: CorpusCase = {
    command: 'echo "hi"',
    tool: "Bash",
    exit: 2,
    block: "Force push",
    source: "#1064",
    state: "staged",
  };

  it("writes the spaced form the AC greps rely on and round-trips", () => {
    const line = serializeCase(c);
    expect(line).toContain('"source": "#1064"');
    expect(parseCorpus(line)).toEqual([c]);
  });

  it("only writes state when it is not the default", () => {
    expect(serializeCase(c)).not.toContain('"state"');
    expect(serializeCase({ ...c, state: "clean" })).toContain(
      '"state": "clean"',
    );
  });
});

describe("hook-corpus source extraction", () => {
  it("pulls Bash tool_use commands from transcript lines and ignores other tools", () => {
    const bash = {
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    };
    const edit = {
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/x" } },
        ],
      },
    };
    const text = [
      JSON.stringify(bash),
      JSON.stringify(edit),
      "not json tool_use",
    ].join("\n");
    expect(extractTranscriptCommands(text)).toEqual(["ls -la"]);
  });

  it("pulls Bash commands from BLOCKED hook-log lines and skips non-Bash payloads", () => {
    const log = [
      "1789621494.63 BLOCKED [force-push] git push --force origin main",
      '1789621750.81 BLOCKED [worktree-boundary] {"file_path":"/tmp/x"}',
      "continuation line of a multi-line command",
    ].join("\n");
    expect(extractHookLogCommands(log)).toEqual([
      "git push --force origin main",
    ]);
  });
});

describe("hook-corpus diff formatting", () => {
  it("prints 0 verdict changes for an empty diff", () => {
    expect(formatDiff([])).toBe("0 verdict changes");
  });

  it("names the command and both verdicts for a change", () => {
    const out = formatDiff([
      {
        command: "git commit -F - <<'EOF'",
        state: "staged",
        source: "#1064",
        before: { exit: 0, block: null },
        after: {
          exit: 2,
          block: "Commit must follow conventional commits format",
        },
      },
    ]);
    expect(out).toContain("1 verdict change");
    expect(out).toContain("[#1064] allow -> block");
    expect(out).toContain("git commit -F -");
  });
});

describe("hook-log fragments (#1094)", () => {
  it("skips heredoc openers, trailing operators and unbalanced quotes from the hook log", () => {
    const log = [
      "1.0 BLOCKED [commit-format] git commit -q -F - <<'EOF'",
      "2.0 BLOCKED [env-dump] python3 - <<'EOF'",
      "3.0 BLOCKED [force-push] cd /tmp && \\",
      "4.0 BLOCKED [force-push] (npx tsx scripts/x.ts > /tmp/out 2>&1; echo \"EXIT=$",
      "5.0 BLOCKED [force-push] git push --force origin main",
      "6.0 BLOCKED [staged-secret] git commit -m 'x' && git push -f",
    ].join("\n");
    expect(extractHookLogCommands(log)).toEqual([
      "git push --force origin main",
      "git commit -m 'x' && git push -f",
    ]);
    expect(isCommandFragment("git push --force origin main")).toBe(false);
    expect(isCommandFragment("python3 - <<'EOF'")).toBe(true);
  });
});

describe("hook-log complete-line fragments (#1094)", () => {
  it("drops a first line whose text cannot have earned the log's rule", () => {
    // Verbatim shapes from ~/.sequant/logs/claude-hook.log: the first line of
    // a multi-line commit heredoc, and a bare cd ahead of a commit.
    expect(isRuleMismatch("commit-format", "set -e")).toBe(true);
    expect(isRuleMismatch("no-changes", "cd /Users/user/Projects/sequant-landing")).toBe(true);
    expect(isRuleMismatch("env-dump", "W=/Users/user/Projects/worktrees/feature/x")).toBe(true);
    expect(isRuleMismatch("commit-format", "git commit -m 'x'")).toBe(false);
    expect(isRuleMismatch("force-push", "set -e")).toBe(false);
    const log = "1.0 BLOCKED [commit-format] set -e\n2.0 BLOCKED [force-push] git push --force origin main";
    expect(extractHookLogCommands(log)).toEqual(["git push --force origin main"]);
  });
});

describe("redaction of session ids and foreign project paths (#1094)", () => {
  it("replaces Claude Code session URLs and non-sequant project names", () => {
    expect(redactCommand("open https://claude.ai/code/session_012sf9ybMc6ahtTPZbb6TLyX now")).toBe(
      "open <redacted-session> now",
    );
    expect(redactCommand("cd /Users/tony/Projects/ad-motion && ls")).toBe(
      "cd /Users/user/Projects/<project> && ls",
    );
    expect(redactCommand("cd /Users/tony/Projects/sequant && ls")).toContain("/Projects/sequant");
    expect(redactCommand("S=/private/tmp/claude-502/-Users-tony-Projects-ad-motion/abc/scratchpad")).toBe(
      "S=/private/tmp/claude-502/-Users-user-Projects-<project>/abc/scratchpad",
    );
    expect(redactCommand("gh issue view 225 --repo admarble/ad-motion --json comments")).toBe(
      "gh issue view 225 --repo <owner>/<repo> --json comments",
    );
    expect(redactCommand("gh pr view 1 --repo sequant-io/sequant")).toContain("sequant-io/sequant");
  });
});
