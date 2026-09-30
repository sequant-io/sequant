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

async function connect(context?: {
  install?: () => Promise<SkillsInstallStatus | null>;
}) {
  const { createServer } = await import("./server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer("1.0.0-test", context);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
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
    const { client, close } = await connect({ install: async () => STALE });
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
    for (const context of [{ install: async () => null }, undefined]) {
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
    const { client, close } = await connect({ install: async () => STALE });
    try {
      const list = await client.listResources();
      expect(list.resources.map((r: { uri: string }) => r.uri)).toContain(
        "sequant://install",
      );
    } finally {
      await close();
    }
  });

  it("AC-1: a manifest created after server start is reported installed on the next read, without a restart", async () => {
    let manifestWritten = false;
    const { client, close } = await connect({
      install: async () => (manifestWritten ? STALE : null),
    });
    try {
      const before = await client.readResource({ uri: "sequant://install" });
      expect(JSON.parse(before.contents[0].text as string)).toEqual({
        installed: false,
      });

      manifestWritten = true;

      const after = await client.readResource({ uri: "sequant://install" });
      expect(JSON.parse(after.contents[0].text as string)).toEqual({
        installed: true,
        ...STALE,
      });
    } finally {
      await close();
    }
  });

  it("AC-2: a read error is reported as { error }, distinct from { installed: false }", async () => {
    const { client, close } = await connect({
      install: async () => {
        throw new Error("manifest read failed");
      },
    });
    try {
      const result = await client.readResource({ uri: "sequant://install" });
      expect(JSON.parse(result.contents[0].text as string)).toEqual({
        error: "manifest read failed",
      });
    } finally {
      await close();
    }
  });

  // The real provider `serve` wires in, not a synthetic thrower: the lenient
  // getManifest() used to swallow these into `null`, so the resource read
  // "not installed" for a manifest that exists but is broken.
  describe("through the real provider (AC-1, AC-2)", () => {
    const manifestPath = () => path.join(root, ".sequant-manifest.json");

    afterAll(() => {
      fs.rmSync(manifestPath(), { force: true });
    });

    async function readReal() {
      const { getSkillsInstallStatus } =
        await import("../commands/version-preflight.js");
      const { client, close } = await connect({
        install: () => getSkillsInstallStatus(),
      });
      try {
        const result = await client.readResource({ uri: "sequant://install" });
        return JSON.parse(result.contents[0].text as string);
      } finally {
        await close();
      }
    }

    it("reports a corrupt manifest as { error }, not { installed: false }", async () => {
      fs.writeFileSync(manifestPath(), '{"version": "2.0.0", "stack":');
      const body = await readReal();
      expect(body).not.toHaveProperty("installed");
      expect(body.error).toEqual(expect.any(String));
    });

    it.skipIf(process.getuid?.() === 0)(
      "reports an unreadable manifest as { error }, not { installed: false }",
      async () => {
        fs.writeFileSync(manifestPath(), "{}");
        fs.chmodSync(manifestPath(), 0);
        try {
          const body = await readReal();
          expect(body).not.toHaveProperty("installed");
          expect(body.error).toEqual(expect.any(String));
        } finally {
          fs.chmodSync(manifestPath(), 0o644);
        }
      },
    );

    it("still reports an absent manifest as { installed: false }", async () => {
      fs.rmSync(manifestPath(), { force: true });
      expect(await readReal()).toEqual({ installed: false });
    });

    // Goes through serve's own wiring, so reverting it to a startup snapshot
    // fails here, not just a hand-built provider.
    it("AC-1: one server sees a manifest written after it started", async () => {
      fs.rmSync(manifestPath(), { force: true });
      const { serveResourceContext } = await import("../commands/serve.js");
      const { client, close } = await connect(serveResourceContext());
      try {
        const read = async () =>
          JSON.parse(
            (await client.readResource({ uri: "sequant://install" }))
              .contents[0].text as string,
          );
        expect(await read()).toEqual({ installed: false });
        fs.writeFileSync(
          manifestPath(),
          JSON.stringify({
            version: "1.0.0",
            stack: "generic",
            installedAt: new Date().toISOString(),
            files: {},
          }),
        );
        expect(await read()).toMatchObject({
          installed: true,
          filesModified: false,
        });
      } finally {
        await close();
      }
    });
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
    const { client, close } = await connect({ install: async () => STALE });
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
    const { client, close } = await connect({ install: async () => STALE });
    try {
      const result = await client.readResource({ uri: "sequant://config" });
      expect(result.contents[0].text).toBe(jsonc);
    } finally {
      await close();
    }
  });
});
