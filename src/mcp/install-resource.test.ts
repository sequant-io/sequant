// #988 AC-3: the MCP server surfaces skills-install status to clients —
// merged into sequant://config when the settings file is plain JSON, and on
// its own at sequant://install (always parseable, even when settings is JSONC).
// Both are report-only; the server never writes to the project.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillsInstallStatus } from "../commands/version-preflight.js";

const STALE: SkillsInstallStatus = {
  managed: true,
  outdated: true,
  currentVersion: "2.10.0",
  packageVersion: "2.13.0",
  contentDrift: 0,
  remediation: "sequant update",
  filesModified: false,
};

async function connect(context?: { install?: SkillsInstallStatus | null }) {
  const { createServer } = await import("./server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer("1.0.0-test", context);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => client.close() };
}

describe("#988 AC-3: install status resources", () => {
  let root: string;
  let prevCwd: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-mcp-install-"));
    fs.mkdirSync(path.join(root, ".sequant"), { recursive: true });
    prevCwd = process.cwd();
    process.chdir(root);
  });

  afterAll(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("merges skillsInstall into sequant://config when settings is plain JSON", async () => {
    fs.writeFileSync(
      path.join(root, ".sequant", "settings.json"),
      JSON.stringify({ version: "1.0", run: { timeout: 1800 } }),
    );
    const { client, close } = await connect({ install: STALE });
    try {
      const result = await client.readResource({ uri: "sequant://config" });
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.run.timeout).toBe(1800);
      expect(parsed.skillsInstall).toEqual(STALE);
      expect(parsed.skillsInstall.filesModified).toBe(false);
    } finally {
      await close();
    }
  });

  it("returns JSONC settings verbatim (never rewritten) and still serves sequant://install", async () => {
    const jsonc = '{\n  // comment\n  "version": "1.0",\n  "run": { "timeout": 1800 }\n}\n';
    fs.writeFileSync(path.join(root, ".sequant", "settings.json"), jsonc);
    const { client, close } = await connect({ install: STALE });
    try {
      const config = await client.readResource({ uri: "sequant://config" });
      expect(config.contents[0].text).toBe(jsonc);
      const install = await client.readResource({ uri: "sequant://install" });
      expect(JSON.parse(install.contents[0].text as string)).toEqual(STALE);
    } finally {
      await close();
    }
  });

  it("omits skillsInstall when the server was created without context; install resource is null", async () => {
    fs.writeFileSync(
      path.join(root, ".sequant", "settings.json"),
      JSON.stringify({ version: "1.0" }),
    );
    const { client, close } = await connect();
    try {
      const config = await client.readResource({ uri: "sequant://config" });
      expect("skillsInstall" in JSON.parse(config.contents[0].text as string)).toBe(false);
      const install = await client.readResource({ uri: "sequant://install" });
      expect(JSON.parse(install.contents[0].text as string)).toBeNull();
      const list = await client.listResources();
      expect(list.resources.map((r: { uri: string }) => r.uri)).toContain("sequant://install");
    } finally {
      await close();
    }
  });
});
