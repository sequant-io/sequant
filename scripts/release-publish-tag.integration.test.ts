/**
 * Gate test for #1184: a bare `npm publish` of this package lands on the
 * `next` dist-tag, never `latest`.
 *
 * `/release` Step 9 hands the human `npm publish --tag next --otp=<code>`, and
 * twice (v2.17.0, v2.18.0) a bare `npm publish` was typed instead, moving
 * `latest` before the soak. `publishConfig.tag` makes `next` the default.
 *
 * Why not just read package.json: npm's own `--dry-run` notice prints
 * `config.get('tag')`, which never sees `publishConfig`, while the real
 * publish uses the flattened `defaultTag` that does. So the only honest check
 * is what npm actually sends. This runs the real `npm publish` against a
 * throwaway local HTTP registry and asserts the `dist-tags` in the PUT body.
 * Nothing leaves 127.0.0.1: the registry, auth token and userconfig are all
 * temporary, and every inherited `npm_config_*` variable is stripped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let server: Server;
let port = 0;
let lastPut: { "dist-tags"?: Record<string, string> } | null = null;
let tmp = "";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "sequant-publish-tag-"));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") {
        lastPut = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  writeFileSync(
    join(tmp, "npmrc"),
    `//127.0.0.1:${port}/:_authToken=test-token\n`,
  );
});

afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Run the real `npm publish` against the local registry; return the dist-tags
 * sent. Async on purpose: `spawnSync` would block the event loop the local
 * registry answers on, and npm would wait forever for its PUT response.
 */
async function publishTags(
  extra: string[] = [],
): Promise<Record<string, string>> {
  lastPut = null;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.toLowerCase().startsWith("npm_config_"),
    ),
  );
  const child = spawn(
    "npm",
    [
      "publish",
      "--ignore-scripts",
      "--registry",
      `http://127.0.0.1:${port}/`,
      "--userconfig",
      join(tmp, "npmrc"),
      ...extra,
    ],
    { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const status = await new Promise<number | null>((r) => child.on("close", r));
  expect(status, `npm publish failed:\n${stderr}`).toBe(0);
  expect(lastPut, "npm sent no PUT to the local registry").not.toBeNull();
  return lastPut!["dist-tags"] ?? {};
}

describe("#1184: npm publish tag", () => {
  it("1184: a bare npm publish tags next, not latest", async () => {
    const tags = await publishTags();
    expect(Object.keys(tags)).toEqual(["next"]);
  }, 120_000);

  it("1184: an explicit --tag still wins (pre-releases)", async () => {
    const tags = await publishTags(["--tag", "beta"]);
    expect(Object.keys(tags)).toEqual(["beta"]);
  }, 120_000);
});
