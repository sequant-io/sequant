/**
 * Downstream canary (#1098): a fixture project on the PREVIOUS minor release,
 * customized the way real projects are, driven by this PR's build.
 *
 * Five of sixteen recent bugs (#1053, #1078, #1084, #1076, #1079) were found
 * only by field use because CI had nothing shaped like a downstream project.
 * Real `npm install`, real `npm pack`, real MCP `initialize` over stdio — no
 * mocks. Runs in the `canary` vitest project (needs the npm registry), which
 * is deliberately outside the required `test` job.
 *
 * State is shared and ordered: "dry-run equals apply" must run before anything
 * has synced the fixture, and every later test tolerates an already-synced one.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CUSTOM,
  PR_CLI,
  REPO_ROOT,
  cleanEnv,
  createDownstreamFixture,
  customizedFiles,
  snapshot,
  type Fixture,
} from "./fixture/create-fixture";

const PR_VERSION = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;

// Files a sync rewrites that carry no ownership decision: version stamps.
const BOOKKEEPING = new Set([
  ".sequant-manifest.json",
  path.join(".claude", "skills", ".sequant-version"),
]);

const SETTINGS = ".sequant/settings.json";

let fx: Fixture;
const cleanup: Array<() => void> = [];

function cli(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [PR_CLI, ...args], {
    cwd: fx.dir,
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

beforeAll(() => {
  fx = createDownstreamFixture();
  cleanup.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
}, 300_000);

afterAll(() => {
  for (const fn of cleanup.reverse()) fn();
});

/** `overwrite|merged|preserved: <path>` lines of a sync decision list. */
function decisions(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    const hit = /^\s+(overwrite|preserved|merged): (\S+)/.exec(line);
    if (hit) m.set(hit[2], hit[1]);
  }
  return m;
}

function changedBetween(
  before: Map<string, string>,
  after: Map<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(k) !== after.get(k)) changed.add(k);
  }
  return changed;
}

/**
 * Local npm registry: serves this tree's packed tarball as
 * `sequant@<PR_VERSION>` and proxies every other request to npmjs.
 */
async function startRegistry(): Promise<{ url: string; close: () => void }> {
  const packDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "sequant-canary-pack-"),
  );
  const pack = spawnSync(
    "npm",
    ["pack", "--pack-destination", packDir, "--silent", "--ignore-scripts"],
    { cwd: REPO_ROOT, env: cleanEnv(), encoding: "utf8", timeout: 120_000 },
  );
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const tarball = fs.readFileSync(
    path.join(packDir, pack.stdout.trim().split("\n").pop()!),
  );
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const shasum = createHash("sha1").update(tarball).digest("hex");
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const tarPath = `/sequant/-/sequant-${PR_VERSION}.tgz`;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (url === "/sequant") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: "sequant",
          "dist-tags": { latest: PR_VERSION },
          versions: {
            [PR_VERSION]: {
              ...pkgJson,
              dist: { tarball: `${base}${tarPath}`, integrity, shasum },
            },
          },
        }),
      );
      return;
    }
    if (url === tarPath) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(tarball);
      return;
    }
    try {
      const upstream = await fetch(`https://registry.npmjs.org${url}`, {
        headers: { accept: String(req.headers.accept ?? "*/*") },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.statusCode = upstream.status;
      const type = upstream.headers.get("content-type");
      if (type) res.setHeader("content-type", type);
      res.end(body);
    } catch (err) {
      res.statusCode = 502;
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => {
      server.close();
      fs.rmSync(packDir, { recursive: true, force: true });
    },
  };
}

describe("downstream canary", () => {
  it("dry-run equals apply", () => {
    const before = snapshot(fx.dir);
    const dry = cli(["sync", "--dry-run"]);
    // Non-zero when work is pending is the documented dry-run contract.
    expect(dry.status, dry.out).toBe(1);
    expect(
      changedBetween(before, snapshot(fx.dir)).size,
      "--dry-run wrote files",
    ).toBe(0);

    const listed = decisions(dry.out);
    const predicted = new Set(
      [...listed].filter(([, verb]) => verb !== "preserved").map(([p]) => p),
    );
    expect(predicted.size, dry.out).toBeGreaterThan(0);

    const applied = cli(["sync"]);
    expect(applied.status, applied.out).toBe(0);
    const changed = changedBetween(before, snapshot(fx.dir));
    for (const b of BOOKKEEPING) changed.delete(b);

    expect([...changed].sort()).toEqual([...predicted].sort());
    // Preserved means untouched.
    for (const [p, verb] of listed) {
      if (verb === "preserved") expect(changed.has(p), p).toBe(false);
    }
  });

  it("customizations survive sync, init --agent codex --yes and update", () => {
    const before = customizedFiles(fx.dir);
    expect(before["AGENTS.md"]).toBe(CUSTOM.agentsMd);

    const steps: string[][] = [
      ["sync"],
      ["init", "--agent", "codex", "--yes", "--skip-setup"],
      ["update"],
    ];
    for (const step of steps) {
      const r = cli(step);
      expect(r.status, `${step.join(" ")}:\n${r.out}`).toBe(0);
      // Byte-for-byte, after EVERY step, so a clobber names the writer. The
      // one sanctioned change: `init --agent codex` records `run.agent` in
      // .sequant/settings.json (#1059/#1071). Everything else in that file —
      // the tuned timeout, phases, JSONC comments — must be untouched.
      const after = customizedFiles(fx.dir);
      after[SETTINGS] = after[SETTINGS].replace(/\n\s*"agent": "codex",/, "");
      expect(after, step.join(" ")).toEqual(before);
    }
    expect(
      fs.readFileSync(path.join(fx.dir, SETTINGS), "utf8"),
      "init --agent codex must still record run.agent",
    ).toMatch(/"agent": "codex"/);
    const pkg = JSON.parse(before["package.json"]);
    expect(pkg.devDependencies.sequant).toBe(CUSTOM.staleDevDependency);
  });

  it("no placeholder lands under .claude and doctor exits 0", () => {
    const stray: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        // Shell hooks legitimately contain `{{MESSAGES}}`-style template
        // text; only rendered content (markdown/JSON) must be substituted.
        else if (/\.(md|json)$/.test(e.name)) {
          if (/\{\{[A-Z][A-Z0-9_]*\}\}/.test(fs.readFileSync(full, "utf8")))
            stray.push(path.relative(fx.dir, full));
        }
      }
    };
    walk(path.join(fx.dir, ".claude"));
    expect(stray).toEqual([]);

    const doctor = cli(["doctor", "--skip-issue-check"]);
    expect(doctor.status, doctor.out).toBe(0);
  });

  it("mcp handshake reports the PR's version despite a stale local install", async () => {
    // The stale local install is really there: the previous minor.
    const local = JSON.parse(
      fs.readFileSync(
        path.join(fx.dir, "node_modules", "sequant", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(local.version).toBe(fx.previousVersion);
    expect(local.version).not.toBe(PR_VERSION);

    // The shipped .mcp.json pins a published release, unpublished for a PR.
    // Serve this tree's `npm pack` tarball as `sequant@<PR version>` from a
    // local registry that proxies every other package to npmjs, then run the
    // plugin's own command and inline launcher unmodified — real npx, real
    // install, real stdio. (npx treats a tarball PATH as a command, so a
    // path spec cannot stand in for the published one.)
    const registry = await startRegistry();
    cleanup.push(() => registry.close());

    const mcp = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, ".mcp.json"), "utf8"),
    ) as { mcpServers: { sequant: { command: string; args: string[] } } };
    const { command, args } = mcp.mcpServers.sequant;
    const launchArgs = [...args.slice(0, -1), `sequant@${PR_VERSION}`];
    const npmCache = fs.mkdtempSync(
      path.join(os.tmpdir(), "sequant-canary-npm-"),
    );
    cleanup.push(() => fs.rmSync(npmCache, { recursive: true, force: true }));

    let child: ChildProcess | undefined;
    try {
      child = spawn(command, launchArgs, {
        cwd: fx.dir,
        env: cleanEnv({
          npm_config_registry: registry.url,
          npm_config_cache: npmCache,
        }),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      let stderr = "";
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
      const reply = await new Promise<{
        result?: { serverInfo?: { version?: string } };
      }>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`no initialize reply in 150s; stderr:\n${stderr}`),
            ),
          150_000,
        );
        let buf = "";
        child!.stdout!.on("data", (c: Buffer) => {
          buf += c.toString();
          for (const line of buf.split("\n")) {
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1) {
                clearTimeout(timer);
                resolve(msg);
              }
            } catch {
              // partial or non-JSON line
            }
          }
        });
        child!.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited ${code} early; stderr:\n${stderr}`));
        });
        child!.stdin!.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "canary", version: "0" },
            },
          }) + "\n",
        );
      });
      expect(reply.result?.serverInfo?.version).toBe(PR_VERSION);
    } finally {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 240_000);
});
