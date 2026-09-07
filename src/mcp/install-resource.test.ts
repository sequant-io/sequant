// #988 AC-3: the MCP server surfaces skills-install status to clients at
// sequant://install — and ONLY there. sequant://config stays the user's
// settings file returned verbatim (JSON or JSONC), never re-serialized and
// never carrying server-computed fields. Both are report-only.

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

describe("#988 AC-3: sequant://install", () => {
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

  it("reports a stale install with remediation and filesModified: false", async () => {
    const { client, close } = await connect({ install: STALE });
    try {
      const result = await client.readResource({ uri: "sequant://install" });
      expect(JSON.parse(result.contents[0].text as string)).toEqual({
        installed: true,
        ...STALE,
      });
    } finally {
      await close();
    }
  });

  it("is always an object: { installed: false } when there is no manifest or no context", async () => {
    for (const context of [{ install: null }, undefined]) {
      const { client, close } = await connect(context);
      try {
        const result = await client.readResource({ uri: "sequant://install" });
        expect(JSON.parse(result.contents[0].text as string)).toEqual({
          installed: false,
        });
      } finally {
        await close();
      }
    }
  });

  it("is listed as a resource", async () => {
    const { client, close } = await connect({ install: STALE });
    try {
      const list = await client.listResources();
      expect(list.resources.map((r: { uri: string }) => r.uri)).toContain(
        "sequant://install",
      );
    } finally {
      await close();
    }
  });
});

describe("#988 AC-3: sequant://config stays the settings file, verbatim", () => {
  let root: string;
  let prevCwd: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-mcp-config-"));
    fs.mkdirSync(path.join(root, ".sequant"), { recursive: true });
    prevCwd = process.cwd();
    process.chdir(root);
  });

  afterAll(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns plain JSON byte-for-byte with no server-computed fields", async () => {
    const raw = '{"version":"1.0",  "run": {"timeout": 1800}}\n';
    fs.writeFileSync(path.join(root, ".sequant", "settings.json"), raw);
    const { client, close } = await connect({ install: STALE });
    try {
      const result = await client.readResource({ uri: "sequant://config" });
      expect(result.contents[0].text).toBe(raw);
      expect(result.contents[0].text).not.toContain("skillsInstall");
    } finally {
      await close();
    }
  });

  it("returns JSONC verbatim", async () => {
    const jsonc = '{\n  // comment\n  "version": "1.0"\n}\n';
    fs.writeFileSync(path.join(root, ".sequant", "settings.json"), jsonc);
    const { client, close } = await connect({ install: STALE });
    try {
      const result = await client.readResource({ uri: "sequant://config" });
      expect(result.contents[0].text).toBe(jsonc);
    } finally {
      await close();
    }
  });
});
