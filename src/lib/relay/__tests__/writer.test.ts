import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInboxMessage } from "../writer.js";
import { inboxPathFor } from "../paths.js";

describe("ensureDir", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("the relay path's parent exists after a write", () => {
    root = mkdtempSync(join(tmpdir(), "relay-writer-1473-"));
    const options = { worktreePath: root };
    const path = inboxPathFor(1473, options);
    expect(existsSync(path)).toBe(false);

    appendInboxMessage(1473, { type: "query", message: "hi" }, options);

    expect(existsSync(path)).toBe(true);
  });
});
